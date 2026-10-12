/**
 * Acting on the screen: the steps the model may propose, and nothing else.
 *
 * Asked for after a refusal the user did not accept: "My Gmail tab is
 * literally open. I'm giving it permission to do it... I asked it to navigate
 * to my Gmail tab, which is open right now, and click compose, and then send
 * to someone called Stanley."
 *
 * The refusal was honest at the time - Wumpy could look at the screen and
 * could not touch it - so the fix is the capability, not a prompt that tells
 * the model to claim one it lacks. This is the vocabulary for the touching.
 *
 * Coordinates are in the SCREENSHOT's pixels, not the screen's. The model
 * knows where things are because it just looked at an image, and that image
 * was scaled down on the way out; asking it to undo that scaling in its head
 * is asking for a click in the wrong place. Main translates, because main is
 * the only side that knows which display was photographed and by how much it
 * shrank.
 *
 * Pure and shared, so the whole grammar can be checked without a desktop.
 */

const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

export type Step =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right'; times: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; chord: string }
  | { kind: 'wait'; ms: number }
  /*
   * Pressing a control by its NAME rather than its pixel.
   *
   * The reason this exists: "it keeps on missing the TO fillin box, and
   * keeps clicking the same place every time... don't hardcode it." An
   * estimate off a scaled screenshot is wrong the same way every time the
   * model looks at the same picture, so a pixel loop cannot correct itself.
   * A name is a lookup, and a miss is a wrong choice the model can change.
   *
   * It also leaves the pointer alone, which was the other request.
   */
  | { kind: 'press'; name: string; focusOnly: boolean }
  /*
   * Reading a control back, which is how a plan checks its own work.
   *
   * Looking used to mean a screenshot: about 1,100 tokens of a free tier
   * that genuinely runs out, and a picture the model then has to interpret.
   * "Read the To box" is a string, and it answers the question the misses
   * were about directly rather than by inference.
   */
  | { kind: 'read'; name: string }
  /*
   * Bringing something below the fold into view.
   *
   * The elements list only reports what is on screen, so a Send button
   * under the window's edge did not exist as far as a plan was concerned -
   * and the only way to reach it was a wheel over a guessed coordinate.
   * UI Automation asks the container to scroll instead, and the pointer is
   * not touched.
   */
  | { kind: 'reveal'; name: string }
  /*
   * The wheel, for what UI Automation cannot scroll: a canvas, a map, a
   * custom list. Positive is down, because that is what "scroll down"
   * means. This one does borrow the pointer, like a coordinate click.
   */
  | { kind: 'scroll'; x: number; y: number; notches: number }
  /*
   * Putting text in through the clipboard instead of keystroke by keystroke.
   *
   * `type` is SendInput, which is one pair of events per character: an email
   * body is a thousand of them arriving faster than any human types, and a
   * web editor that debounces its input handler drops some. A paste is one
   * event, lands whole, and can carry newlines - which a line-based block
   * cannot otherwise express at all.
   *
   * The clipboard belongs to the user, so whatever was in it is put back
   * afterwards.
   */
  | { kind: 'paste'; text: string }
  /*
   * Putting text in a named box, and proving it landed. One step.
   *
   * The three steps it replaces were the whole failure. From the log of a
   * real attempt: `click 600,380`, `type "Stanley"`, `key enter` - ten times
   * over, at ten nudged coordinates, every one of them reporting ok. The
   * click missed the To field each time, so "Stanley" went to whatever had
   * the keyboard, and in Gmail an unfocused page reads a letter as a
   * shortcut: that is where the user's three empty compose windows came
   * from. The recipient box stayed empty and nothing in the app said so.
   *
   * fill is the same intention expressed once: find the box by name, put the
   * cursor in it, replace what is there, then READ IT BACK and fail if the
   * text is not in it. A step that cannot prove it worked reports that it
   * could not, which stops the plan instead of typing the next thing into
   * the void.
   */
  | { kind: 'fill'; name: string; text: string }

export interface Plan {
  /** The `# why` line, for the card. */
  reason: string
  steps: Step[]
  /** Lines that are not steps at all, so the card can say what was ignored. */
  problems: string[]
}

/**
 * A ceiling on one block, because a runaway plan is the failure mode here.
 *
 * Twelve is more than any real sequence - open a tab, click a field, type,
 * press enter is four - and small enough that a model which has started
 * generating clicks in a loop is stopped by the parser rather than by the
 * user watching their desktop being driven.
 */
export const MAX_STEPS = 12

/** Long enough for an address or a sentence; not a document. */
export const MAX_TYPE = 500

/**
 * A paste can be longer than typing, because it costs one event either way.
 *
 * Two thousand characters is a long email and a short document. The point of
 * the ceiling is that this is still a step in a plan the user is reading
 * before it happens, not a file write.
 */
export const MAX_PASTE = 2000

/** A pause the user can sit through. Anything longer is a hang. */
export const MAX_WAIT = 5000

/**
 * Notches in one scroll step.
 *
 * Ten is most of a page in a browser. A plan that wants further should say
 * so in a second step, so the guard gets a look in between - a scroll that
 * flies past what was being looked for is how a plan ends up acting on a
 * screen nobody has seen.
 */
export const MAX_SCROLL = 10

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n))
}

/**
 * Reads a plan, keeping what is valid and naming what is not.
 *
 * It never throws and never returns a step it could not fully understand. A
 * half-read `click` with one coordinate is dropped and reported, because a
 * click at a guessed coordinate is worse than no click.
 */
export function readPlan(raw: string): Plan {
  const reason: string[] = []
  const steps: Step[] = []
  const problems: string[] = []

  for (const line of raw.split(NL)) {
    const text = line.trim()
    if (!text) continue
    if (text.startsWith('#')) {
      reason.push(text.replace(/^#+\s*/, '').trim())
      continue
    }
    if (steps.length >= MAX_STEPS) {
      problems.push(`more than ${MAX_STEPS} steps; the rest were dropped`)
      break
    }

    const space = text.indexOf(' ')
    const verb = (space < 0 ? text : text.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : text.slice(space + 1).trim()

    if (verb === 'click' || verb === 'rightclick' || verb === 'doubleclick' || verb === 'move') {
      const pair = /^(-?\d+)[\s,]+(-?\d+)$/.exec(rest)
      if (!pair) {
        problems.push(`${verb} needs two numbers: ${text}`)
        continue
      }
      const x = Number(pair[1])
      const y = Number(pair[2])
      if (x < 0 || y < 0) {
        problems.push(`${verb} has a negative coordinate: ${text}`)
        continue
      }
      if (verb === 'move') steps.push({ kind: 'move', x, y })
      else
        steps.push({
          kind: 'click',
          x,
          y,
          button: verb === 'rightclick' ? 'right' : 'left',
          times: verb === 'doubleclick' ? 2 : 1
        })
      continue
    }

    if (verb === 'read' || verb === 'reveal') {
      const name = rest.replace(/^["']|["']$/g, '').trim()
      if (!name) {
        problems.push(`${verb} needs the name of something on screen: ${text}`)
        continue
      }
      if (name.length > MAX_TYPE) {
        problems.push(`${verb} name is absurdly long; dropped`)
        continue
      }
      steps.push(verb === 'read' ? { kind: 'read', name } : { kind: 'reveal', name })
      continue
    }

    if (verb === 'scroll') {
      /* "scroll 900 600 3" or "scroll down 3" - the second form scrolls
         wherever the pointer already is, which is what a model usually
         means and avoids inventing a coordinate for it. */
      const words = rest.split(/[\s,]+/).filter(Boolean)
      const direction = /^(up|down)$/i.exec(words[0] ?? '')
      if (direction) {
        const n = Number(words[1] ?? '3')
        if (!Number.isFinite(n) || n <= 0) {
          problems.push(`scroll needs a number of notches: ${text}`)
          continue
        }
        steps.push({
          kind: 'scroll',
          x: -1,
          y: -1,
          notches: clamp(Math.round(n), 1, MAX_SCROLL) * (direction[1].toLowerCase() === 'up' ? -1 : 1)
        })
        continue
      }
      const nums = words.map(Number)
      if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) {
        problems.push(`scroll needs x, y and notches, or a direction: ${text}`)
        continue
      }
      if (nums[0] < 0 || nums[1] < 0) {
        problems.push(`scroll has a negative coordinate: ${text}`)
        continue
      }
      if (nums[2] === 0) {
        problems.push(`scroll by nothing does nothing: ${text}`)
        continue
      }
      steps.push({
        kind: 'scroll',
        x: nums[0],
        y: nums[1],
        notches: clamp(Math.round(nums[2]), -MAX_SCROLL, MAX_SCROLL)
      })
      continue
    }

    if (verb === 'press' || verb === 'focus') {
      /* Quotes optional: `press "Compose"` and `press Compose` both work,
         because a model told to quote will sometimes not. */
      const name = rest.replace(/^["']|["']$/g, '').trim()
      if (!name) {
        problems.push(`${verb} needs the name of something on screen: ${text}`)
        continue
      }
      if (name.length > MAX_TYPE) {
        problems.push(`${verb} name is absurdly long; dropped`)
        continue
      }
      steps.push({ kind: 'press', name, focusOnly: verb === 'focus' })
      continue
    }

    if (verb === 'fill') {
      /*
       * `fill "To recipients" stanley@example.com`
       *
       * The name has to be quoted, because a control is called things like
       * "To recipients" and there is no way to tell where the name stops and
       * the text starts otherwise. A model that forgets the quotes is told
       * which half it left out rather than having its first word taken as a
       * field name and the rest typed into whatever that found.
       */
      const quoted = /^(["'])(.+?)\1\s*([\s\S]*)$/.exec(rest)
      if (!quoted) {
        problems.push(`fill needs the box's name in quotes, then the text: ${text}`)
        continue
      }
      const name = quoted[2].trim()
      const value = quoted[3]
      if (!name) {
        problems.push(`fill needs the name of a box: ${text}`)
        continue
      }
      if (!value) {
        problems.push(`fill has nothing to put in "${name}"; use \`focus\` to only put the cursor there`)
        continue
      }
      if (value.length > MAX_PASTE) {
        problems.push(`fill is longer than ${MAX_PASTE} characters; dropped`)
        continue
      }
      /* Same two-character escapes as paste, since it goes in the same way. */
      steps.push({
        kind: 'fill',
        name,
        text: value.replace(/\\n/g, NL).replace(/\\t/g, TAB)
      })
      continue
    }

    if (verb === 'paste') {
      if (!rest) {
        problems.push(`paste has nothing to paste: ${text}`)
        continue
      }
      if (rest.length > MAX_PASTE) {
        problems.push(`paste is longer than ${MAX_PASTE} characters; dropped`)
        continue
      }
      /*
       * A backslash-n in the text means a newline. A block is read line by
       * line, so this is the only way a paste can carry one - and carrying
       * newlines is most of why paste exists.
       */
      steps.push({ kind: 'paste', text: rest.replace(/\\n/g, NL).replace(/\\t/g, TAB) })
      continue
    }

    if (verb === 'type') {
      /* Not trimmed beyond the line's own edges: a trailing space in a typed
         string is sometimes the point, and leading indentation never is. */
      if (!rest) {
        problems.push(`type has nothing to type: ${text}`)
        continue
      }
      if (rest.length > MAX_TYPE) {
        problems.push(`type is longer than ${MAX_TYPE} characters; dropped`)
        continue
      }
      steps.push({ kind: 'type', text: rest })
      continue
    }

    if (verb === 'key') {
      if (!/^[a-z0-9+\s]+$/i.test(rest) || !rest) {
        problems.push(`key needs a chord like ctrl+a: ${text}`)
        continue
      }
      steps.push({ kind: 'key', chord: rest.replace(/\s+/g, '') })
      continue
    }

    if (verb === 'wait') {
      const ms = Number(rest)
      if (!Number.isFinite(ms) || ms <= 0) {
        problems.push(`wait needs a number of milliseconds: ${text}`)
        continue
      }
      steps.push({ kind: 'wait', ms: clamp(Math.round(ms), 1, MAX_WAIT) })
      continue
    }

    problems.push(`not a step: ${text}`)
  }

  return { reason: reason.join(' ').trim(), steps, problems }
}

/** One line per step, for the card. What is about to happen to their desktop. */
export function describe(step: Step): string {
  switch (step.kind) {
    case 'click':
      return `${step.times > 1 ? 'Double-click' : step.button === 'right' ? 'Right-click' : 'Click'} at ${step.x}, ${step.y}`
    case 'move':
      return `Move the pointer to ${step.x}, ${step.y}`
    case 'type':
      return `Type ${JSON.stringify(step.text)}`
    case 'key':
      return `Press ${step.chord}`
    case 'wait':
      return `Wait ${step.ms}ms`
    case 'press':
      return `${step.focusOnly ? 'Put the cursor in' : 'Press'} ${JSON.stringify(step.name)}`
    case 'paste': {
      const short = step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text
      return `Paste ${JSON.stringify(short)}${
        step.text.length > 60 ? ` (${step.text.length} characters)` : ''
      }`
    }
    case 'fill': {
      const short = step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text
      return `Put ${JSON.stringify(short)} in ${JSON.stringify(step.name)} and check it`
    }
    case 'read':
      return `Read ${JSON.stringify(step.name)} back`
    case 'reveal':
      return `Scroll ${JSON.stringify(step.name)} into view`
    case 'scroll': {
      const way = step.notches > 0 ? 'down' : 'up'
      const n = Math.abs(step.notches)
      const where = step.x < 0 ? 'where the pointer is' : `at ${step.x}, ${step.y}`
      return `Scroll ${way} ${n} notch${n === 1 ? '' : 'es'} ${where}`
    }
  }
}

/**
 * Where a screenshot pixel is on the real screen.
 *
 * The capture is of one display, taken at that display's size in device-
 * independent pixels and then scaled down to fit the long edge. So going back
 * is: undo the shrink, then add the display's own origin - which is not zero
 * on a second monitor, and is the step whose absence puts every click on the
 * wrong screen.
 */
export interface ShotFrame {
  /** The display's work origin and size, in the coordinates SetCursorPos takes. */
  displayX: number
  displayY: number
  displayWidth: number
  displayHeight: number
  /** The image the model was actually shown. */
  imageWidth: number
  imageHeight: number
}

export function toScreen(frame: ShotFrame, x: number, y: number): { x: number; y: number } {
  const kx = frame.displayWidth / frame.imageWidth
  const ky = frame.displayHeight / frame.imageHeight
  return {
    x: Math.round(frame.displayX + x * kx),
    y: Math.round(frame.displayY + y * ky)
  }
}

/** True when the point is inside the image the model was shown. */
export function onShot(frame: ShotFrame, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < frame.imageWidth && y < frame.imageHeight
}
