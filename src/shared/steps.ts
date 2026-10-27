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
  | { kind: 'key'; chord: string; times?: number }
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
   * Putting the keyboard into PROSE, where there is no box to name.
   *
   * Asked for after a document went uncorrected: "I was writing a document
   * and I asked it about some sort of grammatical error and I asked it to
   * edit it directly by itself... it had a good idea. It knew what to do.
   * But then it didn't seem to execute."
   *
   * It could not. A word in the middle of a paragraph is not a control: it
   * has no name, so `press`, `focus` and `fill` have nothing to look up, and
   * `fill` on the whole document would replace the document. The only thing
   * left was a coordinate click - and typing after one of those is refused,
   * for good reasons that have nothing to do with editing text (see
   * typingIsAimed). So the one request had no legal step anywhere in the
   * grammar, and a model with exactly the right idea had no way to say it.
   *
   * This is that step, and it earns the typing that follows by asking the
   * question a bare click never answers: after the click, WHO HAS THE
   * KEYBOARD? UI Automation knows - the focused element, its role, and what
   * is selected in it - so the step either reports that the caret is in text
   * and what the selection is, or fails and stops the plan before a single
   * character goes anywhere.
   *
   * `select` is how a human fixes a typo: double-click the word, type the
   * replacement over it. The selection comes back in the report, so the
   * model can see it caught "thirty's" and not the word beside it.
   */
  | { kind: 'caret'; x: number; y: number; select: 'point' | 'word' | 'line' }
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
  | {
      kind: 'fill'
      name: string
      text: string
      /**
       * Whether deleting what is already in the box was asked for.
       *
       * `fill` does not, and `replace` does, and the difference is a user's
       * email signature.
       *
       * Reported: "it erased my entire signature (built different) and
       * replaced it with the content, but my signature is supposed to stay
       * there". The log is one line - `Put "HI" in "Message Body" -> FILL
       * ok "Message Body" now says "HI"` - and what that line does not say
       * is that emptying the box first deleted everything the user had in
       * it. The step was carried out exactly as designed.
       *
       * So the design was wrong, in the way a default is wrong: the common
       * case is a box that is empty, where this changes nothing at all, and
       * the case it got wrong is the one where somebody's own writing is in
       * there. A verb that destroys text should be a verb somebody chose.
       */
      force: boolean
    }

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

/**
 * How many times one key may repeat in a step.
 *
 * Enough to empty any field worth emptying a character at a time, and short
 * of a mistyped count holding a key down over something that is not a text
 * box. The helper enforces the same number, because a plan is not the only
 * thing that can send a command.
 */
export const MAX_REPEAT = 400

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

    if (verb === 'caret') {
      /*
       * "caret 640 520", or with `word` or `line` to select what is there.
       *
       * The modifier is a word rather than a click count because the count
       * is an implementation detail of how Windows says "select the word" -
       * and a model writing `caret 640 520 2` would be guessing at which
       * number means what.
       */
      const bits = rest.split(/[\s,]+/).filter(Boolean)
      const pair = /^(-?\d+)$/.test(bits[0] ?? '') && /^(-?\d+)$/.test(bits[1] ?? '')
      if (!pair) {
        problems.push(`caret needs two numbers: ${text}`)
        continue
      }
      const x = Number(bits[0])
      const y = Number(bits[1])
      if (x < 0 || y < 0) {
        problems.push(`caret has a negative coordinate: ${text}`)
        continue
      }
      const how = (bits[2] ?? 'point').toLowerCase()
      /* `paragraph` because that is what a triple-click actually takes in a
         document, and a model that writes it means `line`. */
      const select =
        how === 'word'
          ? 'word'
          : how === 'line' || how === 'paragraph'
            ? 'line'
            : how === 'point' || bits.length < 3
              ? 'point'
              : null
      if (select === null) {
        problems.push(`caret takes nothing, \`word\` or \`line\` after the point: ${text}`)
        continue
      }
      steps.push({ kind: 'caret', x, y, select })
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

    if (verb === 'fill' || verb === 'replace') {
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
        text: value.replace(/\\n/g, NL).replace(/\\t/g, TAB),
        /* The word the model used IS the permission. See Step.force. */
        force: verb === 'replace'
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
      /*
       * A trailing number repeats the key: `key backspace 12`.
       *
       * Emptying a box is one press per character, and a step per press
       * would be a plan of forty lines and forty round trips. The count is
       * separated here rather than in the chord, so "f12" stays a key and
       * "backspace 12" becomes twelve backspaces.
       */
      const repeat = /^(.*?)\s+(\d{1,3})$/.exec(rest)
      const chord = (repeat ? repeat[1] : rest).replace(/\s+/g, '')
      const times = repeat ? Number(repeat[2]) : 1
      if (times < 1 || times > MAX_REPEAT) {
        problems.push(`key can repeat 1 to ${MAX_REPEAT} times, not ${times}: ${text}`)
        continue
      }
      steps.push(times > 1 ? { kind: 'key', chord, times } : { kind: 'key', chord })
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
/**
 * Field names that mean the value is nobody's business, including ours.
 *
 * Every step is written to wumpy.log by name and value, which was harmless
 * while a fill was somebody's email address. The instructions now allow a
 * password the user handed over to be typed into the form they asked for -
 * and a password typed into a form has no business being written to a log
 * file in plain text afterwards.
 *
 * Matched on the FIELD, not on the value: there is no way to look at
 * "123456ASDF" and know, and a rule that tries will redact half the
 * transcript and still miss the one that mattered.
 */
const SECRET_FIELD = /pass ?(word|code|phrase)?\b|^pw$|\bpin\b|secret|security code|cvv|cvc|card number|otp|one.?time|2fa|token|api ?key/i

/** What goes in the log and the report in place of a secret. */
export const HIDDEN = '********'

/** True when a value typed into this field should not be written down. */
export function isSecretField(name: string): boolean {
  return SECRET_FIELD.test(name ?? '')
}

/** A box whose value is a person, where the wrong one is a message sent. */
const ADDRESS_FIELD = /\b(to|cc|bcc|recipient|recipients|addressee|send to)\b/i

/** Something with an @ and a dot after it: an address, not a search for one. */
const LOOKS_LIKE_ADDRESS = /\S+@\S+\.\S+/

/**
 * What to say after a half-typed name lands in a recipient box.
 *
 * Reported, with a screenshot of Gmail offering two Stanley Lees - one at
 * schools.example.edu.au and one at gmail.com: "next time, it should ask me
 * which email that is showing to send it to, as both are called stanley".
 *
 * There is nothing wrong with typing "stanley" into the To box; that is what
 * a person does. What must not happen next is a guess, and a guess here is
 * one keystroke - Enter takes whichever suggestion the page has highlighted,
 * and nothing afterwards says which address it picked. The recipient is the
 * one field in a message where being wrong cannot be taken back: the mail
 * goes to a real person who is not the one who was meant.
 *
 * So the step that puts a partial name there says so in its own result,
 * which is where every other correction in this file lives. Nothing is
 * blocked - the model can still read the list and press the right one - it
 * is told that picking needs certainty and that asking is available.
 *
 * Empty when the text is already an address: "stanley@example.com" in a To
 * box is not ambiguous, and a warning on every correct recipient is a
 * warning nobody reads.
 */
export function pickingRecipient(name: string, text: string): string {
  if (!ADDRESS_FIELD.test(name ?? '')) return ''
  if (LOOKS_LIKE_ADDRESS.test(text ?? '')) return ''
  return (
    'This is a partial name in a recipient box, so the page is now offering matches for ' +
    'it. Do NOT press Enter or pick one on the assumption there is only one: look at the ' +
    'suggestions on screen, and if more than one person matches - the same name at two ' +
    'different addresses is the normal case - ask the user which address, with their ' +
    'addresses quoted, and wait. Pressing one of these decides who gets the message.'
  )
}

/** What the helper says about whatever holds the keyboard. */
export interface Focused {
  role: string
  /** True when it is one of Wumpy's own windows. */
  ours: boolean
  /** 'yes', 'no', or 'readonly' - whether characters would go into it. */
  takes: string
  name: string
  /** What is selected in it, empty when nothing is or it cannot be read. */
  selected: string
}

/**
 * A name on its way into a line that is read for the word "ok".
 *
 * Every reply on this protocol is judged by whether " ok" appears in it, and
 * a caret failure has to quote the control that wrongly has the keyboard. A
 * button called "Looks ok" would turn its own refusal into a success, and the
 * next step would type into it - which is the single thing this step exists
 * to prevent. One underscore, in a name being quoted back to a model, is the
 * cheapest possible price for that not happening.
 */
function plainly(name: string): string {
  return name.replace(/ ok\b/gi, '_ok')
}

/**
 * Whether a caret landed somewhere it is safe to type, and what to say.
 *
 * This is the whole difference between `caret` and `click`. The click is the
 * same synthesised button press either way; what follows it is a question to
 * UI Automation about the focused element, and the answer to that question
 * is what earns the typing. Three answers are failures, and each says what
 * actually happened rather than that the step did not work:
 *
 *   - the keyboard is in Wumpy's own panel, so the click never reached their
 *     window at all;
 *   - the keyboard is in something that is not text, where single letters
 *     are shortcuts - the three-empty-drafts failure, one step earlier;
 *   - a word was asked for and nothing came back selected, which means the
 *     next step would INSERT rather than replace. "thirty'sthirties" in the
 *     middle of somebody's document is worse than a refusal.
 *
 * Pure, so the judgement can be checked without a desktop, a document and
 * somebody to look at it. The protocol parsing lives in main, with the pipe.
 */
export function caretVerdict(got: Focused, select: 'point' | 'word' | 'line'): string {
  const what = `${got.name ? JSON.stringify(plainly(got.name)) : 'something with no name'} (${got.role})`
  if (got.ours) {
    return (
      `CARET FAILED the keyboard is in Wumpy's own panel - ${what} - and not in their ` +
      'window, so the click did not land where you aimed it. Look again.'
    )
  }
  if (got.takes === 'readonly') {
    return `CARET FAILED the keyboard is in ${what}, which is text but cannot be edited. Nothing was typed.`
  }
  if (got.takes !== 'yes') {
    return (
      `CARET FAILED the keyboard is in ${what}, which is not text. Anything typed now ` +
      'would be read as shortcuts, so nothing was. Aim at the writing itself, or press ' +
      'the control by name.'
    )
  }
  if (select !== 'point' && !got.selected) {
    return (
      `CARET FAILED the cursor is in ${what}, but nothing came back selected, so typing ` +
      'would insert beside the word instead of replacing it. Either the point missed the ' +
      'word, or this editor does not report its selection - if it is a document, use its ' +
      'own find and replace instead: `key ctrl+h`, then fill the two boxes by name.'
    )
  }
  if (!got.selected) return `CARET ok the cursor is in ${what}, with nothing selected.`
  return (
    `CARET ok the cursor is in ${what}, with ${JSON.stringify(got.selected)} selected - ` +
    'typing now replaces exactly that and nothing else.'
  )
}

export function describe(step: Step): string {
  switch (step.kind) {
    case 'click':
      return `${step.times > 1 ? 'Double-click' : step.button === 'right' ? 'Right-click' : 'Click'} at ${step.x}, ${step.y}`
    case 'move':
      return `Move the pointer to ${step.x}, ${step.y}`
    case 'type':
      return `Type ${JSON.stringify(step.text)}`
    case 'key':
      return step.times && step.times > 1
        ? `Press ${step.chord} ${step.times} times`
        : `Press ${step.chord}`
    case 'wait':
      return `Wait ${step.ms}ms`
    case 'press':
      return `${step.focusOnly ? 'Put the cursor in' : 'Press'} ${JSON.stringify(step.name)}`
    case 'caret':
      /* The card says what is about to be SELECTED, because a selection is
         what the next step types over. */
      return step.select === 'point'
        ? `Put the cursor in the text at ${step.x}, ${step.y}, and check it landed there`
        : `Select the ${step.select === 'word' ? 'word' : 'line'} at ${step.x}, ${step.y}, and check what it caught`
    case 'paste': {
      const short = step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text
      return `Paste ${JSON.stringify(short)}${
        step.text.length > 60 ? ` (${step.text.length} characters)` : ''
      }`
    }
    case 'fill': {
      /*
       * And whether anything is about to be DELETED, in the sentence the
       * card shows.
       *
       * The card is the whole of the review on accept-all - it is read
       * after the fact, if at all - so the one word that distinguishes
       * "put this in the empty box" from "delete what is in the box and
       * put this there instead" has to be in it. "Put "HI" in "Message
       * Body" and check it" is what scrolled past while a signature was
       * being deleted.
       */
      const verb = step.force ? 'Replace everything in' : 'Put'
      const tail = step.force ? 'with' : 'in'
      /* The value goes to the field; it does not go to the log. */
      if (isSecretField(step.name)) {
        return step.force
          ? `Replace everything in ${JSON.stringify(step.name)} with ${HIDDEN} and check it`
          : `Put ${HIDDEN} in ${JSON.stringify(step.name)} and check it`
      }
      const short = step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text
      return step.force
        ? `${verb} ${JSON.stringify(step.name)} ${tail} ${JSON.stringify(short)} and check it`
        : `${verb} ${JSON.stringify(short)} ${tail} ${JSON.stringify(step.name)} and check it`
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
