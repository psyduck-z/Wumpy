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
 * A sentence too long to wait for, in pieces: "I asked... list out the
 * first 25 digits of pi... once it starts writing... it won't stop. Like,
 * it doesn't have much pauses. So the moment it starts writing, make the
 * text-to-speech start." The digits came as one sentence of 600 characters,
 * and nothing is said of a sentence until it ends - 45 seconds, there.
 *
 * Cut where a voice pauses anyway, at the first comma, semicolon, colon or
 * dash at least PIECE_MIN characters in; and, with none of those, at the
 * first space RUN_ON characters in. Decided from the start of the sentence
 * onwards only, so a sentence still being written is cut exactly where the
 * finished one will be, and what has been said stays said.
 */
export const PIECE_MIN = 60
export const RUN_ON = 160

export function pieces(sentence: string): string[] {
  const out: string[] = []
  let rest = sentence
  for (;;) {
    const clause = /[,;:\u2014\u2013]\s+/g
    clause.lastIndex = PIECE_MIN
    const at = clause.exec(rest)
    const space = rest.length > RUN_ON ? rest.indexOf(' ', RUN_ON) : -1
    /* Whichever comes first: a comma still waiting for the space after it
       can only be at the very end, past any space already there, so the
       choice never changes as the sentence goes on. */
    const cuts = [at ? at.index + 1 : -1, space].filter((c) => c > 0)
    if (!cuts.length) break
    const cut = Math.min(...cuts)
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
    if (!rest) return out
  }
  out.push(rest)
  return out
}

/** The answer's sentences, the long ones in pieces: what is handed to the voice. */
export function spokenPieces(text: string): string[] {
  return sentences(text).flatMap(pieces)
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
  if (done) return spokenPieces(speakable(markdown, limit))
  /* The last piece waits: the end of a sentence still being written, or a
     finished one that may yet run on ("3." may be "3.50"). */
  const all = spokenPieces(speakable(markdown, Number.MAX_SAFE_INTEGER))
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
  /* Italics hug their words; a hangman board, "_ _ O _", has spaces inside
     its underscores and is the answer, not an aside. */
  return markdown.replace(/^[ \t]*_[^_\s][^\n]*[^\s_]_[ \t]*$/gm, '')
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
