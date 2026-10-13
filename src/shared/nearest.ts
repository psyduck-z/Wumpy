/**
 * The closest thing to what was typed.
 *
 * `Unknown command /mdoel. Type /help to see them all.` is true, unhelpful,
 * and sends you to a table of twenty-seven commands to find the one you were
 * already trying to type. The answer is nearly always one keystroke away and
 * the app is holding the list, so it can say which.
 *
 * Damerau rather than plain Levenshtein, because the most common typo is two
 * letters swapped - "mdoel", "qouta", "corss" - and ordinary edit distance
 * scores a transposition as two edits, which puts it over the threshold for a
 * short word. Measured over the real command list: "mdoel" scores 2 by
 * Levenshtein and 1 by Damerau, and 2 is also the distance from "mdoel" to
 * "model" the suggestion has to beat to be worth printing.
 *
 * The thresholds matter more than the algorithm. A suggester that offers
 * something for every mistake is worse than one that stays quiet, because
 * "did you mean /new?" after a typo for a command that does not exist sends
 * the user somewhere they did not want to go - so the tolerance is tied to
 * the length of what was typed, and nothing is offered when the nearest thing
 * is not close.
 *
 * Pure and about anything named: commands today, and it is the same question
 * for a model name or a subcommand.
 */

/** Anything with a name and possibly other names for the same thing. */
export interface Named {
  name: string
  aliases?: readonly string[]
}

/**
 * Edit distance, counting a swap of two neighbours as one edit.
 *
 * Optimal string alignment, which is Damerau-Levenshtein without allowing the
 * same pair to be edited twice. That distinction cannot arise for words of
 * this length and the simpler table is easier to be sure of.
 */
export function damerau(a: string, b: string): number {
  const first = a.toLowerCase()
  const second = b.toLowerCase()
  if (first === second) return 0
  if (!first.length) return second.length
  if (!second.length) return first.length

  /* Three rows are enough: the current one, the one before, and the one
     before that - which is the only reason a transposition can be seen. */
  let twoBack: number[] = []
  let back: number[] = Array.from({ length: second.length + 1 }, (_, i) => i)
  let row: number[] = []

  for (let i = 1; i <= first.length; i++) {
    row = [i]
    for (let j = 1; j <= second.length; j++) {
      const cost = first[i - 1] === second[j - 1] ? 0 : 1
      let best = Math.min(back[j] + 1, row[j - 1] + 1, back[j - 1] + cost)
      if (i > 1 && j > 1 && first[i - 1] === second[j - 2] && first[i - 2] === second[j - 1]) {
        best = Math.min(best, twoBack[j - 2] + 1)
      }
      row.push(best)
    }
    twoBack = back
    back = row
  }
  return back[second.length]
}

/**
 * How wrong a word may be and still be recognisable.
 *
 * Tied to length because one edit in three letters is a different word, while
 * two edits in nine is a typo. The numbers are the conservative end on
 * purpose: a wrong suggestion costs more than no suggestion.
 */
export function tolerance(length: number): number {
  if (length <= 3) return 1
  if (length <= 6) return 2
  return 3
}

/**
 * A prefix counts as better than any single edit.
 *
 * "/mod" is not a typo for "/model", it is an abbreviation, and an edit
 * distance of three would reject it while the user is obviously most of the
 * way to typing it. Scored below 1 so it wins against a one-edit rival, and
 * above 0 so an exact match still wins against it.
 */
const PREFIX_SCORE = 0.5

/** Two letters is the least that can point at one thing. */
const MIN_PREFIX = 2

interface Scored {
  name: string
  score: number
  /** The spelling that matched, when it was an alias rather than the name. */
  via: string
}

function scoreAgainst(typed: string, spelling: string): number | null {
  const word = spelling.toLowerCase()
  if (!word) return null
  if (word === typed) return 0
  if (typed.length >= MIN_PREFIX && word.startsWith(typed)) return PREFIX_SCORE
  /*
   * And the other way round, for typing PAST the end of it.
   *
   * "/screenshoot" is five edits from "/screen" and obviously means it. The
   * command has to be at least two characters for this, or every long word
   * would reach a two-letter command.
   */
  if (word.length >= MIN_PREFIX && typed.startsWith(word)) return PREFIX_SCORE

  const distance = damerau(typed, word)
  /*
   * Both lengths get a say. Without the second test, a four-letter typo
   * reaches a two-letter command by deleting most of itself, which is how a
   * suggester ends up recommending something unrelated with confidence.
   */
  const allowed = Math.min(tolerance(typed.length), tolerance(word.length))
  if (distance > allowed) return null
  // Nothing is "nearly" a word it shares almost no letters with.
  if (distance >= word.length) return null
  return distance
}

/**
 * The best match for what was typed, or null when nothing is close.
 *
 * Ties go to whichever came first in the list, so the answer is the same
 * every time and the caller decides what "first" means by ordering its own
 * list - for commands that is the order they are declared in, which is
 * roughly how often they are used.
 */
export function nearest(typed: string, candidates: readonly Named[]): Scored | null {
  const word = (typed ?? '').trim().toLowerCase()
  if (!word) return null

  /*
   * A prefix that can only mean one thing wins at any length.
   *
   * "/n" is two edits from "new", which is over the threshold for a
   * two-letter word - and there is only one command beginning with n, so
   * there is nothing to be wrong about. One letter is a guess only when
   * several commands start with it, and then nothing is offered: "/c" could
   * be chats, compact or cmd and picking one would send the user somewhere
   * they did not ask for.
   */
  const spellings = (c: Named): string[] => [c.name, ...(c.aliases ?? [])]
  const starts = candidates.filter((c) =>
    spellings(c).some((s) => s.toLowerCase().startsWith(word))
  )
  if (starts.length === 1) {
    const via = spellings(starts[0]).find((s) => s.toLowerCase().startsWith(word)) ?? starts[0].name
    return { name: starts[0].name, score: word === via.toLowerCase() ? 0 : PREFIX_SCORE, via }
  }

  let best: Scored | null = null
  for (const candidate of candidates) {
    for (const spelling of [candidate.name, ...(candidate.aliases ?? [])]) {
      const score = scoreAgainst(word, spelling)
      if (score === null) continue
      if (best && score >= best.score) continue
      best = { name: candidate.name, score, via: spelling }
    }
  }
  return best
}

/** Just the name, for callers that do not care how close it was. */
export function nearestName(typed: string, candidates: readonly Named[]): string | null {
  return nearest(typed, candidates)?.name ?? null
}
