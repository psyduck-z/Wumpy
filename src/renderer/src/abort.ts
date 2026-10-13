/**
 * Whether an interrupted turn should hand the prompt back.
 *
 * Pressing Ctrl+C a moment after sending almost always means "no, wait, let me
 * reword that" - so the question goes back in the box ready to edit, and the
 * dead exchange is taken out of the transcript rather than left there for the
 * model to read next turn.
 *
 * Pressing it after a real answer has started means something else entirely:
 * stop, I have seen enough. That must leave the transcript alone, because what
 * arrived is worth keeping and the question has been answered.
 *
 * Which of the two it is depends on how much the model has DONE, not only on
 * how long ago the question went out - so the window is three seconds while
 * nothing has come back and shrinks as the answer arrives. A model that spent
 * three seconds thinking has produced nothing to lose; a model that spent
 * three seconds answering has filled the panel.
 *
 * Pure, so the boundary between those two can be tested without a window.
 */

export interface AbortMoment {
  /** Since the request was sent. */
  elapsedMs: number
  /** Characters of reply that had arrived. */
  outputChars: number
  /** Whether the reply had begun a fenced block - a proposal counts as work. */
  startedBlock: boolean
}

/**
 * The longest the window is ever open: three seconds, while nothing has come
 * back at all.
 *
 * Was a flat 2.5 seconds, which treated two very different moments as one.
 * Three seconds of a model thinking has produced nothing to lose, so the
 * question should still come back; three seconds of a model answering has
 * filled the panel, and handing the prompt back would delete what is on
 * screen.
 */
export const BAIL_WINDOW_MS = 3000

/**
 * The shortest it ever is: a second, however much has arrived.
 *
 * Under the character ceiling there is always a moment to change your mind -
 * a fast model on this endpoint streams about 160 characters a second, so
 * without a floor the window would be over before a hand could reach Ctrl+C.
 */
export const BAIL_FLOOR_MS = 1000

/**
 * About two sentences.
 *
 * Above this there is something on screen worth reading, and taking it away
 * to hand back a prompt would be destroying an answer the user can see.
 */
export const BAIL_CHARS = 240

/**
 * How long the window stays open, given what the model has produced so far.
 *
 * The two signals trade against each other rather than being checked
 * separately: time spent waiting is cheap to throw away, and text already on
 * screen is not. So the window is the full three seconds while nothing has
 * arrived and shrinks towards the floor as the answer fills in, which is the
 * same sentence as "it depends on how much the model has done".
 */
export function bailWindowFor(outputChars: number): number {
  const done = Math.max(0, outputChars)
  if (done >= BAIL_CHARS) return 0
  const left = 1 - done / BAIL_CHARS
  return Math.max(BAIL_FLOOR_MS, Math.round(BAIL_WINDOW_MS * left))
}

export function returnsThePrompt(m: AbortMoment): boolean {
  // A block means a command was being proposed, which is the useful part of
  // many answers and arrives early. Never throw that away.
  if (m.startedBlock) return false
  if (m.outputChars >= BAIL_CHARS) return false
  return m.elapsedMs < bailWindowFor(m.outputChars)
}

/** Whether a reply has opened a fenced block yet. */
export function hasBlock(text: string): boolean {
  return text.includes('```')
}
