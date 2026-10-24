/**
 * Noticing when a plan of clicks has stopped getting anywhere.
 *
 * Reported, about a quiz on a web page: "after i read the passage and
 * answered the first question, it got stuck after the next few, and kept
 * looking back at the passage, looking to see if there were more questions
 * after Q2, looking back, looking at the options, etc and did the same thing
 * forever".
 *
 * The log says exactly that, and it is worth reading once because the shape
 * of the bug is the shape of the fix. Between 15:04:26 and 15:06:24 - until
 * the user gave up and hid the panel - twenty-five screenshots, twenty turns,
 * about twenty thousand tokens of context each:
 *
 *   scroll up 5   -> 153,529 bytes, 39 controls
 *   scroll down 5 -> 110,482 bytes, 57 controls
 *   scroll up 5   -> 153,529 bytes, 39 controls     the same screen again
 *   scroll down 5 -> 110,482 bytes, 57 controls     and again
 *   scroll down 5 -> 105,067 bytes, 59 controls
 *   scroll up 5   -> 110,482 bytes, 57 controls     and again
 *   ...
 *
 * It was oscillating between three scroll positions and seeing byte-identical
 * pictures of each. Nothing in the app noticed, for two reasons:
 *
 * ONE, NOTHING COUNTED. AUTO_RUN_LIMIT caps unattended COMMANDS at six,
 * precisely because "a small model handed 'exit code 0, no output' very often
 * replies by proposing it again, which in an automatic mode is a loop that
 * runs as fast as the model can type". A plan of clicks had no such cap at
 * all, and it is the same loop with a photograph in it.
 *
 * TWO, IT COULD NOT REMEMBER. KEEP_PICTURES is 2, for good reasons given
 * where it is defined - a picture per step is a quadratic cost - so by the
 * third step the screen from the first has been dropped and replaced with a
 * note saying it was dropped. The model genuinely cannot see that it has been
 * here before. Asking it to keep track in prose has no more chance than
 * asking it to remember a picture it was not sent.
 *
 * So this module does the two things the model cannot: it keeps a cheap
 * written trail of where the plan has already been, and it refuses to take
 * another step once the trail says the plan is going in circles.
 *
 * Pure, and the limits are per chain - the run of automatic steps since the
 * user last typed. Typing is the person rejoining the loop, which is the rule
 * the command budget already uses, and it is also the escape hatch: "carry
 * on" starts a fresh chain.
 */

/** One automatic step, and the screen it left behind. */
export interface Visit {
  /** The step as the model wrote it, shortened. */
  step: string
  /** What the screen looked like afterwards. See screenPrint. */
  screen: string
  /** How many controls were on it, for the trail line. */
  controls: number
}

/**
 * The same screen this many times in one chain is going in circles.
 *
 * Three rather than two, because two is a legitimate move: look, act, look
 * back at where you were. Three is the second time a step has produced
 * nothing new, and in the log above the third sighting of the first repeated
 * screen lands ninety seconds before the user gave up.
 */
export const SEEN_ENOUGH = 3

/**
 * And a backstop for a plan that wanders without ever repeating itself.
 *
 * Twenty steps is far more than any real sequence here has needed - the
 * longest working run in the log is nine - and at a screenshot and a turn
 * each it is already the most expensive thing Wumpy can do unattended.
 */
export const CHAIN_LIMIT = 20

/** How many of the most recent steps the trail tells the model about. */
export const TRAIL_SHOWN = 10

/**
 * What makes two screens the same screen.
 *
 * Both halves, and the AND is the point.
 *
 * THE CONTROL NAMES, because they are semantic: the accessibility tree of a
 * page scrolled to the questions is a different list from the same page
 * scrolled to the passage, and it does not change because a pixel did.
 *
 * THE BYTE COUNT of the picture, because the names alone are not enough in
 * the other direction. Typing into the second of three boxes on a form
 * changes nothing about which controls exist, and a rule resting on names
 * alone would call that going in circles and stop a sequence that was
 * working perfectly. The bytes move the moment anything on screen does.
 *
 * Observed in the log: every repeat had BOTH the same control count and
 * byte-for-byte the same picture - 110,482 three times, 153,529 three times.
 * A screen that genuinely changed never did.
 */
export function screenPrint(
  controls: ReadonlyArray<{ name?: string }> | undefined,
  bytes = 0
): string {
  const names = (controls ?? [])
    .map((c) => (c?.name ?? '').trim())
    .filter(Boolean)
    .join('|')
  /* A small string rather than the names themselves: this is kept per step
     for the length of a chain and compared, never shown. */
  let hash = 0
  for (let i = 0; i < names.length; i++) {
    hash = (hash * 31 + names.charCodeAt(i)) | 0
  }
  return `${hash.toString(36)}:${(controls ?? []).length}:${Math.max(0, Math.round(bytes))}`
}

/**
 * A step, short enough to sit in a trail that is sent every turn.
 *
 * The steps arrive as readable sentences - "Scroll down 5 notches where the
 * pointer is", "Press \"D to demonstrate how relaxed MacEwen was despite the
 * bad weather\"" - and the second kind is a whole answer option. Ten of those
 * in full would be most of a screenshot's worth of tokens.
 */
export function shortStep(step: string, max = 56): string {
  const text = String(step ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** How many times this screen appears in the trail. */
export function seenTimes(trail: readonly Visit[], screen: string): number {
  return trail.reduce((n, v) => (v.screen === screen ? n + 1 : n), 0)
}

/** The step the screen was first reached at, 1-based, or null. */
export function firstSeenAt(trail: readonly Visit[], screen: string): number | null {
  const at = trail.findIndex((v) => v.screen === screen)
  return at < 0 ? null : at + 1
}

/**
 * Why no further step may be taken in this chain, or null to carry on.
 *
 * Consulted BEFORE running the next plan, so the refusal costs nothing: the
 * trail already holds everything it needs to know, and the step that would
 * have produced the twenty-sixth identical screenshot is simply not taken.
 *
 * The words are written for the model, because the model is who reads them
 * and what it does next is the whole point - it has to answer from what it
 * already has rather than propose a twenty-seventh look. They are also shown
 * to the user in the card, so they say what to type to carry on.
 */
export function stuck(trail: readonly Visit[]): string | null {
  for (const v of trail) {
    const times = seenTimes(trail, v.screen)
    if (times < SEEN_ENOUGH) continue
    return (
      `this sequence has arrived at the same screen ${times} times, so it is ` +
      'going in circles rather than making progress. No more steps will run ' +
      'until the user types something. Answer now, from what you have already ' +
      'seen: say what you found, say plainly what you could not find, and do ' +
      'not propose another step. If you need them to scroll somewhere or say ' +
      'what is on screen, ask them.'
    )
  }
  if (trail.length >= CHAIN_LIMIT) {
    return (
      `${trail.length} steps have run on the screen without answering the ` +
      'user. No more will run until they type something. Answer now, from ' +
      'what you have, and say plainly what is still missing.'
    )
  }
  return null
}

/**
 * The trail, as lines for the report that goes back with each step.
 *
 * This is the memory the pictures cannot be: one line a step, naming the
 * screen it reached and - the line that matters - saying when that screen was
 * last seen. A model that is told "screen C, which you first saw at step 2"
 * has what it needs to stop scrolling back to step 2.
 *
 * Screens are lettered in the order they were first reached, which is a label
 * a sentence can refer to. The newest steps only: the whole trail would grow
 * without bound in a conversation that is already at its context limit.
 */
export function trailLines(trail: readonly Visit[]): string[] {
  if (trail.length < 2) return []

  /* Lettered off the WHOLE trail, so a letter means the same thing in every
     report even once the early steps have scrolled out of the shown window. */
  const letters = new Map<string, string>()
  for (const v of trail) {
    if (letters.has(v.screen)) continue
    const n = letters.size
    letters.set(
      v.screen,
      /* A, B, ... Z, then AA. Twenty-six is already past CHAIN_LIMIT. */
      n < 26 ? String.fromCharCode(65 + n) : `A${String.fromCharCode(65 + (n % 26))}`
    )
  }

  const shown = trail.slice(-TRAIL_SHOWN)
  const skipped = trail.length - shown.length
  const lines = shown.map((v, i) => {
    const at = skipped + i + 1
    const letter = letters.get(v.screen) ?? '?'
    const first = firstSeenAt(trail, v.screen)
    const again =
      first !== null && first < at
        ? ` — the same screen you were on at step ${first}`
        : ''
    return `  ${at}. ${v.step} → screen ${letter} (${v.controls} controls)${again}`
  })

  return [
    'Where this sequence has already been' +
      (skipped > 0 ? ` (the last ${shown.length} of ${trail.length} steps)` : '') +
      ', which you can no longer see because only the newest pictures are kept:',
    ...lines
  ]
}

/**
 * The one line that matters most, when the newest step landed somewhere it
 * had already been.
 *
 * Said separately from the trail because it is the thing to act on, and a
 * line at the end of a report is read where an item in a list of ten is not.
 * Null when the newest screen is new, which is what progress looks like.
 */
export function circlingNote(trail: readonly Visit[]): string | null {
  const last = trail[trail.length - 1]
  if (!last) return null
  const times = seenTimes(trail, last.screen)
  if (times < 2) return null
  const first = firstSeenAt(trail, last.screen)
  const nth = times === 2 ? 'second' : times === 3 ? 'third' : `${times}th`
  return (
    `THIS IS THE SAME SCREEN AS STEP ${first}, for the ${nth} time. Scrolling ` +
    'back and forth over a page you have already read is not making ' +
    'progress: nothing new will arrive by looking again. Use what you have ' +
    'read, and if something is genuinely not there, say so.'
  )
}
