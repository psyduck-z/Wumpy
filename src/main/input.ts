import { clipboard, type BrowserWindow } from 'electron'
import { log } from './log'
import { lastShot } from './screen'
import {
  describe,
  HIDDEN,
  isSecretField,
  onShot,
  toScreen,
  type Plan,
  type Step
} from '@shared/steps'
import { interference, parseGuard, rebase, windowMoved, type Guard } from '@shared/guard'
import { aimNote, remember, repeats, type Aim } from '@shared/aim'

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
 * The helper's way of saying a command worked: the verb, then " ok".
 *
 * Named rather than written twice, because it is a word boundary escape and
 * those keep getting eaten in transit - a `\b` that arrives as a literal
 * backspace byte compiles, matches nothing, and is invisible in an editor.
 * check-controlchars catches it; one copy is one chance to be caught.
 */
const OK = / ok\b/

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
  const firstType = steps.findIndex(
    (s) => s.kind === 'type' || s.kind === 'key' || s.kind === 'paste'
  )
  if (firstType === -1) return null
  /*
   * A NAME counts as aim. A coordinate does not, and that changed because of
   * what a coordinate turned out to be worth.
   *
   * The log of one attempt at "compose an email to Stanley" is ten rounds of
   * `click 600,380` / `type "Stanley"` / `key enter`, at ten nudged
   * coordinates, each reporting ok. The clicks missed the recipient box, so
   * the letters went to whatever had the keyboard - and Gmail reads a letter
   * on an unfocused page as a shortcut, which is where the user's three
   * empty compose windows came from. "It composed three things, didn't put
   * anything inside the sender."
   *
   * A click says a point was pressed. It says nothing about what is now
   * listening to the keyboard. `press`, `focus` and `fill` are lookups
   * against the accessibility tree, they report which control they chose,
   * and `fill` reads the box back afterwards - so those are the ones allowed
   * to be followed by typing.
   */
  const aimed = steps
    .slice(0, firstType)
    .some((s) => s.kind === 'press' || s.kind === 'fill')
  if (aimed) return null
  const clicked = steps.slice(0, firstType).some((s) => s.kind === 'click')
  return clicked
    ? 'This types after a click at a coordinate, which is an estimate off a scaled ' +
        'screenshot. A click lands a point; it does not tell anyone what now holds the ' +
        'keyboard, and when it misses, the characters go wherever the keyboard happens ' +
        'to be - in a web app, where single letters are shortcuts, that is how three ' +
        'empty compose windows got opened and no recipient got typed. Name the box ' +
        'instead: `fill "To recipients" stanley@example.com` puts the text in and reads ' +
        'it back to prove it, and `focus "<name>"` puts the cursor there.'
    : 'This types without aiming at anything first, and typed characters go to ' +
        'whatever window currently holds the keyboard - which is probably not the ' +
        'one you were looking at. Name the box with `fill` or `focus` first.'
}

/**
 * Where coordinate clicks have landed lately, so a loop can be seen.
 *
 * Module-level on purpose: the retries in the log were in ten SEPARATE plans,
 * one per turn, so anything scoped to a plan would have seen one click each
 * time and noticed nothing.
 */
let aimHistory: Aim[] = []

/** For the checks, which must not inherit a previous case's clicks. */
export function forgetAim(): void {
  aimHistory = []
}

export interface StepResult {
  step: string
  ok: boolean
  detail: string
}

export interface PlanResult {
  ran: StepResult[]
  /**
   * The window the plan reached past Wumpy to work in, when the panel was
   * the one in front. Null when the foreground window was the target
   * already, which is the case the model would assume anyway.
   */
  acting?: string | null
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

/**
 * Asks the helper how things stand. The reading and the judging are pure and
 * live in @shared/guard, so both can be driven by a check instead of by a
 * subprocess - which for a pair of regexes is the difference between a test
 * and a comment.
 */
async function readGuard(
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<Guard | null> {
  return parseGuard(await send('GUARD', 2500))
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
): Promise<{
  elements: Array<{ name: string; role: string; x: number; y: number }>
  window: string
  /** How many usable controls the window has, not just how many are listed. */
  total: number
}> {
  const reply = await send(`ELEMENTS ${limit}${filter ? ' ' + filter : ''}`, 8000)
  const at = reply.indexOf('[')
  /*
   * Which window they came from, so the list can say. The helper reports it
   * base64-encoded like every other title on this protocol; an older one
   * reports nothing, and an empty string is handled by the caller.
   */
  let window = ''
  const encoded = /window=(\S*)/.exec(reply)?.[1]
  if (encoded) {
    try {
      window = Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      /* an undecodable title is not worth failing a capture over */
    }
  }
  const total = Number(/total=(\d+)/.exec(reply)?.[1] ?? 0)
  if (!reply.startsWith('ELEMENTS ok') || at < 0) return { elements: [], window, total }
  try {
    return { elements: JSON.parse(reply.slice(at)), window, total }
  } catch {
    return { elements: [], window, total }
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
  let before = await readGuard(send)
  const startedAt = Date.now()
  /*
   * Which window the plan is working in, said once at the start.
   *
   * It is usually NOT the one in front. The user summons the panel, types
   * into it, and the panel has the keyboard when the plan runs - so a step
   * that looks things up by name has to reach past Wumpy to the window
   * behind it. That was invisible until a log showed a plan pressing a
   * control inside Wumpy's own card, and it belongs in the report.
   */
  const acting = before?.own && before.target ? before.target : null

  const ran: StepResult[] = []
  let stopped: string | null = null
  for (const step of plan.steps) {
    /*
     * Checked before each step rather than after, so the step that would
     * have gone astray is the one that does not happen.
     */
    let moved: string | null = null
    if (before && ran.length > 0) {
      const now = await readGuard(send)
      const why = now ? interference(before, now, Date.now() - startedAt) : null
      if (why) {
        stopped = why
        log(`[do] stopped: ${why}`)
        break
      }
      /*
       * The window changed and the user did nothing, so it was us - almost
       * always the plan's own first click activating the window it clicked
       * in. This used to end the plan and tell the model the user had come
       * back; now it is noted and the baseline moves on.
       */
      if (now) {
        moved = windowMoved(before, now)
        if (moved) log(`[do] ${moved} (ours, carrying on)`)
        before = rebase(before, now)
      }
    }

    /* A click at a point that has been clicked and clicked already. */
    if (step.kind === 'click' && frame) {
      const at = toScreen(frame, step.x, step.y)
      const verdict = aimNote(repeats(aimHistory, at.x, at.y, Date.now()))
      if (verdict.refuse) {
        stopped = verdict.note
        log(`[do] refused a repeated click at ${at.x},${at.y}`)
        break
      }
      aimHistory = remember(aimHistory, { x: at.x, y: at.y, at: Date.now() }, Date.now())
      if (verdict.note) moved = moved ? `${moved}; ${verdict.note}` : verdict.note
    }

    const label = describe(step)
    const reply = await oneStep(step, frame, panel, send)
    const ok = OK.test(reply) || reply === 'waited'
    ran.push({ step: label, ok, detail: moved ? `${reply} - ${moved}` : reply })
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
        'Look at the screen again before trying anything else.',
      acting
    }
  }
  return { ran, refused: null, stopped: null, acting }
}

/**
 * Puts text in through the clipboard, and puts the clipboard back.
 *
 * Shared by `paste` and `fill`, because the borrowing is the delicate part
 * and two copies of it would be two places for the restore to go missing.
 *
 * Typing is one pair of SendInput events per character - a thousand of them
 * for an email body, arriving faster than any human types, which a web editor
 * that debounces its input handler quietly drops some of. A paste lands whole
 * and carries newlines, which a line-based block cannot express any other way.
 *
 * What was in the clipboard goes back afterwards. Text can be put back
 * exactly; an image cannot be read as text and so cannot be restored, and
 * that is said in the reply rather than passed over - it is the user's
 * clipboard and they are entitled to know it changed.
 */
async function pasteText(
  text: string,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<{ ok: boolean; note: string; reply: string }> {
  const hadText = await clipboard.readText()
  /*
   * Electron 44's clipboard is the promise-based API and has no
   * availableFormats, so "it held something that is not text" is asked as a
   * question about the one format that actually turns up: an image, from a
   * snip. Asked only when there is no text to restore, because text is the
   * case that can be put back.
   */
  const hadImage = !hadText && (await clipboard.has('image/png').catch(() => false))
  await clipboard.writeText(text)
  const reply = await send('KEY ctrl+v', 6000)
  /* After the paste, or the restore wins the race with it. */
  await wait(250)
  if (hadText) await clipboard.writeText(hadText)
  return {
    ok: OK.test(reply),
    reply,
    note: hadText
      ? 'clipboard=restored'
      : hadImage
        ? 'clipboard=REPLACED (it held an image, which cannot be put back)'
        : 'clipboard=was-empty'
  }
}

/**
 * What a named control says right now, decoded.
 *
 * Shared by `read` and by `fill`'s proof. `text` is null when the helper
 * could not answer, and then `raw` is its own words - a failure to read is
 * not the same as a box that is empty, and a fill must never report success
 * because it could not see.
 */
async function readValue(
  name: string,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<{ text: string | null; via: string; exact: boolean; raw: string }> {
  const raw = await send(`VALUE ${Buffer.from(name, 'utf8').toString('base64')}`, 6000)
  const encoded = /text=(\S*)/.exec(raw)?.[1]
  const via = /via=(\S+)/.exec(raw)?.[1] ?? '?'
  /*
   * Whether this is the control that was chosen or merely another one with
   * the same name. A page holds forty things called "Select", and reading a
   * different one proves nothing about the one that was typed into. Absent
   * from an older helper, where it is treated as unknown rather than wrong.
   */
  const exact = !/matched=name-only/.test(raw)
  if (!raw.startsWith('VALUE ok') || encoded === undefined) return { text: null, via, exact, raw }
  try {
    return { text: Buffer.from(encoded, 'base64').toString('utf8'), via, exact, raw }
  } catch {
    return { text: null, via, exact, raw }
  }
}

/**
 * FOCUS, and when the box will not take the keyboard, one click at it.
 *
 * The helper does the parts only it can do: it brings the window to the
 * front, because characters follow the foreground window and not the UI
 * Automation focus, and it tries the editable element inside a wrapper like
 * Gmail's recipient ComboBox. If it still cannot hand over the caret, what
 * is left is what a person does - click the box - and the rectangle to click
 * is in the reply, measured by UI Automation rather than estimated off a
 * scaled screenshot.
 *
 * ONCE. The Gmail log is six steps that each repeat the one before, and a
 * recovery that can run twice is how that happens. The click goes through
 * the panel's mouse-transparency for the same reason every other click does:
 * the panel sits over the right-hand side of the screen, which is exactly
 * where a compose window's To field is.
 */
async function focusNamed(
  name: string,
  panel: BrowserWindow | null,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<string> {
  const named = Buffer.from(name, 'utf8').toString('base64')
  const first = await send(`FOCUS ${named}`, 6000)
  const at = /\bat=(-?\d+),(-?\d+)/.exec(first)
  if (!/did-not-take-keyboard/.test(first) || !at) return first

  const clicked = await throughThePanel(panel, () => send(`CLICK ${at[1]} ${at[2]}`))
  if (!OK.test(clicked)) return first
  /* Long enough for the click to have been handled and focus to have moved. */
  await wait(150)
  const again = await send(`FOCUS ${named}`, 6000)
  return `${again} (after clicking it at ${at[1]},${at[2]})`
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
      /* A focus gets the click recovery too, because a plan that focuses
         and then types has exactly the same problem as a fill. */
      return step.focusOnly
        ? focusNamed(step.name, panel, send)
        : send(`PRESS ${Buffer.from(step.name, 'utf8').toString('base64')}`, 6000)
    case 'read': {
      /*
       * The reply carries the text base64-encoded, and it is decoded here
       * so that what comes back to the model is the content rather than a
       * blob it has to decode in its head. This is the cheap way to look:
       * a screenshot is about 1,100 tokens of a free tier and a picture to
       * interpret, where this is the field's own value.
       */
      const back = await readValue(step.name, send)
      if (back.text === null) return back.raw
      return `VALUE ok via=${back.via} it says ${JSON.stringify(back.text)}`
    }
    case 'fill': {
      /*
       * Find the box, put the cursor in it, replace what is there, and read
       * it back. The reading back is the point.
       *
       * Every piece of this existed and the model never assembled it: the
       * log shows `click`, `type`, `enter`, ten times, with no `focus` and
       * no `read` anywhere in it. A verb that does the whole thing cannot be
       * half-done, and a verb that fails when the box is still empty cannot
       * be mistaken for success - which is what ten "CLICK ok / TYPE ok"
       * pairs were.
       */
      /* Whether the value belongs in the report at all. See isSecretField. */
      const secret = isSecretField(step.name)
      const focus = await focusNamed(step.name, panel, send)
      /*
       * The box would not take the caret even after its window was brought
       * forward and it was clicked. Three things have been tried, so the
       * instruction is to stop rather than to try again: the log that
       * started this is the same fill repeated six times.
       */
      if (/did-not-take-keyboard/.test(focus)) {
        return (
          `FILL FAILED ${JSON.stringify(step.name)} would not take the keyboard, so nothing was ` +
          `typed. (${focus.trim()}) Its window was brought to the front and it was clicked, and ` +
          'it still does not hold the caret. Do not try this box again - look at the screen, and ' +
          'either name a different one or ask the user to put the cursor in it.'
        )
      }
      if (!OK.test(focus)) return `FILL FAILED could not put the cursor in ${JSON.stringify(step.name)}: ${focus}`
      /*
       * Did the box actually take the keyboard? A newer helper answers;
       * an older one does not report it at all, and absence is not a no.
       *
       * This is the check that stops the damage rather than noticing it
       * afterwards. Characters sent at a box that does not have the keyboard
       * do not vanish - they go to whatever does, and in a web app single
       * letters are shortcuts.
       */
      if (/focused=no\b/.test(focus)) {
        return (
          `FILL FAILED ${JSON.stringify(step.name)} did not take the keyboard, so nothing was typed. ` +
          `(${focus.trim()}) Something else has it - look at the screen and press the window ` +
          'you mean first.'
        )
      }
      /*
       * And is it a box at all? Asked before the select-all, not after.
       *
       * This step presses ctrl+a and then pastes over the selection, which
       * is exactly right in a text field and destructive anywhere else: aim
       * it at a message list and ctrl+a selects every message; aim it at an
       * editor nobody meant to touch and the paste replaces the document.
       * The reply already says which control was chosen, so the role is
       * checked rather than assumed - and it is checked even against the
       * older helper, which reports a role but not whether focus landed.
       */
      const role = /role=(\S+)/.exec(focus)?.[1] ?? ''
      if (role && !/^(Edit|ComboBox|Document)$/i.test(role)) {
        return (
          `FILL FAILED ${JSON.stringify(step.name)} is a ${role}, not a box text goes into, ` +
          'so nothing was selected or typed. Name the field itself, or press it and look again.'
        )
      }
      /* Select what is there, so the text replaces rather than joins it. */
      const selected = await send('KEY ctrl+a', 6000)
      if (!OK.test(selected)) return `FILL FAILED could not select the contents: ${selected}`
      const put = await pasteText(step.text, send)
      if (!put.ok) return `FILL FAILED ${put.reply} ${put.note}`
      /* Long enough for a web editor to have run its input handler. */
      await wait(250)
      const back = await readValue(step.name, send)
      if (back.text === null) {
        return `FILL sent ok chars=${step.text.length} ${put.note} - but the box could not be read back (${back.raw.trim()}), so this is unproven`
      }
      const wanted = step.text.trim()
      const got = back.text.trim()
      if (got.includes(wanted) || (wanted.length > 40 && got.startsWith(wanted.slice(0, 40)))) {
        /* `via` and the warning are in the success line on purpose: a read
           that came from a control's NAME rather than its value, or from a
           different control with the same name, is weaker evidence than one
           that came from the box itself, and the difference should not be
           invisible. */
        const weak = back.exact ? '' : ' (warning: read from another control with the same name)'
        /*
         * A password box is checked the same way and reported differently.
         * The read-back goes into the report, the report goes into the
         * transcript and the log, and "it worked" is the whole of what
         * anyone needs to know about a field called Password.
         */
        const shown = secret ? HIDDEN : JSON.stringify(back.text)
        return `FILL ok ${JSON.stringify(step.name)} now says ${shown} (via ${back.via})${weak} ${put.note}`
      }
      if (secret) {
        return (
          `FILL FAILED the text did not land in ${JSON.stringify(step.name)} (read via ${back.via}). ` +
          'The characters went somewhere else. Do not repeat this step blindly - look at ' +
          'the screen and find the right box by name. The value is not repeated here.'
        )
      }
      return (
        `FILL FAILED the text did not land: ${JSON.stringify(step.name)} says ` +
        `${JSON.stringify(back.text)} (via ${back.via}), not ${JSON.stringify(step.text)}. ` +
        'The characters went somewhere else. Do not repeat this step blindly - look at ' +
        'the screen and find the right box by name.'
      )
    }
    case 'paste': {
      const put = await pasteText(step.text, send)
      return put.ok
        ? `PASTE ok chars=${step.text.length} ${put.note}`
        : `PASTE FAILED ${put.reply} ${put.note}`
    }
    case 'reveal':
      return send(`REVEAL ${Buffer.from(step.name, 'utf8').toString('base64')}`, 6000)
    case 'scroll': {
      /*
       * A wheel event goes to whatever is under the pointer, so a plan that
       * names no point scrolls wherever the pointer already is - which is
       * usually what was meant and avoids inventing a coordinate. A named
       * point is in screenshot pixels like every other coordinate here.
       */
      let at = { x: -1, y: -1 }
      if (step.x >= 0) {
        if (!frame) return 'SCROLL FAILED no-screenshot'
        at = toScreen(frame, step.x, step.y)
      } else {
        const where = await readGuard(send)
        if (!where) return 'SCROLL FAILED cannot-find-the-pointer'
        at = { x: where.cursorX, y: where.cursorY }
      }
      return throughThePanel(panel, () => send(`SCROLL ${at.x} ${at.y} ${step.notches}`))
    }
  }
}
