/**
 * How much of a long conversation to actually put in the page.
 *
 * Every message in the transcript is a live React subtree: markdown parsed
 * into elements, a card per proposal, a <video> or an <img> per attachment.
 * A long session therefore gets slower at everything - typing, scrolling,
 * streaming - because each keystroke reconciles the lot. The model does not
 * care how much is on screen; it reads the history array, which is untouched
 * here and compacted separately.
 *
 * So the page holds a window onto the end of the conversation and says what
 * it is not showing. Nothing is deleted and nothing is forgotten: the
 * messages are all still in state, still saved, still sent.
 *
 * Pure, so the arithmetic can be tested without rendering anything.
 */

/**
 * Messages kept in the page by default.
 *
 * Roughly a dozen exchanges - far more than anyone scrolls back through by
 * eye, and small enough that the cost of a keystroke stops growing with the
 * length of the session.
 */
export const KEEP_RENDERED = 30

/** Revealed per click, so a long history opens in bites rather than at once. */
export const REVEAL_STEP = 30

/** Index of the first message to render. */
export function firstShown(total: number, revealed: number): number {
  const cap = KEEP_RENDERED + Math.max(0, revealed)
  return Math.max(0, total - cap)
}

/** How many are folded away above it. */
export function hiddenCount(total: number, revealed: number): number {
  return firstShown(total, revealed)
}

/**
 * Whether folding is worth doing at all.
 *
 * Below a few over the cap the notice costs more attention than the saving
 * is worth, and a transcript that sprouts "2 earlier messages" reads as a
 * bug rather than a feature.
 */
export const FOLD_MARGIN = 6

export function foldsTranscript(total: number, revealed: number): boolean {
  return hiddenCount(total, revealed) > FOLD_MARGIN
}
