import type { BrowserWindow } from 'electron'
import { log } from './log'
import { lastShot } from './screen'
import { describe, onShot, toScreen, type Plan, type Step } from '@shared/steps'

/**
 * Driving the desktop: the clicks and keystrokes the model asked for.
 *
 * Wumpy could already look at the screen and could not touch it, so it
 * refused to open a Gmail tab that was open in front of it. The user's
 * answer was that they were giving it permission, and they are the only
 * person on this machine. This is the touching.
 *
 * Three rules hold it together, and all three are here rather than in the
 * prompt, because a prompt is a request and this is the thing that acts:
 *
 *   1. Nothing happens without a recent screenshot. The coordinates mean
 *      nothing on their own - they are pixels in an image - so with no image
 *      there is nothing to translate and the plan is refused rather than
 *      aimed at a guess.
 *   2. Every point must be inside that image. A coordinate off the edge is a
 *      model that has lost track of the screen, not an intention.
 *   3. Every step says what it did. A plan that half worked is the normal
 *      case - a page was still loading, a menu did not open - and the model
 *      cannot correct for it unless it is told which step stopped working.
 */

/** Between steps, so a click has landed before the next one is sent. */
const SETTLE_MS = 180

/**
 * Typing goes to whatever holds the keyboard, which is not where you looked.
 *
 * Found by typing into Wumpy's own composer as a test: the helper reported
 * `TYPE ok chars=16`, the composer stayed empty, and all sixteen characters
 * went to the Windows Terminal that happened to be the foreground window.
 * SendInput does not aim. It posts to whatever has focus at that instant.
 *
 * It is the same split that cost six attempts at autofocus - the caret can
 * be in one place while the keyboard belongs to another - and it is far
 * worse here, because the keystrokes are an email address rather than a
 * missed hotkey, and they land in a stranger's window silently.
 *
 * So a plan may not type until something in it has clicked. A click moves
 * the real foreground, the way the user's own click would; without one there
 * is no evidence about where the characters will go, and the honest thing is
 * to refuse rather than to scatter them.
 */
function typingIsAimed(steps: readonly Step[]): string | null {
  const firstType = steps.findIndex((s) => s.kind === 'type' || s.kind === 'key')
  if (firstType === -1) return null
  const clickedFirst = steps
    .slice(0, firstType)
    .some((s) => s.kind === 'click' || s.kind === 'press')
  if (clickedFirst) return null
  return (
    'This types without clicking anything first, and typed characters go to ' +
    'whatever window currently holds the keyboard - which is probably not the ' +
    'one you were looking at. Click the field you mean, then type.'
  )
}

export interface StepResult {
  step: string
  ok: boolean
  detail: string
}

export interface PlanResult {
  ran: StepResult[]
  /** Set when nothing ran at all, with the reason. */
  refused: string | null
  /**
   * Set when the plan was abandoned part-way because the machine changed
   * under it - the window went, the mouse moved, somebody typed.
   */
  stopped: string | null
}

/**
 * The panel is on top of everything, including whatever is being clicked.
 *
 * It is excluded from its own screenshots, so the model never sees it and
 * will happily aim at a point the panel is covering - and that click would
 * land on Wumpy. setIgnoreMouseEvents lets the click fall through to the
 * window underneath, which is what the user would get if they clicked there
 * themselves.
 *
 * Not hide(): hiding means showing again, and showing again is the autofocus
 * problem that took six attempts. This changes nothing about what is on
 * screen.
 */
async function throughThePanel<T>(panel: BrowserWindow | null, run: () => Promise<T>): Promise<T> {
  const live = panel && !panel.isDestroyed() ? panel : null
  live?.setIgnoreMouseEvents(true)
  try {
    return await run()
  } finally {
    live?.setIgnoreMouseEvents(false)
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Who has the keyboard, where the pointer is, and whether a person is typing. */
interface Guard {
  hwnd: string
  title: string
  cursorX: number
  cursorY: number
  /** Milliseconds since the user's own last keypress, or -1 for never. */
  keyMs: number
}

async function readGuard(
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<Guard | null> {
  const reply = await send('GUARD', 2500)
  const m = /^GUARD ok hwnd=(-?\d+) cursor=(-?\d+),(-?\d+) keyms=(-?\d+) title=(\S*)/.exec(reply)
  if (!m) return null
  let title = ''
  try {
    title = Buffer.from(m[5], 'base64').toString('utf8')
  } catch {
    /* a title we cannot decode is not a reason to refuse to act */
  }
  return { hwnd: m[1], title, cursorX: Number(m[2]), cursorY: Number(m[3]), keyMs: Number(m[4]) }
}

/**
 * How far the pointer may drift before it counts as someone using it.
 *
 * A click puts the pointer back where it found it, so between steps it
 * should not move at all. A few pixels is a desk knock or a trackpad
 * resting on a thumb; forty is a hand.
 */
const POINTER_SLACK = 40

/**
 * Has somebody started using the computer while the plan was running?
 *
 * Asked for in plain terms: "if it detects that it's on the wrong page or
 * like you're interfering make it stop wait or something... Otherwise, I
 * might like mess up some stuff."
 *
 * Stop, not wait. Waiting assumes the interruption is momentary and that
 * the screen will come back to how it was, and neither is knowable from
 * here - the user may have alt-tabbed away for ten minutes, or navigated
 * somewhere the remaining clicks mean something entirely different. The
 * steps that have not run are reported as skipped, the model is told what
 * changed, and it can look again. That is recoverable; typing half an email
 * address into whatever window arrived in the meantime is not.
 */
function interference(before: Guard, now: Guard, elapsedMs: number): string | null {
  if (now.hwnd !== before.hwnd) {
    const went = now.title.trim()
    return `the foreground window changed${went ? ` to "${went}"` : ''}`
  }
  /* keyMs counts back from now, so a value under the plan's age is a
     keystroke made since it started - and ours are never counted. */
  if (now.keyMs >= 0 && now.keyMs < elapsedMs) return 'you typed something'
  const moved = Math.hypot(now.cursorX - before.cursorX, now.cursorY - before.cursorY)
  if (moved > POINTER_SLACK) return 'the mouse moved'
  return null
}

/**
 * What is on screen and what it is called, from the accessibility tree.
 *
 * This is the actual fix for "it keeps on missing the TO fillin box, and
 * keeps clicking the same place every time". A model estimating a
 * coordinate off a 1568px screenshot is wrong the same way every time it
 * looks at the same picture, so the loop cannot break itself. Handed a list
 * of names with real rectangles, it stops estimating: a miss becomes a
 * wrong choice, which is the kind of mistake that can be corrected.
 *
 * Read from the FOREGROUND window, which is what the user is looking at and
 * what a click would land on. Returns an empty list rather than failing: an
 * app with no accessibility tree is a reason to fall back to coordinates,
 * not a reason for the whole plan to stop.
 */
export async function visibleElements(
  send: (command: string, timeoutMs?: number) => Promise<string>,
  limit = 60,
  filter = ''
): Promise<Array<{ name: string; role: string; x: number; y: number }>> {
  const reply = await send(`ELEMENTS ${limit}${filter ? ' ' + filter : ''}`, 8000)
  const at = reply.indexOf('[')
  if (!reply.startsWith('ELEMENTS ok') || at < 0) return []
  try {
    return JSON.parse(reply.slice(at))
  } catch {
    return []
  }
}

/**
 * Runs a plan, step by step, stopping at the first failure.
 *
 * Stopping rather than pressing on: the steps are a sequence - click the
 * field, then type into it - so once one has not happened, everything after
 * it is being done somewhere unintended. Typing an email address into
 * whatever had focus because the click missed is the exact shape of damage
 * worth refusing.
 */
export async function runPlan(
  plan: Plan,
  panel: BrowserWindow | null,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<PlanResult> {
  const frame = lastShot()
  /*
   * A plan made entirely of names needs no picture: UI Automation finds the
   * control wherever it is. Only coordinates need a frame to be measured
   * against, so only they require one.
   */
  const needsFrame = plan.steps.some((s) => s.kind === 'click' || s.kind === 'move')
  if (!frame && needsFrame) {
    return {
      ran: [],
      stopped: null,
      refused:
        'Nothing has been looked at yet. Take a screenshot first - the coordinates are ' +
        'pixels in that picture, so without one there is nothing to aim at.'
    }
  }
  if (plan.steps.length === 0) {
    return { ran: [], stopped: null, refused: 'No steps that could be understood.' }
  }

  const unaimed = typingIsAimed(plan.steps)
  if (unaimed) return { ran: [], stopped: null, refused: unaimed }

  /* Checked before anything runs, so a plan that would wander off the screen
     half way through does not leave the first half done. */
  for (const step of plan.steps) {
    if ((step.kind === 'click' || step.kind === 'move') && frame && !onShot(frame, step.x, step.y)) {
      return {
        ran: [],
        stopped: null,
        refused:
          `${step.x}, ${step.y} is outside the screenshot ` +
          `(${frame.imageWidth} by ${frame.imageHeight}). Look again and use what you see.`
      }
    }
  }

  /*
   * What the machine looked like before any of this, so a change can be
   * noticed. Null when the helper cannot answer, in which case the plan
   * still runs: a missing guard is a reason to watch less closely, not a
   * reason to refuse something the user asked for.
   */
  const before = await readGuard(send)
  const startedAt = Date.now()

  const ran: StepResult[] = []
  let stopped: string | null = null
  for (const step of plan.steps) {
    /*
     * Checked before each step rather than after, so the step that would
     * have gone astray is the one that does not happen.
     */
    if (before && ran.length > 0) {
      const now = await readGuard(send)
      const why = now ? interference(before, now, Date.now() - startedAt) : null
      if (why) {
        stopped = why
        log(`[do] stopped: ${why}`)
        break
      }
    }

    const label = describe(step)
    const reply = await oneStep(step, frame, panel, send)
    const ok = / ok\b/.test(reply) || reply === 'waited'
    ran.push({ step: label, ok, detail: reply })
    log(`[do] ${label} -> ${reply}`)
    if (!ok) break
    if (step.kind !== 'wait') await wait(SETTLE_MS)
  }

  if (stopped) {
    const left = plan.steps.length - ran.length
    return {
      ran,
      refused: null,
      stopped:
        `Stopped after ${ran.length} of ${plan.steps.length} steps because ${stopped}. ` +
        `${left} step${left === 1 ? '' : 's'} did not run. ` +
        'Look at the screen again before trying anything else.'
    }
  }
  return { ran, refused: null, stopped: null }
}

async function oneStep(
  step: Step,
  frame: ReturnType<typeof lastShot>,
  panel: BrowserWindow | null,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<string> {
  switch (step.kind) {
    case 'wait':
      await wait(step.ms)
      return 'waited'
    case 'move': {
      /* Unreachable without a frame: runPlan refuses a coordinate plan
         before it gets here. Narrowed rather than asserted, so a future
         caller that skips that check fails loudly instead of at 0,0. */
      if (!frame) return 'MOVE FAILED no-screenshot'
      const at = toScreen(frame, step.x, step.y)
      return send(`MOVE ${at.x} ${at.y}`)
    }
    case 'click': {
      if (!frame) return 'CLICK FAILED no-screenshot'
      const at = toScreen(frame, step.x, step.y)
      return throughThePanel(panel, () =>
        send(`CLICK ${at.x} ${at.y} ${step.button} ${step.times}`)
      )
    }
    case 'type':
      /* Base64 over a line protocol: a newline in the text would otherwise
         end the command and leave the rest to be read as another one. */
      return send(`TYPE ${Buffer.from(step.text, 'utf8').toString('base64')}`)
    case 'key':
      return send(`KEY ${step.chord}`)
    case 'press':
      /*
       * No coordinate and no pointer. UI Automation presses the control
       * itself, so nothing is taken from the user's hand - which was the
       * request - and nothing depends on an estimate off a scaled image,
       * which was the bug. Base64 because controls are named things like
       * "To recipients, Press Delete to remove".
       */
      return send(
        `${step.focusOnly ? 'FOCUS' : 'PRESS'} ` +
          Buffer.from(step.name, 'utf8').toString('base64'),
        6000
      )
  }
}
