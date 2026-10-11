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

/** "Not past 2.5 seconds", as asked for. */
export const BAIL_WINDOW_MS = 2500

/**
 * About two sentences.
 *
 * Above this there is something on screen worth reading, and taking it away
 * to hand back a prompt would be destroying an answer the user can see.
 */
export const BAIL_CHARS = 240

export function returnsThePrompt(m: AbortMoment): boolean {
  if (m.elapsedMs >= BAIL_WINDOW_MS) return false
  // A block means a command was being proposed, which is the useful part of
  // many answers and arrives early. Never throw that away.
  if (m.startedBlock) return false
  return m.outputChars < BAIL_CHARS
}

/** Whether a reply has opened a fenced block yet. */
export function hasBlock(text: string): boolean {
  return text.includes('```')
}
