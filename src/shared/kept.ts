/**
 * What the model keeps to itself: <keep>...</keep>.
 *
 * "We were playing hangman and I told it to give me a word with vowels, but
 * it kept on saying that no vowels." It could not have done better. A model
 * has no memory between turns except the conversation, so a word it chose
 * and did not write down was gone by the next guess, and every "is there an
 * E?" was answered about a word it was making up on the spot. Its reasoning
 * does not help either: that is thrown away after each turn.
 *
 * So it may write a note into its answer that nobody sees or hears - the
 * hangman word spelled out, the number to guess, the riddle's answer - and
 * the note goes back to it with the rest of the conversation, so the next
 * guess is checked against what it actually chose. Shown nowhere, said
 * never; an unclosed one, still being written, is hidden to the end.
 *
 * Pure, for scripts/check-speakahead.mjs.
 */
const KEPT = /<keep>[\s\S]*?(?:<\/keep>|$)/gi

export function withoutKept(text: string): string {
  if (!text.includes('<')) return text
  return text.replace(KEPT, '').replace(/^\s+/, '')
}
