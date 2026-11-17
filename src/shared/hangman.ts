/**
 * Hangman, worked out by Wumpy rather than by the model.
 *
 * "We were playing hangman and I told it to give me a word with vowels, but
 * it kept on saying that no vowels. So fix that core logic, like the core
 * logic in the verification." The word now survives in a <keep> note (see
 * @shared/kept), and with it the model answers yes and no correctly - but it
 * still draws the board wrong. Measured on Nemotron 3.5 Super: "Yes, there's
 * an E. It's the fifth letter: _ _ _ E _ _". Counting underscores is the
 * one thing it cannot do, and it is the one thing code cannot get wrong.
 *
 * So once a word is in its note, every guess they make is matched here -
 * the letter, from "is there an E?", "E", "oh", "the letter you" - and the
 * board, the hits and the misses are handed to the model to say as given.
 *
 * Pure, for scripts/check-skills.mjs.
 */
export interface Said {
  role: string
  content: string
}

/* A letter as speech recognition writes it: "oh", "you", "see"... */
const SPOKEN: Record<string, string> = {
  ay: 'A', aye: 'A', bee: 'B', be: 'B', see: 'C', sea: 'C', dee: 'D', ee: 'E', eh: 'E', ef: 'F', eff: 'F',
  gee: 'G', aitch: 'H', eye: 'I', jay: 'J', kay: 'K', el: 'L', em: 'M', en: 'N', oh: 'O', owe: 'O',
  pee: 'P', pea: 'P', cue: 'Q', queue: 'Q', are: 'R', ar: 'R', ess: 'S', tea: 'T', tee: 'T', you: 'U',
  vee: 'V', 'double you': 'W', ex: 'X', why: 'Y', zee: 'Z', zed: 'Z'
}
const LETTER = `([a-z]|${Object.keys(SPOKEN).sort((a, b) => b.length - a.length).join('|')})`
/* Only a short message that is a guess: "you pick the word" is not a U. */
const GUESS = new RegExp(
  `^(?:(?:ok(?:ay)?|um+|uh+|hmm+|so|then|and)\\s+)*` +
    `(?:(?:is there|are there|is it|has it|does it have|do you have|have you got|any|what about|how about|guess|try|i guess|i'll guess|i will guess|my guess is|the letter|letter)\\s+)*` +
    `(?:(?:an?|the letter|letter)\\s+)?${LETTER}(?:'?s)?` +
    `(?:\\s+(?:in it|in there|in the word|please|then))?$`
)

/** The letter a message guesses, or null. */
export function guessIn(text: string): string | null {
  const said = (text ?? '')
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[?!.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = GUESS.exec(said)
  if (!m) return null
  const l = m[1]
  return l.length === 1 ? l.toUpperCase() : (SPOKEN[l] ?? null)
}

/** The word in a <keep> note: "word: PLANET", "WORD = planet". */
function wordIn(content: string): string | null {
  const kept = /<keep>([\s\S]*?)(?:<\/keep>|$)/i.exec(content)?.[1]
  const word = kept ? /\bword\s*[:=-]\s*"?([a-z]{3,})/i.exec(kept)?.[1] : null
  return word ? word.toUpperCase() : null
}

/**
 * The game in these messages, if one is going: the word the model chose, the
 * letters guessed since, which are in it, and the board they make.
 */
export function hangmanState(messages: readonly Said[]): {
  word: string
  guessed: string[]
  hits: string[]
  misses: string[]
  board: string
} | null {
  let word: string | null = null
  let from = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    const w = wordIn(messages[i].content)
    if (!w) continue
    if (word && w !== word) break
    word = w
    from = i
  }
  if (!word) return null
  const guessed: string[] = []
  for (const m of messages.slice(from + 1)) {
    if (m.role !== 'user') continue
    const g = guessIn(m.content)
    if (g && !guessed.includes(g)) guessed.push(g)
  }
  const hits = guessed.filter((g) => word!.includes(g))
  const misses = guessed.filter((g) => !word!.includes(g))
  const board = [...word].map((c) => (guessed.includes(c) ? c : '_')).join(' ')
  return { word, guessed, hits, misses, board }
}

/** What the model is told, on a turn that is a guess. */
export function hangmanFacts(messages: readonly Said[]): string[] {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const guess = last ? guessIn(last.content) : null
  if (!guess) return []
  const s = hangmanState(messages)
  if (!s) return []
  const places = [...s.word].flatMap((c, i) => (c === guess ? [i + 1] : []))
  const won = !s.board.includes('_')
  return [
    `- Hangman, worked out by Wumpy from the word in your note (${s.word}): their guess is ${guess}, which is ` +
      (places.length ? `in it, at place ${places.join(' and ')}.` : 'not in it.') +
      ` Guessed so far: ${s.guessed.join(', ')}. Misses: ${s.misses.length ? `${s.misses.join(', ')} (${s.misses.length})` : 'none'}.` +
      ` The board is now "${s.board}" - show exactly that, and do not work it out again.` +
      (won ? ' That is the whole word: they have won.' : '')
  ]
}
