/**
 * Text as Magpie should be given it, the last step before it is said.
 *
 * Two things it says wrongly, both heard in a game of hangman:
 *
 * "I guessed O, and then it said no, oh, like it was doing the opera, like
 * no OOOOOOOO" - a letter on its own is read as the sung exclamation, held
 * for as long as Magpie likes. Given the letter's NAME ("oh", "ee", "you")
 * it says it the way a person spelling a word does. Only a letter standing
 * alone is changed: "U.S.", "T-shirt", "O'Brien" and "24H2" are left as
 * they are, and "I" is left, since its name sounds the same.
 *
 * "it said ILL, leave you later... it literally said LL" - an answer written
 * with the typographic apostrophe, "I’ll", which is how models write and how
 * most of Wumpy's own phrases are written. Straight quotes and apostrophes,
 * then, and a contraction in capitals ("I'LL") in ordinary case.
 *
 * Pure, for scripts/check-speakahead.mjs.
 */
export const LETTER_NAMES: Record<string, string> = {
  A: 'ay', B: 'bee', C: 'see', D: 'dee', E: 'ee', F: 'eff', G: 'gee', H: 'aitch', J: 'jay',
  K: 'kay', L: 'el', M: 'em', N: 'en', O: 'oh', P: 'pee', Q: 'cue', R: 'are', S: 'ess', T: 'tee',
  U: 'you', V: 'vee', W: 'double you', X: 'ex', Y: 'why', Z: 'zee'
}

/**
 * Not part of a word, an abbreviation (U.S.), a hyphenation (T-shirt) or a
 * name (O'Brien) - but in quotes ('O', "O") it still stands alone.
 */
const ALONE_BEFORE = String.raw`(?<![\p{L}\p{N}\-])(?<![\p{L}\p{N}]['.])`
const ALONE_AFTER = String.raw`(?![\p{L}\p{N}\-]|['.][\p{L}\p{N}])`

export function forMagpie(text: string): string {
  let out = text
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    // "I'LL", "DON'T": ordinary case, or it is spelled out.
    .replace(/\b([A-Z]+)'([A-Z]{1,3})\b/g, (_all, a: string, b: string) =>
      a === 'I' ? `I'${b.toLowerCase()}` : `${a[0]}${a.slice(1).toLowerCase()}'${b.toLowerCase()}`
    )
    // "two O's": the letter's name, plural.
    .replace(new RegExp(`${ALONE_BEFORE}([A-HJ-Z])'s\\b`, 'gu'), (_all, l: string) => `${LETTER_NAMES[l]}s`)
  /*
   * A on its own is usually the article - "A PC", "A good one" - and is a
   * letter only where no word follows it: at the end, before punctuation,
   * or among other letters and blanks ("_ A _", "A, E and U").
   */
  out = out.replace(
    new RegExp(`${ALONE_BEFORE}A${ALONE_AFTER}(?=\\s*(?:$|[,.!?;:)"']|(?:[A-Z]|blank|_)(?![\\p{L}\\p{N}])))`, 'gu'),
    LETTER_NAMES.A
  )
  out = out.replace(new RegExp(`(?<=\\b(?:letter|letters|blank)\\s+)A(?![\\p{L}\\p{N}])`, 'gu'), LETTER_NAMES.A)
  out = out.replace(new RegExp(`${ALONE_BEFORE}([B-HJ-Z])${ALONE_AFTER}`, 'gu'), (_all, l: string) => LETTER_NAMES[l])
  return out
}
