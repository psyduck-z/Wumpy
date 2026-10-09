/**
 * Turning a model's suggested chat title into something fit for a sidebar.
 *
 * Pure, and shared: the main process repairs what the model wrote, the
 * renderer decides when to ask for a new one. Every repair here was written
 * in response to real output, not imagined.
 */

/**
 * Small models like to wrap titles in quotes, prefix them with "Title:", add a
 * full stop, SHOUT, or split a word in half. Strip all of that, then repair the
 * result against the question it came from.
 */
export function cleanTitle(raw: string, question: string): string | null {
  let t = raw.split('\n').find((l) => l.trim()) ?? ''
  t = t.replace(/^\s*(?:title|topic|chat|name)\s*[:\-]\s*/i, '')
  t = t.replace(/^["'“‘`]+|["'”’`]+$/g, '')
  t = t.replace(/[.\s]+$/, '').trim()
  if (!t) return null

  const words = t.split(/\s+/)
  if (words.length > 8) t = words.slice(0, 7).join(' ')

  // A title entirely in capitals is the model shouting, not an acronym.
  if (!/[a-z]/.test(t)) t = t.toLowerCase()

  return titleCase(rejoinSplitWords(t, question)).slice(0, 60).trim()
}

/**
 * Puts back together a word the model split in half.
 *
 * Observed: "what are all the ollama ai models i have locally" came back titled
 * "OLLA MA AI MODELS". Every word of a title should appear in the question it
 * describes, so a word that does not is tried joined to the one after it —
 * "olla" + "ma" is "ollama", which does appear, so they are merged.
 */
function rejoinSplitWords(title: string, question: string): string {
  // Whole words, not a de-spaced blob: "olla" appears *inside* "ollama", so a
  // substring test would decide it was already a real word and merge nothing.
  const asked = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )
  if (asked.size === 0) return title

  const words = title.split(/\s+/)
  const out: string[] = []

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const bare = word.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const next = words[i + 1]

    // Short fragments only: a real word the model chose that simply is not in
    // the question must never be glued to its neighbour.
    if (next && bare.length > 0 && bare.length <= 5 && !asked.has(bare)) {
      const merged = bare + next.toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (asked.has(merged)) {
        out.push(word + next)
        i++
        continue
      }
    }
    out.push(word)
  }
  return out.join(' ')
}

/** Minor words stay lowercase unless they lead. */
const MINOR = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'vs', 'with'])

/** Written in capitals even when the user typed them in lower case. */
const ACRONYMS = new Set([
  'ai',
  'api',
  'cli',
  'cpu',
  'css',
  'gpu',
  'html',
  'http',
  'ide',
  'json',
  'os',
  'pc',
  'ram',
  'sdk',
  'sql',
  'ssd',
  'ui',
  'url',
  'usb',
  'xml'
])

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word, i) => {
      // Leave anything already carrying a capital alone, so CSS, Win+C and
      // llama3.2 survive intact.
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase()
      if (/[A-Z0-9]/.test(word)) return word
      if (i > 0 && MINOR.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

/**
 * When a conversation is worth renaming again.
 *
 * A title fixed from the opening question is wrong by the fourth one: ask
 * about Spotify, end up on the firewall, and the sidebar still says Spotify.
 * Retitling every turn is the other failure - the name flickers while the
 * user is reading it, and each change costs a call.
 *
 * So the gaps double: 1, 2, 4, 8, 16, 32 user turns. Early on the title
 * follows the conversation almost message by message, because two questions
 * in there is little to go on and the topic really is still moving. By turn
 * 32 it changes once in 32, having read the whole thing. That is the
 * confidence the user asked for - not a claim the model makes, just a name
 * that stops moving once there is enough to name.
 *
 * Takes the turn count it was last titled at rather than a list of
 * thresholds, so a chat resumed from history with five turns already in it
 * lands on the next threshold up instead of never qualifying again.
 */
export function shouldRetitle(userTurns: number, titledAtTurns: number): boolean {
  if (userTurns < 1) return false
  return userTurns >= nextThreshold(titledAtTurns)
}

/** The smallest power of two strictly greater than `turns`, and 1 for none. */
function nextThreshold(turns: number): number {
  let n = 1
  while (n <= turns) n *= 2
  return n
}

/**
 * How many user turns a title should be built from.
 *
 * All of them, oldest first, but capped: the background model is the small
 * one and a long chat would otherwise send it everything every time.
 */
export function titleSource(questions: string[], budget = 1200): string {
  const kept: string[] = []
  let used = 0
  for (const q of questions) {
    const line = q.trim().replace(/\s+/g, ' ').slice(0, 300)
    if (!line) continue
    // The newline that will join it counts too, or forty questions overshoot
    // the budget by thirty-nine characters. A check caught that.
    const cost = line.length + (kept.length === 0 ? 0 : 1)
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  return kept.join(String.fromCharCode(10))
}

/**
 * What the background model is told to do.
 *
 * Lives here rather than inline at the call site so a check can measure the
 * real instruction instead of a copy of it that drifts.
 *
 * One question is all there is to name. Several means the opener may be the
 * least of it - the thing to name is what they keep coming back to, not the
 * first thing they happened to ask.
 */
export function titleBrief(questionCount: number): string {
  const task =
    questionCount <= 1
      ? 'Name the topic of the user’s question in 2 to 5 words, as a noun phrase.'
      : 'These are the questions one person asked in one conversation, oldest first. ' +
        'Name what the conversation is mostly about in 2 to 5 words, as a noun phrase. ' +
        'Weigh the whole thing, not the first line; ignore a one-off aside.'
  return task + ' Reply with the name only. No quotes, no punctuation at the end, no preamble.'
}
