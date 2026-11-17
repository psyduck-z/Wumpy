/**
 * Whisper's one bad habit: words out of nothing.
 *
 * Given a cough, a breath or a second of room noise, Whisper large-v3 does
 * not say it heard nothing, the way Parakeet does. It says "Thank you." - or
 * "Thanks for watching!", or "you" - because it learned on video subtitles,
 * where the quiet bits at the end are captioned that way. In a conversation
 * that is worse than a wrong word: talking over Jason is how he is stopped,
 * so a cough heard as "Thank you." would cut him off to answer a thanks
 * nobody gave.
 *
 * So these few phrases, and only when they are the whole of what was heard,
 * are checked against Parakeet before they count. A real "thank you" is
 * still heard - Parakeet hears it too - and costs one more request, which
 * at these phrases is rare.
 */
const INVENTED = new RegExp(
  '^(?:' +
    [
      'thank you(?: (?:so|very) much)?(?: for (?:watching|listening))?',
      'thanks(?: (?:so|very) much)?(?: for (?:watching|listening))?',
      'you',
      'bye(?:[- ]bye)?',
      '(?:please )?(?:like and )?subscribe.*',
      'subtitles by.*',
      '.*amara\\.org.*',
      "i'?m sorry",
      'so',
      'oh'
    ].join('|') +
    ')$'
)

export function mayBeInvented(heard: string): boolean {
  const said = heard
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'. -]+/gu, ' ')
    .replace(/[.!?\s]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return !said || INVENTED.test(said)
}
