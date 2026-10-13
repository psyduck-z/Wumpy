/**
 * Which instructions this turn actually needs.
 *
 * The preamble is 13,341 tokens and every one of them goes out on every
 * request, into a 32,768 window, on a tier counted per minute and per day.
 * Measured section by section:
 *
 *   3,834  who Wumpy is and how to answer
 *   3,503  running commands on this machine
 *   3,182  opening pages and apps, and telling an app from a CLI tool
 *   1,546  clicking and typing on the screen
 *     600  when to ask instead of guessing
 *     247  taking a screenshot
 *     243  closing an app properly
 *     175  quota, search, and what Wumpy cannot change
 *
 * "What is my key percentage" needs none of the middle four. It pays for all
 * of them anyway, and then the conversation competes for what is left of the
 * window with the compaction machinery - which exists because the window is
 * full, which it is partly because of this.
 *
 * So the two biggest OPTIONAL sections are sent in full when the turn is
 * about them and reduced to a couple of lines when it is not. Which is a
 * guess, so the guess is made the safe way round:
 *
 *   - the stub always NAMES the capability, so the model can never conclude
 *     it cannot do something. That was the only way this could go badly.
 *   - anything that looks remotely like the capability expands it. A false
 *     expansion costs tokens on one turn; a false stub costs a worse answer,
 *     and those are not the same price.
 *   - a screenshot in the window expands the desktop rules outright. Desktop
 *     work always begins by looking - the instructions insist on it - so the
 *     picture arrives one turn before the aiming does, and the rules arrive
 *     with it. The ladder is self-correcting rather than keyword-dependent.
 *   - whatever the last answer used stays expanded, so a sequence of steps
 *     does not lose its instructions halfway through.
 *
 * SHELL AND SCREEN ARE NEVER STUBBED. Not for lack of savings - shell is the
 * second biggest section - but because the failure is invisible: a model that
 * has not been told it can look at the machine answers from memory instead,
 * confidently, and the whole point of this app is that it does not do that.
 * A screenshot section is 247 tokens and not worth the risk of either.
 *
 * Pure, so the whole decision can be run over real transcripts in a check.
 */

/** A section that can arrive in full or as a line saying it exists. */
export type Capability = 'open' | 'desktop'

/** The message shape this needs: role, what was said, whether it has pictures. */
export interface Turn {
  role: string
  content: string
  images?: readonly unknown[]
}

/**
 * Words that mean a page, an app, or a question about what is installed.
 *
 * Generous on purpose, and it includes the words for ASKING about an app
 * ("installed", "do I have") because that section holds the rule for telling
 * a desktop app from a command-line tool - the one that had Wumpy reporting
 * Claude was not installed while running inside it.
 */
const OPEN_WORDS =
  /\b(open|opens|opened|launch|launches|start|starts|run|runs|website|web ?site|web ?page|url|link|https?|browser|chrome|edge|firefox|tab|google|youtube|wikipedia|github|reddit|amazon|spotify|maps|search (?:for|on|up)|look (?:it )?up|visit|browse|go to|take me to|download|installed|install|uninstall|app|apps|application|program|programme|software|\.com|\.org|\.net|store|shop|gmail|outlook|hotmail|drive|docs|sheets|slides|calendar|whatsapp|discord|slack|notion|netflix|twitter|instagram|facebook|linkedin|teams|zoom)\b/i

/**
 * Words that mean acting on something already on the screen.
 *
 * The two lists overlap where the request does. "open spotify" is a launch
 * and reaches only the browser section; "open the file menu" reaches this one
 * through "menu"; and a named web application - gmail, docs, discord - is in
 * BOTH, because getting there and driving it are two different sets of rules
 * and anyone asking to compose an email needs each of them.
 */
const DESKTOP_WORDS =
  /\b(click|clicks|clicked|press|presses|pressed|type|types|typed|typing|fill|fills|filled|enter|select|selects|choose|tick|check ?box|drag|drop|scroll|hover|button|menu|dialog|field|text ?box|form|dropdown|drop-?down|toolbar|ribbon|window|windows|tab|tabs|screen|desktop|keyboard|mouse|cursor|caret|sign ?in|sign ?up|log ?in|login|compose|reply|forward|send (?:it|this|the|an? )?(?:email|message|mail)|inbox|gmail|outlook|account|password|username|submit|save as|copy|paste|cut|undo|redo|minimi[sz]e|maximi[sz]e|close (?:the|that|this)|switch to|alt ?tab|shortcut|hotkey|keystroke|automate|do it for me|for me on)\b/i

/** The fences, so a sequence keeps its instructions while it is running. */
const FENCES: Record<Capability, RegExp> = {
  open: /```wumpy-open/,
  desktop: /```wumpy-do/
}

/**
 * How far back to look.
 *
 * Four turns is about two exchanges, which covers "look at the screen" ->
 * picture -> "now click the blue one" without keeping a capability expanded
 * for the rest of a long conversation because it came up once.
 */
export const LOOKBACK = 4

/**
 * Which optional sections this turn should carry in full.
 *
 * Takes the messages as they will be SENT, not the whole transcript: a
 * screenshot that has already been trimmed out of the request is not a reason
 * to send the aiming rules.
 */
export function needsFor(messages: readonly Turn[]): Capability[] {
  const recent = messages.slice(-LOOKBACK)
  const needs = new Set<Capability>()

  /* A picture in the window means the screen is the subject. Desktop rules
     only - looking at a photograph is not a reason to explain browsers. */
  if (recent.some((m) => m.images?.length)) needs.add('desktop')

  for (const message of recent) {
    const text = message.content ?? ''
    if (!text) continue

    /* What the last answer actually did keeps its own instructions. A plan
       that runs over several turns must not lose them in the middle. */
    if (message.role === 'assistant') {
      for (const [capability, fence] of Object.entries(FENCES)) {
        if (fence.test(text)) needs.add(capability as Capability)
      }
      /* Only the fences from an assistant turn: its prose is Wumpy's own
         words and would match its own keywords on every turn. */
      continue
    }

    if (OPEN_WORDS.test(text)) needs.add('open')
    if (DESKTOP_WORDS.test(text)) needs.add('desktop')
  }

  return [...needs]
}

/**
 * The line that stands in for a section that was not sent.
 *
 * It states the capability and the exact fence, and nothing else. The point
 * is that the model knows what it can do and what to say to do it; if it
 * decides to, the words it used to decide will have expanded the real section
 * on this same turn, because those words are what `needsFor` reads.
 */
export const STUBS: Record<Capability, string> = {
  open: [
    'You can open a web page or an app in front of the user with a ```wumpy-open',
    'block, and you can check whether something is installed. The full rules for',
    'both arrive whenever the request is about opening, installing, or a website.'
  ].join('\n'),
  desktop: [
    'You can click and type on their screen with a ```wumpy-do block, after looking',
    'at it with ```wumpy-screen. The rules for aiming arrive with the screenshot;',
    'never attempt a click without one.'
  ].join('\n')
}
