/**
 * Turning a model's suggested chat title into something fit for a sidebar.
 *
 * Kept apart from the Electron main process so it can be tested directly; the
 * repairs here were all written in response to real output, not imagined.
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
