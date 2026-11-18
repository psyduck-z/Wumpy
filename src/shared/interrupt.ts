/**
 * What it was, when someone talked over an answer.
 *
 * Talking over it stops it at once - but not everything said over an
 * answer is meant to stop it. A cough, or "mm-hm" said the way people say
 * it to show they are listening, is not a question, and the answer carries
 * on from where it was cut. "Stop", "wait", "never mind" stop it and send
 * nothing: there is no question to answer. Anything else is the next thing
 * said, and gets answered.
 *
 * Pure, for scripts/check-spoken.mjs.
 */
export type Interruption = 'nothing' | 'stop' | 'words'

const FILLER = /^(?:m+|h?m+-?h?m+|mhm+|uh-?huh|uh+|um+|ah+|oh+|huh|er+|hm+)$/
const STOP = /^(?:(?:okay|ok|alright|all right)\s+)?(?:stop|wait|hold on|hang on|shush|quiet|be quiet|shut up|enough|never ?mind|cancel|pause|stop talking|that's enough|that's fine)(?:\s+(?:please|now|there|it|ray|jason|wumpy))*$/

export function interruption(heard: string): Interruption {
  const words = heard
    .toLowerCase()
    .replace(/[^a-z' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!words) return 'nothing'
  if (words.split(' ').every((w) => FILLER.test(w))) return 'nothing'
  if (STOP.test(words)) return 'stop'
  return 'words'
}

/**
 * Whether what was said so far sounds like the middle of a thought.
 *
 * "Can you describe to me what neuroscience is, how it affects our mental
 * life, um, and how it kind of like" - a pause to think, taken for the end,
 * and answered half asked. The transcriber ends a finished sentence with a
 * full stop or a question mark; a thought trailing off into "and", "like"
 * or "um" ends without one, or with a word no sentence ends on. Heard from
 * the early guess, while the pause is still being waited out, so the wait
 * can be made longer before it is over (see UNFINISHED_PAUSE_MS).
 */
const TRAILING =
  /\b(?:and|or|but|so|because|cause|like|um+|uh+|er+|the|a|an|to|of|for|with|about|from|in|on|at|into|that|which|who|if|then|than|my|your|his|her|their|our|its|this|these|those|is|are|was|were|be|can|could|would|should|will|do|does|did|have|has|kind of|sort of|i mean|what|how|why|when|where)$/
/* After a full stop, only what no sentence ends on: "...and." is the
   transcriber guessing, "turn it on." is not. A question mark is a
   question, however it ends. */
const NEVER_LAST = /\b(?:and|or|but|because|cause|um+|uh+|er+|the|a|an|kind of|sort of|like)$/

export function unfinished(heard: string): boolean {
  const text = heard.trim()
  if (!text) return false
  if (/[,;:\u2014\u2013-]$|\.\.\.$|\u2026$/.test(text)) return true
  if (/[?!]$/.test(text)) return false
  const last = text.toLowerCase().replace(/[.]+$/, '').replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/\.$/.test(text)) return NEVER_LAST.test(last) && last.split(' ').length > 1
  /* No full stop at all: the transcriber ends a finished sentence with
     one, so more than a couple of words without one are mid-thought; a
     one-word "yes" or "Leo" is still finished. */
  return last.split(' ').length > 2 || TRAILING.test(last)
}

/**
 * Only the start of something: "Okay. Also," and then a pause to think.
 * Sent alone, it was answered - four words back to a sentence that had not
 * begun - and what they then said arrived as a separate question. So it is
 * held and put in front of what they say next. Finished words are never
 * held: "Okay." on its own is an answer, and is sent.
 */
const LEAD_IN = new Set([
  'okay', 'ok', 'so', 'also', 'and', 'um', 'umm', 'uh', 'er', 'erm', 'well', 'right', 'alright', 'then', 'but',
  'plus', 'oh', 'hmm', 'like', 'actually', 'anyway', 'wait', 'yeah', 'hey', 'wumpy', 'now', 'next', 'another',
  'thing', 'one', 'more', 'other', 'the', 'a', 'and then', 'oh and', 'last', 'lastly', 'finally', 'besides'
])

export function leadInOnly(heard: string): boolean {
  const words = heard
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.length > 0 && words.length <= 6 && words.every((w) => LEAD_IN.has(w)) && unfinished(heard)
}
