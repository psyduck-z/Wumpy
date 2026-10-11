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
  const clickedFirst = steps.slice(0, firstType).some((s) => s.kind === 'click')
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
  if (!frame) {
    return {
      ran: [],
      refused:
        'Nothing has been looked at yet. Take a screenshot first - the coordinates are ' +
        'pixels in that picture, so without one there is nothing to aim at.'
    }
  }
  if (plan.steps.length === 0) {
    return { ran: [], refused: 'No steps that could be understood.' }
  }

  const unaimed = typingIsAimed(plan.steps)
  if (unaimed) return { ran: [], refused: unaimed }

  /* Checked before anything runs, so a plan that would wander off the screen
     half way through does not leave the first half done. */
  for (const step of plan.steps) {
    if ((step.kind === 'click' || step.kind === 'move') && !onShot(frame, step.x, step.y)) {
      return {
        ran: [],
        refused:
          `${step.x}, ${step.y} is outside the screenshot ` +
          `(${frame.imageWidth} by ${frame.imageHeight}). Look again and use what you see.`
      }
    }
  }

  const ran: StepResult[] = []
  for (const step of plan.steps) {
    const label = describe(step)
    const reply = await oneStep(step, frame, panel, send)
    const ok = / ok\b/.test(reply) || reply === 'waited'
    ran.push({ step: label, ok, detail: reply })
    log(`[do] ${label} -> ${reply}`)
    if (!ok) break
    if (step.kind !== 'wait') await wait(SETTLE_MS)
  }
  return { ran, refused: null }
}

async function oneStep(
  step: Step,
  frame: ReturnType<typeof lastShot> & object,
  panel: BrowserWindow | null,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<string> {
  switch (step.kind) {
    case 'wait':
      await wait(step.ms)
      return 'waited'
    case 'move': {
      const at = toScreen(frame, step.x, step.y)
      return send(`MOVE ${at.x} ${at.y}`)
    }
    case 'click': {
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
  }
}
