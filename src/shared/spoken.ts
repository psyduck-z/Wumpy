/**
 * The rules of a spoken turn, kept pure so they can be checked without a
 * microphone: what counts as yes or no, how a spoken slash becomes a command,
 * what an approval question sounds like, and what of an answer is read aloud.
 */
import { withoutKept } from './kept'
import { damerau } from './nearest'

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

/** A command as the voice knows it: its name and the other names it answers to. */
export interface CommandName {
  name: string
  aliases?: readonly string[]
}

/**
 * What Whisper has written for a command word, heard from these earbuds:
 * "slash log" came back "Slash love", "slash delete" came back "slash the
 * leak". Each is a guess, asked about before it runs.
 */
const HEARD_AS: Record<string, string> = {
  love: 'log', lug: 'log', lock: 'log', blog: 'log', lob: 'log', lag: 'log',
  'the leak': 'delete', 'the lead': 'delete', 'the league': 'delete', 'the lead it': 'delete', deleat: 'delete',
  modal: 'model', muddle: 'model', modell: 'model', 'mod all': 'model',
  knew: 'new', nu: 'new',
  'resumé': 'resume', presume: 'resume',
  'remember me': 'remember'
}

/**
 * A spoken slash command, as it was meant.
 *
 * `sure` when the word is a command as heard: it runs. Otherwise it is the
 * nearest command by how it is written and how it sounds - the same first
 * letter, a slip or two - and is asked about, because a wrong command run is
 * worse than a question: "Unknown command /love. Did you mean /move?" was
 * what "slash log" got, read out.
 *
 * Put right in the same breath, the correction is what is meant: "slash love,
 * I mean the slash log" is /log. "Flash" for "slash" only counts before a
 * command's own name, since Flash is also a model.
 */
export function spokenCommand(
  heard: string,
  commands: readonly CommandName[],
  /* Not while models are being chosen, where "Flash model" is GLM 5.3 Flash. */
  flashToo = true
): { command: string; name: string; sure: boolean } | null {
  const said = heard.trim()
  const lead = /^(?:slash|\/)[\s,.:;!-]*/i.exec(said)
  const flash = flashToo ? /^(?:flash|splash|lash)[\s,.:;!-]+/i.exec(said) : null
  if (!lead && !flash) return null
  const names = new Map<string, string>()
  for (const c of commands) {
    names.set(c.name.toLowerCase(), c.name)
    for (const a of c.aliases ?? []) if (/^[a-z]{2,}$/i.test(a)) names.set(a.toLowerCase(), a)
  }
  const tidy = (rest: string): string => rest.trim().replace(/^[\s,.:;!-]+/, '').replace(/[.!?]+$/, '').trim()
  const build = (name: string, rest: string, sure: boolean) => {
    const args = tidy(rest)
    return { command: `/${name.toLowerCase()}${args ? ` ${args}` : ''}`, name: name.toLowerCase(), sure }
  }
  /* "...I mean the slash log": the last command said after a correction. */
  const fixes = [...said.matchAll(/\b(?:i mean|i meant|sorry|no|or rather|rather|actually|correction)[\s,.:;!-]+(?:the\s+|a\s+)?(?:slash|\/)[\s,.:;!-]*([a-z]+)\b(.*)$/gi)]
  const fix = fixes.at(-1)
  if (fix && names.has(fix[1].toLowerCase())) return build(fix[1], fix[2], true)

  const body = said.slice((lead ?? flash)![0].length)
  const words = body.split(/\s+/)
  const first = (words[0] ?? '').toLowerCase().replace(/[^a-z?]/g, '')
  if (!first) return null
  if (names.has(first)) return build(first, words.slice(1).join(' '), true)
  if (flash) return null
  const plain = (w: string | undefined): string => (w ?? '').toLowerCase().replace(/[^a-zé]/g, '')
  /* A word Whisper is known to write instead, one word or two. */
  for (const n of [3, 2, 1]) {
    const phrase = words.slice(0, n).map(plain).join(' ')
    const meant = HEARD_AS[phrase]
    if (meant && names.has(meant)) return build(meant, words.slice(n).join(' '), false)
  }
  /* The nearest by spelling, run together where it was split ("the leak"),
     with the first sound weighed: "love" is nearer "move" by letters and
     nearer "log" as said. One clear winner, or nothing. */
  const tries = [
    { text: first, used: 1 },
    { text: `${first}${plain(words[1])}`, used: 2 },
    { text: `${first.replace(/^th/, 'd')}${plain(words[1])}`, used: 2 }
  ].filter((t) => t.text.length >= 3)
  let best: { name: string; cost: number; used: number } | null = null
  let tie = false
  for (const t of tries) {
    for (const name of names.keys()) {
      if (name.length < 3) continue
      const edits = damerau(t.text, name)
      const allowed = t.text.length <= 4 ? 2 : t.text.length <= 7 ? 2 : 3
      if (edits > allowed) continue
      const cost = edits + (t.text[0] === name[0] ? 0 : 1.5) + (t.used - 1) * 0.25
      if (!best || cost < best.cost) {
        best = { name, cost, used: t.used }
        tie = false
      } else if (cost === best.cost && name !== best.name) tie = true
    }
  }
  if (!best || tie || best.cost > 2.5) return null
  return build(best.name, words.slice(best.used).join(' '), false)
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
