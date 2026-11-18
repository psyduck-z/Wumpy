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
import type { Ordering } from './order'

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
  'back', 'into', 'in',
  /* "Slash model", said while the list was being read, was one slip from
     "flash" and chose GLM 5.3 Flash. Nothing is called slash. */
  'slash'
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

/**
 * "The smartest one", "the most intelligent model", "best overall", "a
 * generally efficient model", "the quickest": which of the rankings a spoken
 * answer asks for the top of. Asked for in these words: "allow me to say the
 * smartest one, or like smartest model, or like most intelligent model...
 * the fastest model, quickest model, and also the best overall model,
 * generally efficient model".
 *
 * Words, not a list of sentences, so the ways nobody wrote down land too:
 * "the brainiest", "lowest latency", "the most capable one". Both kinds of
 * speed and smarts at once - "fast and smart" - is the balanced ranking,
 * which is exactly that trade. `rest` is whatever else was said, after the
 * words that carry no name: empty means the ranking is the whole answer,
 * and "the fastest Nemotron" leaves "nemotron" to be matched with it.
 */
const ORDER_WORDS: ReadonlyArray<readonly [Ordering, RegExp]> = [
  [
    'smarts',
    /\b(?:smart(?:est|er)?|clever(?:est|er)?|intelligen(?:t|ce)|brain(?:y|ier|iest)|bright(?:er|est)?|capable|powerful|strong(?:er|est)|genius|wis(?:e|er|est)|accura(?:te|cy)|(?:highest |best |top )?quality)\b/g
  ],
  [
    'speed',
    /\b(?:fast(?:est|er)?|quick(?:est|er)?|speed(?:y|ier|iest)?|rapid|swift(?:est|er)?|snapp(?:y|ier|iest)|responsive|(?:low(?:est)? )?latency|instant)\b/g
  ],
  [
    'balanced',
    /\b(?:best(?: overall| all ?round(?:er)?)?|overall|balanced|recommended|default|efficient|efficiency|general(?:ly)?|all ?round(?:er)?|optimal|ideal)\b/g
  ]
]
const ORDER_FILLER = new Set([
  ...FILLER, 'most', 'very', 'really', 'possible', 'available', 'you', 'have', 'got', 'there', 'what', 'which',
  'whats', 'give', 'gimme', 'ones', 'llm', 'ai', 'of', 'all', 'now', 'right', 'can', 'could', 'would', 'we',
  'do', 'get', 'need', 'something', 'thats', 'out', 'here', 'then', 'go', 'put', 'make', 'over'
])

export function orderingIn(heard: string): { ordering: Ordering; rest: string } | null {
  let text = normaliseSpoken(dropPronounOne(heard))
  const found = new Set<Ordering>()
  for (const [ordering, words] of ORDER_WORDS) {
    text = text.replace(words, () => {
      found.add(ordering)
      return ' '
    })
  }
  if (!found.size) return null
  /* "The best fast one" is the fastest, "the best smart model" the
     smartest: "best" next to either is only emphasis. */
  if (found.size > 1) found.delete('balanced')
  const ordering: Ordering = found.size === 1 ? [...found][0] : 'balanced'
  const rest = text
    .split(/\s+/)
    .filter((w) => w && !ORDER_FILLER.has(w))
    .join(' ')
  return { ordering, rest }
}

/** The word each ranking's top model is also called, on a spoken list. */
export const ORDER_NAME: Record<Ordering, string> = { balanced: 'best', smarts: 'smartest', speed: 'fastest' }

/**
 * "Switch to the smartest model", "can you change to Nemotron Ultra", "use
 * the fastest one": a model asked for in passing, mid-conversation, with no
 * slash and no list on the screen. The `/model` command it means, or null.
 *
 * Only an imperative, and only one that lands on a model: "switch to dark
 * mode" and "go to the cloud" are not models. So a name has to be there by
 * its family ("Nemotron", "Gemma", "step fun"), or the word "model", or the
 * whole thing has to be a ranking ("the smartest", "the quickest one").
 */
const SWITCH =
  /^(?:(?:okay|ok|hey|so|um+|uh+|wumpy|please|now|can you|could you|would you|will you|i want to|i wanna|id like to|lets|let us)\s+)*(?:switch|change|swap|move|go|jump|flip)(?:\s+(?:it|me|us|over|back|the model|models|you|across))*\s+(?:to|onto|over to)\s+(.+)$/
const USE =
  /^(?:(?:okay|ok|so|please|now|can you|could you|lets|let us|i want to|i wanna|id like to)\s+)*(?:use|pick|choose|select|try)\s+(.+?)\s+(?:model|one)$/

export function modelSwitchIn(heard: string, models: readonly Pickable[]): string | null {
  const said = heard
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[“”"!?.,;:]+/g, ' ')
    .replace(/\b(?:please|now|instead|thanks|thank you|for me|then)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const m = SWITCH.exec(said) ?? USE.exec(said)
  if (!m) return null
  const target = m[1]
    .replace(/\b(?:please|now|instead|thanks|thank you|for me|then)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!target) return null
  const ranked = orderingIn(target)
  if (ranked && !ranked.rest) return `/model the ${ORDER_NAME[ranked.ordering]} one`
  const families = [...new Set(models.map((o) => tokensOf(o.names[0] ?? '')[0]).filter(Boolean))]
  const words = tokensOf(target)
  const pieces = [...words, ...words.slice(0, -1).map((w, i) => w + words[i + 1])]
  const named = pieces.some((p) => families.some((f) => p === f || near(p, f)))
  if (!named && !/\bmodels?\b/.test(said)) return null
  const name = target.replace(/\bmodels?\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name || !matchSpoken(name, models).length) return null
  return `/model ${name}`
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
 * A model's label as it should be said: "Nemotron 3.5 Super VL 120B" is
 * "Nemotron 3.5 Super". The provider in brackets is for the screen, and so
 * are the size and the VL: read out, "V L one hundred twenty B" was most of
 * every name, and "Slash model" took over thirteen seconds to read five.
 * No two models here differ only by size, and the name is still matched
 * whole when it is said back.
 */
export function sayModel(label: string): string {
  return label
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\bVL\b/g, '')
    .replace(/\b\d+(?:\.\d+)?B\b/g, '')
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

/** "Six", "Twenty one": a place in a list, as it is said. */
export function countWord(n: number): string {
  const word = n < 20 ? UNITS[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${UNITS[n % 10]}` : ''}`
  return word ? word[0].toUpperCase() + word.slice(1) : String(n)
}

/**
 * A numbered list, said: "One, Fish pie. Two, Taxes." Up to `max`, then how
 * many more there are - a long history read out in full is minutes of
 * titles, and every one of them can still be asked for by name. `from` is
 * how many came before, for the rest of a list read out in parts: "Six,
 * Gemma 4. Seven, ...".
 */
export function numberedSpeech(items: readonly string[], max = 12, from = 0): string {
  const shown = items.slice(0, Math.min(max, 99 - from))
  const said = shown.map((t, i) => `${countWord(from + i + 1)}, ${t.replace(/[.!?]+$/, '')}.`).join(' ')
  const rest = items.length - shown.length
  return rest > 0 ? `${said} And ${rest} older.` : said
}
