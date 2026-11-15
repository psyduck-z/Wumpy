import { speakable } from './spoken'

/**
 * Speaking an answer while it is still being written.
 *
 * Asked for in these words: "once the AI starts to write down things,
 * quickly begin to [speak it], because if you wait for it... it takes like
 * 15 seconds to write everything... then that 3-second delay, which is
 * already 18 seconds for a response, which is terrible." So a voice turn
 * hands each sentence to the voice as soon as the sentence is finished,
 * and the first words are heard while the model is still on the second.
 *
 * Whole sentences only. Half of one would be read with the wrong rise and
 * fall, and "It costs 3." may yet turn out to be "It costs 3.50" - which is
 * why the last sentence of an answer still being written always waits for
 * whatever comes after it.
 */

/** The answer's sentences, in order: split where a stop is followed by a space. */
export function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?…]["'”’)\]]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The sentences of `markdown` that can be spoken now: every finished one
 * while it is still being written, and all of them once it is done. Within
 * the same length as a spoken answer is held to (see speakable), so the
 * voice never starts on something the finished answer would have cut.
 */
export function readyToSay(markdown: string, done: boolean, limit = 600): string[] {
  markdown = withoutAsides(markdown)
  /* A command block has started: everything before it is finished prose,
     last sentence included, and nothing inside it is ever read. */
  const fences = markdown.split('```').length - 1
  if (!done && fences % 2 === 1) {
    markdown = markdown.slice(0, markdown.lastIndexOf('```'))
    done = true
  }
  if (done) return sentences(speakable(markdown, limit))
  const all = sentences(speakable(markdown, Number.MAX_SAFE_INTEGER))
  all.pop()
  const ready: string[] = []
  let length = 0
  for (const s of all) {
    length += (ready.length ? 1 : 0) + s.length
    if (length > limit) break
    ready.push(s)
  }
  return ready
}

/**
 * A line wholly in italics is the app talking about the answer - "_Nemotron
 * had not started after 5s - answering on Nemotron Lightning instead._" -
 * not the answer. On screen it says which model answered; read aloud it is
 * two model ids before "Five."
 */
export function withoutAsides(markdown: string): string {
  return markdown.replace(/^[ \t]*_[^_\n][^\n]*_[ \t]*$/gm, '')
}

/**
 * How much to send to the voice in one go: the first sentence alone, so
 * the first sound comes as early as it can, and after that whatever is
 * ready, up to a few sentences - fewer requests, and each one long enough
 * that the voice keeps its flow across them.
 */
export function nextBatch(waiting: string[], first: boolean, max = 280): string[] {
  if (!waiting.length) return []
  if (first) return [waiting[0]]
  const batch: string[] = []
  let length = 0
  for (const s of waiting) {
    if (batch.length && length + 1 + s.length > max) break
    batch.push(s)
    length += (batch.length > 1 ? 1 : 0) + s.length
  }
  return batch
}
