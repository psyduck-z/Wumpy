/**
 * Measuring a wall of text, and deciding when to fold it away.
 *
 * Two things produce one: a model writing a whole program, and a person
 * pasting a log into the box. Both turn the panel into a scroll bar - the
 * transcript is 460px wide and a 300-line file in it buries the sentence that
 * explains the file. Folding it to a line that says how big it is keeps the
 * answer readable and the text one click away.
 *
 * The thresholds are in here rather than in the components so that both ends
 * agree, and so they can be argued with in one place.
 */

const LF = String.fromCharCode(10)

export interface Bulk {
  words: number
  lines: number
  chars: number
}

export function measure(text: string): Bulk {
  const body = text.replace(/\s+$/, '')
  return {
    words: body.trim() ? body.trim().split(/\s+/).length : 0,
    lines: body ? body.split(LF).length : 0,
    chars: body.length
  }
}

/** "1,234 words, 68 lines", as it reads on the fold. */
export function summarise(text: string): string {
  const { words, lines } = measure(text)
  const n = (v: number): string => v.toLocaleString('en-US')
  return `${n(words)} word${words === 1 ? '' : 's'}, ${n(lines)} line${lines === 1 ? '' : 's'}`
}

/**
 * Code the model wrote, folded when it stops being readable in place.
 *
 * 30 lines is about a panel and a half. Short enough that a function still
 * shows in full, long enough that nothing routine gets hidden.
 */
export const CODE_LINES = 30
export const CODE_CHARS = 2000

export function foldsCode(text: string): boolean {
  const { lines, chars } = measure(text)
  return lines > CODE_LINES || chars > CODE_CHARS
}

/**
 * A paste, folded sooner than code is.
 *
 * Lower on purpose: an eight-line paste has already pushed the composer over
 * half the panel, and unlike code in a reply there is nothing to read in it -
 * the user knows what they just pasted. The text is kept whole and sent
 * whole; only the display is folded.
 */
export const PASTE_LINES = 8
export const PASTE_CHARS = 600

export function foldsPaste(text: string): boolean {
  const { lines, chars } = measure(text)
  return lines > PASTE_LINES || chars > PASTE_CHARS
}

/** What a folded paste looks like in the box. */
export function pasteMarker(index: number): string {
  return `[pasted #${index + 1}]`
}

/**
 * Puts the real text back before anything is sent.
 *
 * The markers are what the user sees and edits; the model must get what was
 * actually pasted. Substitution happens once, at send, so editing around a
 * marker works normally.
 */
export function expandPastes(text: string, pastes: readonly string[]): string {
  let out = text
  pastes.forEach((body, i) => {
    out = out.split(pasteMarker(i)).join(body)
  })
  return out
}
