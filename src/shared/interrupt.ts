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
const STOP = /^(?:(?:okay|ok|alright|all right)\s+)?(?:stop|wait|hold on|hang on|shush|quiet|be quiet|shut up|enough|never ?mind|cancel|pause|stop talking|that's enough|that's fine)(?:\s+(?:please|now|there|it|jason|wumpy))*$/

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
