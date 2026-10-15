/**
 * Folding the search away, so the answer is what you see.
 *
 * Asked an analogy question and then an anagram, Wumpy "started listing out
 * all the freaking possibilities" — and then ran into the output cap
 * part-way through the list, so the user got the search and not the answer.
 * Their ask, in their words: "if it's gonna try to do that even so, which I
 * would not recommend, at least compact it, saying like searching patterns."
 *
 * Both halves are worth doing and they are different jobs. Not doing it is
 * the model's to learn, and the instructions say so. This is the other half,
 * which does not depend on the model learning anything: when an answer turns
 * into a run of attempts, the transcript shows one line saying so, with the
 * attempts behind it for anyone who wants them.
 *
 * The bar for folding is deliberately high. A single "let me check that" is
 * someone thinking out loud for a sentence, which reads fine; three in a row
 * with no conclusion between them is the failure. Anything that does not
 * clear the bar is returned as one segment holding the original text, so the
 * overwhelming majority of answers render exactly as they did before.
 *
 * Pure, and fence-aware: a code block can hold blank lines and the word
 * "wait", and cutting one in half would turn a command card into grey text.
 */

export interface Segment {
  /** True when this is a run of attempts, to be shown collapsed. */
  working: boolean
  body: string
  /** Non-blank lines inside it, for the summary line. */
  lines: number
}

/**
 * The shapes an abandoned attempt takes.
 *
 * Taken from the real one rather than imagined. The reply that prompted
 * this contained, in order: "RETAOL, which rearranges to ALTERO (not a
 * word)", "Actually, if you replace...", "Wait, that's two letters.",
 * "Let's try ALTER...", "That's 7 letters.", "Let me re-examine the
 * options.", "Is it ALTER? No, that's not an option.", "Could it be RETAIL
 * -> RELATE?".
 *
 * Each marker is a sentence that only appears while someone is still
 * looking: a candidate being rejected, a count being taken, a restart. None
 * of them is how a finished answer begins.
 */
const ATTEMPT: readonly RegExp[] = [
  /^(wait|hmm+|actually|hold on|oh)\b/i,
  /^(let me|let's|lets)\s+(try|see|re-?examine|check|think|work|look)/i,
  /^(could it be|is it|what about|how about|maybe it'?s|perhaps it'?s)\b/i,
  /\(not a word\)/i,
  /\bthat'?s\s+(not\s+)?(an?\s+)?\d+\s+letters?\b/i,
  /\(\d+\s+letters?\)/i,
  /\bno,?\s+that'?s\s+not\b/i,
  /\bdoes\s+not\s+work\b|\bdoesn'?t\s+work\b/i,
  /\brearranges?\s+to\b/i,
  /\s->\s/
]

/** Attempts in a row before the run is worth hiding. */
export const FOLD_AT = 3

const NL = String.fromCharCode(10)

/** Whether a paragraph is somebody still looking rather than answering. */
export function isAttempt(paragraph: string): boolean {
  const body = paragraph.trim()
  if (!body) return false
  // A fenced block is never an attempt, whatever it says inside.
  if (body.startsWith('```')) return false
  // Long prose is an explanation that happens to contain the word. The
  // attempts this folds are one or two sentences each.
  if (body.length > 400) return false
  return ATTEMPT.some((re) => re.test(body))
}

/**
 * Splits text into paragraphs, keeping fenced blocks whole.
 *
 * A ``` block is one paragraph however many blank lines it contains, which
 * is what stops a wumpy-run card being cut in half by the fold.
 */
function paragraphs(text: string): string[] {
  const out: string[] = []
  let buffer: string[] = []
  let fenced = false

  const flush = (): void => {
    if (buffer.length) out.push(buffer.join(NL))
    buffer = []
  }

  for (const line of text.split(NL)) {
    if (/^\s*```/.test(line)) {
      // The opening fence starts a paragraph; the closing one ends it.
      if (!fenced) flush()
      buffer.push(line)
      fenced = !fenced
      if (!fenced) flush()
      continue
    }
    if (!fenced && !line.trim()) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return out
}

/**
 * The answer, with runs of attempts marked for folding.
 *
 * Returns a single plain segment when there is nothing to fold, so the
 * ordinary path through the renderer is the one it has always been.
 */
export function foldWorking(text: string): Segment[] {
  if (!text.trim()) return [{ working: false, body: text, lines: 0 }]

  const parts = paragraphs(text)
  const marks = parts.map(isAttempt)

  /* Runs are found before anything is built, because the decision is about
     the run and not about the paragraph: two attempts between two answers
     are a train of thought, six are a search. */
  const folded = new Array<boolean>(parts.length).fill(false)
  let run = 0
  for (let i = 0; i <= parts.length; i++) {
    if (i < parts.length && marks[i]) {
      run += 1
      continue
    }
    if (run >= FOLD_AT) for (let j = i - run; j < i; j++) folded[j] = true
    run = 0
  }
  if (!folded.some(Boolean)) return [{ working: false, body: text, lines: 0 }]

  const segments: Segment[] = []
  for (let i = 0; i < parts.length; i++) {
    const last = segments[segments.length - 1]
    if (last && last.working === folded[i]) {
      last.body = `${last.body}${NL}${NL}${parts[i]}`
      continue
    }
    segments.push({ working: folded[i], body: parts[i], lines: 0 })
  }
  for (const segment of segments) {
    segment.lines = segment.body.split(NL).filter((l) => l.trim()).length
  }
  return segments
}

/**
 * What the collapsed line says.
 *
 * Their words, near enough: "at least compact it, saying like searching
 * patterns". The count is there so the line says how much is behind it -
 * three lines is a thought and twenty is the thing they objected to, and
 * the difference should be visible without opening it.
 */
export function foldLabel(lines: number): string {
  return `Working through possibilities · ${lines} line${lines === 1 ? '' : 's'}`
}
