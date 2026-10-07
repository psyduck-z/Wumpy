/**
 * Turning what Whisper heard into what was meant.
 *
 * Two things are wrong with a raw transcript, and they need different fixes.
 *
 * The first is vocabulary. An acoustic model has never heard of this app, so
 * "Wumpy" comes back as "wimpy", "Ollama" as "a llama", and "/also" as "slash
 * also" - every time, the same way. Those are not judgement calls, so they are a
 * table, applied here: no model, no latency, and no chance of a rewrite nobody
 * asked for. Whisper is also given these words up front as an initial prompt,
 * which stops some of them going wrong in the first place; this catches the rest.
 *
 * The second is punctuation and shape, which does need judgement, and that is
 * the optional polish pass through the local model. Everything here runs first
 * and always.
 *
 * The third thing, which is not a fix: silence. Whisper hallucinates on it,
 * confidently and in a small number of recognisable ways, so `isNoise` throws
 * those away rather than typing "Thank you." into the box.
 */

/** A spoken form and what it should have been, with the reason it is here. */
interface Fix {
  from: RegExp
  to: string
}

/**
 * Whisper's inventions when handed silence or breath.
 *
 * It does not return nothing - it returns the most likely thing to follow a
 * silence in its training data, which was largely subtitled video. Tapping the
 * mic key by accident should leave the box alone, not write "Thanks for
 * watching!" into it.
 */
const NOISE = [
  /^thank you\.?$/i,
  /^thanks? for watching\.?!?$/i,
  /^thank you for watching\.?!?$/i,
  /^subtitles? (by|and corrections).*/i,
  /^\[?\s*(blank_?audio|silence|inaudible|music|applause|no speech)\s*\]?\.?$/i,
  /^\(\s*(silence|music|applause|pause)\s*\)$/i,
  /^[.,!?\-\s…]*$/,
  /^you\.?$/i,
  /^bye\.?$/i,
  /^okay\.?$/i,
  /^mm+\.?$/i,
  /^uh+\.?$/i
]

/** True when the transcript is Whisper filling a silence rather than speech. */
export function isNoise(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return NOISE.some((r) => r.test(t))
}

/**
 * Words this app uses that no acoustic model knows.
 *
 * Each left-hand side is something actually observed or predictable from how the
 * word sounds, not a guess at every possible mishearing: a table that fires on
 * things people say normally is worse than no table.
 */
const VOCABULARY: Fix[] = [
  // The app's own name. "Wumpy" has no entry in any dictionary, so Whisper
  // reaches for the nearest real word every time.
  { from: /\b(wimpy|whimpy|wumpie|wumpee|womp[ -]?e|wompy|one pee)\b/gi, to: 'Wumpy' },

  // Ollama splits in two, because "a llama" is a far more likely English phrase.
  //
  // Only after a verb that means software, though: "draw a llama wearing a hat"
  // is an ordinary request, and the vocabulary prompt already gets Ollama right
  // most of the time - this is the backstop, so it can afford to be narrow.
  {
    from: /\b(ask|asked|tell|use|using|used|start|restart|stop|run|running|check|is|was) (?:a|oh|the) llamas?\b/gi,
    to: '$1 Ollama'
  },
  { from: /\b(olama|oulama|ollamma|allama|aloma)\b/gi, to: 'Ollama' },

  // Model names, which are worse: part word, part number.
  { from: /\bphi[ -]?(four|4)[ -]?mini\b/gi, to: 'phi4-mini' },
  { from: /\b(fee|fie|fi|five)[ -]?(four|4)[ -]?mini\b/gi, to: 'phi4-mini' },
  { from: /\b(qwen|quen|gwen|when|chwen|queen)[ -]?(two|2)[ .-]?(five|5)\b/gi, to: 'qwen2.5' },
  { from: /\bllama[ -]?(three|3)[ .-]?(two|2)\b/gi, to: 'llama3.2' },
  { from: /\bcoder[ -]?(fourteen|14)[ -]?b\b/gi, to: 'coder:14b' },

  // Whisper itself, for when the user is configuring it.
  { from: /\bwhisper[ -]?(cpp|c\+\+)\b/gi, to: 'whisper.cpp' },

  // Ollama again, from what base.en actually returned with no prompt to help
  // it: "Olimit" and "Olima" both turned up on the same twelve sentences.
  { from: /\b(olimit|olima|olimat|ollima|olamma)\b/gi, to: 'Ollama' },

  // The things the app calls its own parts. "tier" comes back as "tear", which
  // is a real word, so it is only corrected next to the words that make it a
  // tier - never alone, where it is more likely about crying or ripping.
  { from: /\b(tear|teer)s? (list|picker|menu)\b/gi, to: 'tier $2' },
  { from: /\b(fast|quick|deep|thinker|coder) (tear|teer)s?\b/gi, to: '$1 tier' },
  { from: /\b(switch|change|changed|go|going|move) (to|into) the (tear|teer)\b/gi, to: '$1 $2 the tier' },
  { from: /\baccept (edits|at its|additives)\b/gi, to: 'accept edits' },
  { from: /\bkeep[ -]?alive\b/gi, to: 'keep-alive' },

  // Shells and tools whose names are not words.
  { from: /\bpower ?shell\b/gi, to: 'PowerShell' },
  { from: /\bgit ?hub\b/gi, to: 'GitHub' },
  { from: /\bnode ?j ?s\b/gi, to: 'Node.js' },
  { from: /\bno ?sql\b/gi, to: 'NoSQL' },
  // Not straight after a dot: EXTENSIONS has already turned "dot jason" into
  // ".json", and there is no such file as package.JSON.
  { from: /(?<!\.)\bj ?son\b/gi, to: 'JSON' },
  { from: /\bpy ?thon\b/gi, to: 'Python' }
]

/**
 * Extensions, which are always dictated as "dot something" and always come back
 * as two words. "pie" for .py is the one that bites hardest, because it is a
 * perfectly ordinary word.
 */
const EXTENSIONS: Fix[] = [
  { from: /\bdot (pie|pi|py|p y|p\.y\.?)\b/gi, to: '.py' },
  { from: /\bdot (j s|jay ess|jay s|js)\b/gi, to: '.js' },
  { from: /\bdot (t s|tee ess|ts)\b/gi, to: '.ts' },
  { from: /\bdot (t s x|tsx)\b/gi, to: '.tsx' },
  { from: /\bdot (m d|em dee|md|markdown)\b/gi, to: '.md' },
  { from: /\bdot (j son|json|jason)\b/gi, to: '.json' },
  { from: /\bdot (txt|text|tee ex tee)\b/gi, to: '.txt' },
  { from: /\bdot (csv|c s v)\b/gi, to: '.csv' },
  { from: /\bdot (exe|e x e)\b/gi, to: '.exe' },
  { from: /\bdot (png|p n g)\b/gi, to: '.png' },
  { from: /\bdot (yaml|yml|yamel)\b/gi, to: '.yml' },
  { from: /\bdot (ps1|p s one)\b/gi, to: '.ps1' },
  { from: /\bdot (env|e n v)\b/gi, to: '.env' },
  { from: /\bdot (git ignore|gitignore)\b/gi, to: '.gitignore' }
]

/**
 * Things that only make sense as punctuation.
 *
 * Deliberately short. Whisper punctuates by itself, so a table that turns
 * "period" into "." mostly corrupts sentences that were talking about a period;
 * only the forms with no ordinary reading are here.
 */
const SPOKEN: Fix[] = [
  { from: /\b(new|next) (line|paragraph)\b/gi, to: '\n' },
  { from: /\bopen (paren|parenthesis|bracket)\b/gi, to: '(' },
  { from: /\bclose (paren|parenthesis|bracket)\b/gi, to: ')' },
  // These eat the space after them, because they are nearly always dictated as
  // part of a path. The general cleanup below deliberately does not touch
  // slashes, so that "and / or" in ordinary speech survives.
  { from: /\bforward slash */gi, to: '/' },
  { from: /\bback ?slash */gi, to: '\\' },
  { from: /\bdouble dash\b/gi, to: '--' },
  { from: /\bunder ?score\b/gi, to: '_' },
  { from: /\bat sign\b/gi, to: '@' },
  { from: /\bhash ?tag\b/gi, to: '#' }
]

/** Leading hesitation. Whisper usually drops it; when it does not, this does. */
const FILLER = /^(?:(?:um|uh|erm|ah|er|like|so|okay|ok|well)[,.]?\s+)+/i

/**
 * Spoken forms of a slash command, built from the real command list.
 *
 * Taking the names rather than hard-coding them means a command added later is
 * dictatable the day it is added, and a command renamed cannot leave a stale
 * phrase behind that quietly stops working.
 */
function slashFixes(commands: string[]): Fix[] {
  return commands.flatMap((name) => {
    const spoken = escape(name.replace(/-/g, ' '))
    return [
      // "slash also", and the mishearings of "slash" that actually happen.
      { from: new RegExp(`\\b(?:slash|flash|splash|lash)\\s+${spoken}\\b`, 'gi'), to: `/${name}` },
      // Said at the very start with the slash swallowed entirely, which is the
      // common case: "also, it should be called hello" meant "/also".
      { from: new RegExp(`^\\s*${spoken}\\b[,:]?\\s*`, 'i'), to: `/${name} ` }
    ]
  })
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Commands whose name is an ordinary English word.
 *
 * The bare-word rule above is only safe for names nobody says by accident.
 * "also" at the start of a sentence is a command; "stop" or "new" is just as
 * likely to be the beginning of a request, and turning those into commands
 * would send something the user did not ask for.
 */
const BARE_WORD_SAFE = new Set(['also'])

export interface TidyOptions {
  /** Command names, so every one of them can be spoken. */
  commands?: string[]
}

/**
 * The whole deterministic pass.
 *
 * Order matters: extensions before vocabulary, because ".py" must not first
 * become "Python"; slash commands last, so they see a cleaned-up line.
 */
export function tidyTranscript(raw: string, opts: TidyOptions = {}): string {
  if (isNoise(raw)) return ''

  let text = raw.trim().replace(/\s+/g, ' ')
  text = text.replace(FILLER, '')

  for (const { from, to } of EXTENSIONS) text = text.replace(from, to)
  for (const { from, to } of VOCABULARY) text = text.replace(from, to)
  for (const { from, to } of SPOKEN) text = text.replace(from, to)

  const commands = opts.commands ?? []
  for (const { from, to } of slashFixes(commands)) {
    // The bare-word form is only applied to names that are not ordinary words.
    const bare = from.source.startsWith('^')
    if (bare) {
      const name = to.trim().slice(1)
      if (!BARE_WORD_SAFE.has(name)) continue
    }
    text = text.replace(from, to)
  }

  // Substitutions leave their own mess: a space before punctuation that used to
  // be a word, doubled spaces where a phrase became a single character.
  text = text
    .replace(/ +([.,!?;:)])/g, '$1')
    .replace(/([(@#_]) +/g, '$1')
    .replace(/ {2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()

  // A sentence starts with a capital, unless it starts with a command or a path.
  if (/^[a-z]/.test(text) && !text.startsWith('/')) {
    text = text[0].toUpperCase() + text.slice(1)
  }

  return text
}

/* -------------------------------------------------------------- polish guard */

/**
 * Numbers, in either of the two forms the same quantity can take.
 *
 * Turning spoken numbers into digits is one of the few rewrites the polish pass
 * is explicitly asked for, and it is also the one that moves the most words:
 * "two hundred and fourteen" becomes "214", four words becoming one. Counting
 * that as four edits would put a legitimate correction over the same threshold
 * that is meant to catch a model rewriting the sentence - so quantities are
 * dropped from both sides before the comparison, and what is left is the part
 * that has to match.
 */
const NUMERIC =
  /^(?:\d[\d.,]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)$/

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/.\- ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NUMERIC.test(w))
}

/** Levenshtein over words, so a reordering costs less than a rewrite. */
function wordDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    prev = cur
  }
  return prev[b.length]
}

/** Openings that mean the model answered the transcript instead of cleaning it. */
const CHATTY =
  /^(sure|certainly|of course|here('s| is)|i've|i have|the (corrected|cleaned|fixed)|corrected|cleaned|output|transcript|note that|it (seems|looks|sounds))\b/i

/**
 * Whether a polished line may replace the raw one.
 *
 * The polish pass asks a language model to punctuate a sentence, and a language
 * model asked to punctuate a sentence will sometimes answer it instead, or
 * explain what it changed, or decide the user meant something else. Any of those
 * is worse than leaving the transcript alone, and the user is about to read this
 * in the box and press Enter - so anything that is not clearly the same sentence
 * is refused and the raw text stands.
 */
export function polishAcceptable(raw: string, polished: string): boolean {
  const clean = polished.trim()
  if (!clean) return false

  // A chat reply, a code block, or a quoted restatement: not a transcript.
  if (CHATTY.test(clean)) return false
  if (clean.includes('```')) return false
  if (/^["'`]|["'`]$/.test(clean)) return false
  // Polish punctuates one utterance. It never has cause to add lines.
  if (clean.split('\n').length > raw.split('\n').length) return false

  const before = words(raw)
  const after = words(clean)
  if (before.length === 0 || after.length === 0) return false

  // Numerals collapse several words into one and filler drops out, so some
  // shrinking is expected; growth is not, because nothing should be added.
  const ratio = after.length / before.length
  // "two hundred and fourteen" becoming "214" is four words becoming one, so the
  // floor has to allow a fair amount of shrinking. A real truncation still falls
  // well below it.
  if (ratio < 0.5 || ratio > 1.25) return false

  // And the words themselves must still be the same words.
  return wordDistance(before, after) <= Math.max(2, Math.ceil(before.length * 0.34))
}

/**
 * The instruction for the polish pass.
 *
 * Kept here beside its guard so the two cannot drift: every rule it is told to
 * follow is one the guard permits, and nothing it is told to do would be
 * rejected on arrival.
 */
export const POLISH_PROMPT = [
  'You are fixing a speech-to-text transcript. Repair only what dictation gets wrong:',
  'sentence punctuation, capitalisation, obvious homophones, and numbers that were',
  'spelled out in words.',
  '',
  'Never answer the text, comment on it, explain it, translate it, or make it more polite.',
  'Never add or remove information. Never add quotes around it. Keep the words that are',
  'there, in the order they are in. If it is already correct, repeat it back unchanged.',
  '',
  'Reply with the corrected line and nothing else.'
].join('\n')
