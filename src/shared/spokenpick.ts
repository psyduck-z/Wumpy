/**
 * Choosing out loud: a model, a chat, any list Wumpy reads into the earbuds.
 *
 * Asked for in these words: "when I say slash model, it's going to tell me
 * quickly... the top three overall for balanced, and then the smartest and
 * the fastest... and then when I say it, it's going to roughly estimate
 * which model I'm trying to link to. If there's two Nemotrons and I just say
 * Nemotron, then it's going to preview all of the Nemotrons ranked."
 *
 * So a spoken answer is matched the way a person would match it, not the way
 * a picker filters. Nobody says "nvidia/nemotron-3.5-super-vl-120b-a12b"; they
 * say "Nemotron super", or "the Nemotron", or "the second one", and the
 * recogniser writes what it heard - "Jemma" for Gemma, "deep seek" for
 * DeepSeek, "five point three" for 5.3. Every one of those has to land.
 *
 * And a vague answer is not guessed at. "Nemotron" names four models here;
 * picking the first would be confident and wrong a quarter of the time, so it
 * comes back as all four, best first, to be asked about again.
 *
 * Pure, so the whole thing is checked without a microphone.
 */
import { damerau } from './nearest'

/** Something that can be picked: its id and every name it answers to. */
export interface Pickable {
  id: string
  /** The label first; then anything else it may be called ("fastest"). */
  names: string[]
}

const UNITS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen'
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/**
 * Number words to digits, the way a recogniser that spells numbers out
 * would need them: "five point three" -> "5.3", "thirty one" -> "31",
 * "five fifty" stays "5 50" (there is no reading it as 550 that is not also
 * a guess).
 */
export function digitsFor(text: string): string {
  const words = text.split(/\s+/)
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const unit = UNITS.indexOf(w)
    const ten = TENS.indexOf(w)
    if (ten >= 2) {
      const next = UNITS.indexOf(words[i + 1] ?? '')
      if (next >= 1 && next <= 9) {
        out.push(String(ten * 10 + next))
        i++
      } else out.push(String(ten * 10))
      continue
    }
    if (unit >= 0) {
      out.push(String(unit))
      continue
    }
    if (w === 'point' && out.length && /^\d+$/.test(out[out.length - 1])) {
      const next = words[i + 1] ?? ''
      const after = UNITS.indexOf(next)
      if (after >= 0 && after <= 9) {
        out[out.length - 1] += `.${after}`
        i++
        continue
      }
      if (/^\d+$/.test(next)) {
        out[out.length - 1] += `.${next}`
        i++
        continue
      }
    }
    out.push(w)
  }
  return out.join(' ')
}

/** Lower case, punctuation gone, numbers as digits. */
export function normaliseSpoken(text: string): string {
  const plain = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return digitsFor(plain)
}

/**
 * The pieces a name is matched on: words and numbers apart, so "gemma4"
 * is gemma and 4, "120b" is 120, "v4.1" is 4 and 1. Single letters go -
 * the b of 120b and the a of a12b are not what anybody says.
 */
export function tokensOf(name: string): string[] {
  return normaliseSpoken(name)
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[\s.]+/)
    .filter((t) => t.length > 1 || /\d/.test(t))
}

/** Words that carry no name: "switch to the Gemma model, please". */
const FILLER = new Set([
  'the', 'a', 'an', 'to', 'use', 'using', 'switch', 'change', 'set', 'pick', 'choose', 'select',
  'model', 'models', 'please', 'one', 'that', 'this', 'it', 'go', 'with', 'for', 'me', 'i', 'want',
  'id', 'like', 'lets', 'let', 'try', 'okay', 'ok', 'uh', 'um', 'erm', 'hmm', 'and', 'of', 'chat',
  'conversation', 'called', 'named', 'about', 'on', 'my', 'is', 'just', 'wumpy', 'open', 'resume',
  'back', 'into', 'in'
])

/** Close enough to be the same word misheard: one slip in five letters, two in eight. */
function near(heard: string, name: string): boolean {
  if (heard.length < 5 || name.length < 5) return false
  const allowed = heard.length >= 8 ? 2 : 1
  return damerau(heard, name) <= allowed
}

interface Score {
  id: string
  score: number
  /** Every piece of the label was said, so nothing about it is left open. */
  whole: boolean
}

function scoreOne(heard: string[], option: Pickable): Score {
  const label = tokensOf(option.names[0] ?? '')
  const all = new Set(option.names.flatMap(tokensOf))
  // "deep seek" for DeepSeek, "step fun" for StepFun: two heard words that
  // are one name word.
  const pieces = [...heard]
  for (let i = 0; i + 1 < heard.length; i++) pieces.push(heard[i] + heard[i + 1])

  let score = 0
  let words = 0
  const said = new Set<string>()
  for (const piece of pieces) {
    const digits = /^\d+$/.test(piece)
    if (all.has(piece)) {
      score += digits ? 0.5 : 1
      if (!digits) words++
      said.add(piece)
      continue
    }
    if (digits) continue
    const close = [...all].find((t) => near(piece, t))
    if (close) {
      score += 0.8
      words++
      said.add(close)
    }
  }
  // A number on its own is not a name: "4" must not choose gemma4.
  if (words === 0) return { id: option.id, score: 0, whole: false }
  return { id: option.id, score, whole: label.length > 0 && label.every((t) => said.has(t)) }
}

/**
 * Which of `options` the words name: none, exactly one, or several equally.
 *
 * Several comes back best first in the order given, which is the order the
 * caller ranked them in - so "Nemotron" lists the Nemotrons by how good they
 * are, as asked. When several tie and exactly one of them was named in full
 * ("GLM 5.3", against GLM 5.3 and GLM 5.3 Flash), that one is meant.
 */
export function matchSpoken(heard: string, options: readonly Pickable[]): string[] {
  const words = tokensOf(dropPronounOne(heard)).filter((w) => !FILLER.has(w))
  if (!words.length) return []
  const scored = options.map((o) => scoreOne(words, o)).filter((s) => s.score > 0)
  if (!scored.length) return []
  const best = Math.max(...scored.map((s) => s.score))
  const top = scored.filter((s) => s.score === best)
  if (top.length > 1) {
    const whole = top.filter((s) => s.whole)
    if (whole.length === 1) return [whole[0].id]
  }
  return top.map((s) => s.id)
}

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4,
  '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10, top: 1
}

/**
 * "That one", "the Nemotron one", "the first one": the trailing "one" is a
 * pronoun, not the number 1, and left in it would be read as a model
 * number. Kept after a number word ("twenty one") and after "number".
 */
function dropPronounOne(text: string): string {
  return text.toLowerCase().replace(/\b([a-z]+)\s+one\b(?!\s+point)/g, (all, word: string) =>
    UNITS.includes(word) || TENS.includes(word) || word === 'number' || word === 'option'
      ? all
      : word
  )
}

const PLACE_FILLER = new Set(['the', 'please', 'number', 'option', 'model', 'chat', 'go', 'with', 'pick', 'its', 'it', 'that', 'this', 'say', 'i'])

/**
 * "The second one", "number three", "three", "the last one": a place in the
 * list just read out, 0-based, or null. Only a short answer counts - "the
 * second Nemotron" is a name with a number in it, and is matched as one.
 */
export function placeIn(heard: string, count: number): number | null {
  const words = normaliseSpoken(dropPronounOne(heard))
    .split(' ')
    .filter((w) => w && !PLACE_FILLER.has(w))
  if (words.length !== 1) return null
  const word = words[0]
  if (word === 'last' || word === 'bottom') return count ? count - 1 : null
  const n = ORDINALS[word] ?? (/^\d+$/.test(word) ? Number(word) : NaN)
  if (!Number.isInteger(n) || n < 1 || n > count) return null
  return n - 1
}

/** "Cancel", "never mind", "forget it": leave it as it is. */
export function isCancel(heard: string): boolean {
  const said = normaliseSpoken(heard)
    .replace(/\b(please|thanks|thank you|wumpy|okay|ok|just)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /^(cancel|never ?mind|forget (it|about it)|none|none of them|neither|nothing|stop|leave it|no thanks|skip|skip it|exit|quit that)$/.test(
    said
  )
}

/** "A, B, and C" - a list as it is said, not as it is printed. */
export function spokenList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} or ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`
}

/** "A, B, and C", for lists that are being told rather than offered. */
export function spokenAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/**
 * A model's label as it should be said: "Gemma 4 31B (Ollama cloud)" is
 * "Gemma 4 31 B" - the provider in brackets is for the screen, and "31B"
 * run together comes out of a speech engine as one strange word.
 */
export function sayModel(label: string): string {
  return label
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\bVL\b/g, 'V L')
    .replace(/(\d)B\b/g, '$1 B')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Why a model made the short list, which is also how it is introduced. */
export type ShortWhy = 'balanced' | 'smartest' | 'fastest'

export interface ShortEntry {
  id: string
  why: ShortWhy
  /**
   * For the smartest and the fastest: false when the real top of that list
   * was already among the balanced three, so this is the best of the rest.
   */
  top: boolean
}

/**
 * The five read out for `/model`: the three best balanced, then the
 * smartest and the fastest. Five different models - when the smartest is
 * already one of the three, the next smartest takes its place and is
 * introduced as such, so nothing is said twice and nothing is mislabelled.
 */
export function modelShortlist(
  balanced: readonly string[],
  smarts: readonly string[],
  speed: readonly string[]
): ShortEntry[] {
  const list: ShortEntry[] = balanced.slice(0, 3).map((id) => ({ id, why: 'balanced', top: true }))
  const taken = (id: string): boolean => list.some((e) => e.id === id)
  for (const [why, order] of [
    ['smartest', smarts],
    ['fastest', speed]
  ] as const) {
    const pick = order.find((id) => !taken(id))
    if (pick) list.push({ id: pick, why, top: order[0] === pick })
  }
  return list
}

/** The sentence that reads the short list out. */
export function shortlistSpeech(entries: readonly ShortEntry[], nameOf: (id: string) => string): string {
  const balanced = entries.filter((e) => e.why === 'balanced').map((e) => sayModel(nameOf(e.id)))
  const parts: string[] = []
  if (balanced.length) parts.push(`Best overall: ${spokenAnd(balanced)}.`)
  for (const e of entries) {
    if (e.why === 'balanced') continue
    const what = e.why === 'smartest' ? 'smartest' : 'fastest'
    parts.push(e.top ? `The ${what}: ${sayModel(nameOf(e.id))}.` : `Next ${what}: ${sayModel(nameOf(e.id))}.`)
  }
  return parts.join(' ')
}

const COUNT_WORDS = UNITS.slice(1, 13).map((w) => w[0].toUpperCase() + w.slice(1))

/**
 * A numbered list, said: "One, Fish pie. Two, Taxes." Up to `max`, then how
 * many more there are - a long history read out in full is minutes of
 * titles, and every one of them can still be asked for by name.
 */
export function numberedSpeech(items: readonly string[], max = 12): string {
  const shown = items.slice(0, Math.min(max, COUNT_WORDS.length))
  const said = shown.map((t, i) => `${COUNT_WORDS[i]}, ${t.replace(/[.!?]+$/, '')}.`).join(' ')
  const rest = items.length - shown.length
  return rest > 0 ? `${said} And ${rest} older.` : said
}
