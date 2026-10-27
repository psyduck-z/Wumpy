import { clipboard, type BrowserWindow } from 'electron'
import { log } from './log'
import { lastShot } from './screen'
import {
  caretVerdict,
  describe,
  HIDDEN,
  isSecretField,
  onShot,
  pickingRecipient,
  toScreen,
  type Focused,
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

/** Long enough for a click to have been handled and the focus to have moved. */
const FOCUS_SETTLE_MS = 150

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
   *
   * AND `caret`, WHICH IS A CLICK THAT ASKS THE SAME QUESTION AFTERWARDS.
   *
   * The ban above is a ban on typing into the unknown, not a ban on clicking
   * - and it had the side effect of making a document impossible to edit,
   * because a word in a paragraph has no name to aim at. `caret` clicks and
   * then reads the focused element back: if a text surface has the keyboard
   * it says which one and what is selected in it, and if anything else does
   * it FAILS, which stops the plan before the first character. That is the
   * evidence a bare click never produced, so typing after it is allowed.
   */
  const aimed = steps
    .slice(0, firstType)
    .some((s) => s.kind === 'press' || s.kind === 'fill' || s.kind === 'caret')
  if (aimed) return null
  const clicked = steps.slice(0, firstType).some((s) => s.kind === 'click')
  return clicked
    ? 'This types after a click at a coordinate, which is an estimate off a scaled ' +
        'screenshot. A click lands a point; it does not tell anyone what now holds the ' +
        'keyboard, and when it misses, the characters go wherever the keyboard happens ' +
        'to be - in a web app, where single letters are shortcuts, that is how three ' +
        'empty compose windows got opened and no recipient got typed. Name the box ' +
        'instead: `fill "To recipients" stanley@example.com` puts the text in and reads ' +
        'it back to prove it, and `focus "<name>"` puts the cursor there. For text with ' +
        'no box around it - a document, an editor, a paragraph you are correcting - use ' +
        '`caret X Y` instead of `click`, or `caret X Y word` to select the word there: ' +
        'it clicks, then says what has the keyboard and what is selected, and fails if ' +
        'the answer is not text.'
    : 'This types without aiming at anything first, and typed characters go to ' +
        'whatever window currently holds the keyboard - which is probably not the ' +
        'one you were looking at. Name the box with `fill` or `focus` first, or put the ' +
        'cursor in prose with `caret X Y`.'
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
   * EVERY WAY OUT OF HERE IS WRITTEN DOWN, INCLUDING THE ONES THAT RUN
   * NOTHING.
   *
   * It did not used to be. A plan refused before its first step took one of
   * four early returns, none of which logged anything, so a turn where the
   * model proposed something and the app said no left wumpy.log looking
   * exactly like a turn where the model proposed nothing at all. Asked why a
   * document had not been corrected, the log for those three minutes held
   * three screenshots, nine finished turns and not one line about a plan -
   * and the refusals were the answer.
   */
  const refuse = (why: string): PlanResult => {
    log(`[do] refused before anything ran: ${why}`)
    return { ran: [], stopped: null, refused: why }
  }
  log(`[do] plan of ${plan.steps.length}: ${plan.steps.map(describe).join('; ')}`)
  /*
   * A plan made entirely of names needs no picture: UI Automation finds the
   * control wherever it is. Only coordinates need a frame to be measured
   * against, so only they require one.
   */
  const needsFrame = plan.steps.some(
    (s) => s.kind === 'click' || s.kind === 'move' || s.kind === 'caret'
  )
  if (!frame && needsFrame) {
    return refuse(
      'Nothing has been looked at yet. Take a screenshot first - the coordinates are ' +
        'pixels in that picture, so without one there is nothing to aim at.'
    )
  }
  if (plan.steps.length === 0) {
    return refuse('No steps that could be understood.')
  }

  const unaimed = typingIsAimed(plan.steps)
  if (unaimed) return refuse(unaimed)

  /* Checked before anything runs, so a plan that would wander off the screen
     half way through does not leave the first half done. */
  for (const step of plan.steps) {
    if (
      (step.kind === 'click' || step.kind === 'move' || step.kind === 'caret') &&
      frame &&
      !onShot(frame, step.x, step.y)
    ) {
      return refuse(
        `${step.x}, ${step.y} is outside the screenshot ` +
          `(${frame.imageWidth} by ${frame.imageHeight}). Look again and use what you see.`
      )
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

    /* A click at a point that has been clicked and clicked already. `caret`
       is a click too, and a caret put in the same wrong place four times is
       the same loop with a different verb. */
    if ((step.kind === 'click' || step.kind === 'caret') && frame) {
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
/* Control names go over a line protocol and are things like "To recipients,
   Press Delete to remove", so they travel base64. */
const named = (name: string): string => Buffer.from(name, 'utf8').toString('base64')

async function focusNamed(
  name: string,
  panel: BrowserWindow | null,
  send: (command: string, timeoutMs?: number) => Promise<string>
): Promise<string> {
  const first = await send(`FOCUS ${named(name)}`, 6000)
  const at = /\bat=(-?\d+),(-?\d+)/.exec(first)
  if (!/did-not-take-keyboard/.test(first) || !at) return first

  const clicked = await throughThePanel(panel, () => send(`CLICK ${at[1]} ${at[2]}`))
  if (!OK.test(clicked)) return first
  await wait(FOCUS_SETTLE_MS)
  const again = await send(`FOCUS ${named(name)}`, 6000)
  return `${again} (after clicking it at ${at[1]},${at[2]})`
}

/**
 * A FOCUSED line, read off the wire for the step that has to judge it.
 *
 * The protocol half only: which element, whether it is ours, whether it
 * takes text, and the selection - with the two strings decoded, since they
 * travel base64 like every other name on this pipe. What the answer MEANS is
 * caretVerdict, which is pure and tested.
 */
function readFocused(reply: string): Focused | null {
  if (!/^FOCUSED ok/.test(reply)) return null
  const decode = (key: string): string => {
    const raw = new RegExp(`${key}=(\\S*)`).exec(reply)?.[1] ?? ''
    try {
      return Buffer.from(raw, 'base64').toString('utf8')
    } catch {
      /* An undecodable name is not a reason to refuse an answer about the
         keyboard; the verdict handles a nameless control already. */
      return ''
    }
  }
  return {
    role: /role=(\S+)/.exec(reply)?.[1] ?? 'something',
    ours: /ours=yes/.test(reply),
    takes: /takes=(\S+)/.exec(reply)?.[1] ?? 'no',
    name: decode('name'),
    selected: decode('selected')
  }
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
    case 'caret': {
      /*
       * The same click, and then the question. Composed here rather than in
       * the helper because the helper already has both halves - a click and
       * a reader - and what makes this a different step is the judgement
       * between them, which belongs on the side that can explain itself to
       * a model.
       *
       * Two clicks take a word and three take a line, which is how Windows
       * has always said it and what every editor already implements.
       */
      if (!frame) return 'CARET FAILED no-screenshot'
      const at = toScreen(frame, step.x, step.y)
      const times = step.select === 'line' ? 3 : step.select === 'word' ? 2 : 1
      const clicked = await throughThePanel(panel, () =>
        send(`CLICK ${at.x} ${at.y} left ${times}`)
      )
      if (!OK.test(clicked)) return clicked
      await wait(FOCUS_SETTLE_MS)
      const reply = await send('FOCUSED', 6000)
      const got = readFocused(reply)
      if (!got) {
        return `CARET FAILED nothing could say what has the keyboard (${reply.split(' ').slice(0, 3).join(' ')}), so nothing was typed.`
      }
      return caretVerdict(got, step.select)
    }
    case 'type':
      /* Base64 over a line protocol: a newline in the text would otherwise
         end the command and leave the rest to be read as another one. */
      return send(`TYPE ${Buffer.from(step.text, 'utf8').toString('base64')}`)
    case 'key':
      /* The count rides on the same line, so forty backspaces are one
         command and one SendInput batch rather than forty of each. */
      return send(
        step.times && step.times > 1 ? `KEY ${step.chord} ${step.times}` : `KEY ${step.chord}`,
        8000
      )
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
       * And is it a box at all? Asked before anything is selected, not after.
       *
       * This step selects what is in the field and pastes over it, which is
       * exactly right in a text field and destructive anywhere else: aim it
       * at an editor nobody meant to touch and the paste replaces the
       * document. The reply already says which control was chosen, so the
       * role is checked rather than assumed - and it is checked even against
       * the older helper, which reports a role but not whether focus landed.
       */
      const role = /role=(\S+)/.exec(focus)?.[1] ?? ''
      if (role && !/^(Edit|ComboBox|Document)$/i.test(role)) {
        return (
          `FILL FAILED ${JSON.stringify(step.name)} is a ${role}, not a box text goes into, ` +
          'so nothing was selected or typed. Name the field itself, or press it and look again.'
        )
      }
      /*
       * EMPTYING A BOX THAT IS ALREADY EMPTY IS ALL RISK AND NO BENEFIT.
       *
       * The user, after reading back what their own run did: "it pressed
       * Control A, and when it pressed Control A, that's when it unselects
       * the to recipient... it didn't notice."
       *
       * ctrl+a is not a text-field key. It is an APPLICATION key that a web
       * app is free to take: in Gmail's message list it selects every
       * conversation, and anywhere a page handles it, the keystroke is gone
       * and whatever it did to the selection or the focus happened instead.
       * The field being empty is the common case - a fresh compose window,
       * an empty search box - and in that case the select does nothing
       * except give the page a chance to do something else.
       *
       * So: read first, and press nothing when there is nothing to replace.
       * The read is a UI Automation call, not a keystroke, so it cannot be
       * intercepted and costs no risk at all.
       */
      const before = await readValue(step.name, send)
      const held = before.text ?? ''
      /*
       * AND WHAT IS ALREADY IN THERE IS SOMEBODY'S, UNLESS THEY SAID SO.
       *
       * Reported: "it erased my entire signature (built different) and
       * replaced it with the content, but my signature is supposed to stay
       * there". One step did that - `fill "Message Body" HI` - and it did
       * exactly what fill is documented to do: find the box, empty it, put
       * the text in. The destruction was the default.
       *
       * It is the default no longer. `fill` into an empty box is the common
       * case and is untouched; `fill` into a box with writing in it stops
       * and says what is in there, and `replace` is the word that means
       * delete it. The model is told both in the same breath, so the cost
       * of the stricter default is one turn in the rare case and a
       * signature in the case that was reported.
       *
       * The preview matters as much as the refusal: "Built Different" in
       * the failure line is how the model works out that what it is about
       * to delete is a signature and not a stale value.
       */
      if (held.trim().length > 0 && !step.force) {
        const preview = secret
          ? HIDDEN
          : JSON.stringify(held.length > 80 ? `${held.slice(0, 80)}…` : held)
        return (
          `FILL REFUSED ${JSON.stringify(step.name)} is not empty - it holds ${held.length} ` +
          `character${held.length === 1 ? '' : 's'}: ${preview}. Nothing was typed and nothing ` +
          'was deleted. If that text should stay - a signature, a draft, a quoted reply - ' +
          `put the cursor in the box with \`focus ${JSON.stringify(step.name)}\` and \`type\` ` +
          'what you are adding, which inserts at the caret. If it really should all go, say ' +
          `\`replace ${JSON.stringify(step.name)} <text>\`, which is this step with the ` +
          'deleting asked for.'
        )
      }
      if (held.trim().length > 0) {
        /*
         * And when there IS something, delete it the way a person does.
         *
         * "I like to read the screen and see what's inside the box first,
         * if there's anything inside. Then maybe Control A works, I'm not
         * sure, but you know, just better backspace."
         *
         * Backspace is the right key for a reason worth writing down: it
         * does not need a selection to exist, so nothing between the read
         * and the paste depends on a state some page might have quietly
         * changed. The count comes from the read - one press per character
         * that is actually in the box - and they go in a single SendInput
         * batch, so a sentence costs one call rather than forty.
         *
         * ctrl+end first, because backspace deletes to the LEFT of the
         * caret and the caret may be anywhere. Both are text-editing keys
         * that belong to the control holding it.
         */
        const toEnd = await send('KEY ctrl+end', 6000)
        if (!OK.test(toEnd)) return `FILL FAILED could not reach the end of the box: ${toEnd}`
        /*
         * A few spare presses, because the value read and the characters in
         * the box are not always the same count - a date box shows
         * separators it does not report, a rich field can hold formatting.
         * Extra backspaces in an empty box do nothing.
         *
         * Over the cap, select instead: 400 keystrokes through a web
         * editor's handlers is slower than the thing it is clearing, and a
         * read is trimmed at 600 characters anyway, so beyond that the
         * count would be a guess.
         */
        const presses = held.length + 4
        const cleared =
          presses <= 400
            ? await send(`KEY backspace ${presses}`, 8000)
            : await send('KEY ctrl+shift+home', 6000)
        if (!OK.test(cleared)) return `FILL FAILED could not empty the box: ${cleared}`
        /*
         * Then look again, which is the half of this the user asked for
         * twice now. The box either is empty or it is not, and a read says
         * which - where "I pressed the keys that usually empty it" does
         * not. Not fatal on its own: the paste replaces a selection and
         * joins leftover text, so what this changes is that the report
         * tells the truth about which happened.
         */
        const after = await readValue(step.name, send)
        const left = (after.text ?? '').trim()
        if (left.length > 0 && left === held.trim()) {
          return (
            `FILL FAILED ${JSON.stringify(step.name)} would not empty - it still says ` +
            `${JSON.stringify(after.text)} after ${presses} backspaces, so nothing was pasted ` +
            'on top of it. Something is putting the text back, or the keys are going ' +
            'elsewhere. Look at the screen rather than repeating this.'
          )
        }
        /*
         * And check the box still has the caret before pasting into it.
         *
         * This is the user's own diagnosis kept as a guard rather than an
         * assumption: if emptying the field moved the keyboard somewhere
         * else, the paste lands there. Noticing costs one local call; not
         * noticing cost six turns and three empty compose windows.
         */
        const still = await send(`FOCUS ${named(step.name)}`, 6000)
        if (/did-not-take-keyboard/.test(still) || /focused=no\b/.test(still)) {
          return (
            `FILL FAILED emptying ${JSON.stringify(step.name)} moved the keyboard out of it, ` +
            `so nothing was pasted. (${still.trim()}) The box may be inside something that ` +
            'takes those keys for itself. Try a shorter name, or clear it another way.'
          )
        }
      }
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
        /* And, in a recipient box, that choosing between the matches it has
           just raised is not something to guess at. See pickingRecipient. */
        const picking = pickingRecipient(step.name, step.text)
        return (
          `FILL ok ${JSON.stringify(step.name)} now says ${shown} (via ${back.via})${weak} ` +
          `${put.note}${picking ? ` ${picking}` : ''}`
        )
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
