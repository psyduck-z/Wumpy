/**
 * The rules of a spoken turn, kept pure so they can be checked without a
 * microphone: what counts as yes or no, how a spoken slash becomes a command,
 * what an approval question sounds like, and what of an answer is read aloud.
 */
import { withoutKept } from './kept'

/** Words that mean yes, and words that mean no, said on their own. */
const YES = /^(yes|yeah|yep|yup|ya|sure|ok|okay|alright|all right|affirmative|approve|approved|confirm|confirmed|go|go ahead|do it|run it|please do)$/
const NO = /^(no|nope|nah|negative|don't|do not|dont|cancel|stop|skip|deny|denied|no thanks|no thank you|don't do it|do not do it)$/

/**
 * Yes, no, or neither. Only a short reply counts: an approval is a question
 * with two answers, and anything longer than a few words is not one of them,
 * so it is ignored and the question asked again - "yes but first..." must not
 * run anything.
 */
export function yesNo(heard: string): 'yes' | 'no' | null {
  const said = heard
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!said || said.split(' ').length > 4) return null
  // "yes please", "no thanks": the first word decides when the rest is polite.
  const polite = said.replace(/\s+(please|thanks|thank you|wumpy)$/, '')
  const words = polite.split(' ')
  // Both kinds of word anywhere ("yes no", "no, yes") is not an answer.
  if (words.some((w) => YES.test(w)) && words.some((w) => NO.test(w))) return null
  const yes = YES.test(polite) || (YES.test(words[0]) && words.length <= 2)
  const no = NO.test(polite) || (NO.test(words[0]) && words.length <= 2)
  if (yes === no) return null
  return yes ? 'yes' : 'no'
}

/**
 * "Slash remember I like tea" -> "/remember I like tea".
 *
 * Saying "slash" means typing a command, not saying the word to the model.
 * Recognisers write it as the word, as a "/", or with punctuation after it
 * ("Slash. Remember..."), so all three are accepted. Null when the utterance
 * does not start with it.
 */
export function spokenSlash(heard: string): string | null {
  const m = /^\s*(?:slash|\/)[\s,.:;!-]*([a-z]+)\b[\s,.:;!-]*(.*)$/i.exec(heard)
  if (!m) return null
  const rest = m[2].trim().replace(/[.!?]+$/, '')
  return `/${m[1].toLowerCase()}${rest ? ` ${rest}` : ''}`
}

/**
 * The question for something waiting to run.
 *
 * A command block starts with a "# why" line, which reads as a question far
 * better than the command does: "# Check whether git is installed" becomes
 * "Can I check whether git is installed?". Without one, the description the
 * card gave, or a plain "Can I run that?".
 */
export function approvalQuestion(entry: { command: string; spoken?: string }): string {
  if (entry.spoken) return `Can I ${entry.spoken}?`
  const first = entry.command.split(/\r?\n/)[0]?.trim() ?? ''
  if (first.startsWith('#')) {
    const why = first.replace(/^#+\s*/, '').replace(/[.!?]+$/, '')
    if (why) return `Can I ${why.charAt(0).toLowerCase()}${why.slice(1)}?`
  }
  return 'Can I run that command?'
}

const FENCE = String.fromCharCode(96).repeat(3)

/** Two or more blanks and single letters in a row, at least one of them a blank. */
const BOARD = /(?<![\p{L}\p{N}_])(?=(?:[A-Za-z]\s+)*_)(?:_+|[A-Za-z])(?:\s+(?:_+|[A-Za-z]))+(?![\p{L}\p{N}_])/gu

/**
 * What of an answer is worth hearing: the prose, without code, markup or
 * links read out character by character, and not so long that a question
 * becomes a lecture. Cut at a sentence, so it never stops mid-word.
 */
export function speakable(markdown: string, limit = 600): string {
  const fence = new RegExp(`${FENCE}[\\s\\S]*?(${FENCE}|$)`, 'g')
  let text = withoutKept(markdown)
    .replace(fence, ' ')
    /* A hangman board, "_ _ O _": blanks and letters, said one by one.
       Taken for emphasis, the underscores went and it was a lone "O". */
    .replace(BOARD, (board) =>
      board
        .trim()
        .split(/\s+/)
        .map((t) => (t.startsWith('_') ? 'blank' : t.toUpperCase()))
        .join(', ')
    )
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S*[^\s.,!?;:)]/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  text = end > limit / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
  return text
}
