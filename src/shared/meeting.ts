/**
 * A long listen, kept as a transcript rather than a recording.
 *
 * Asked for as meeting notes: "able to get the summary, notes, specific
 * details". Three things follow from that sentence and they shape the whole
 * module.
 *
 * NO AUDIO IS KEPT. Pieces are transcribed as they are cut and the blob is
 * dropped; what accumulates is text and a clock. An hour of a meeting is a
 * few tens of kilobytes of transcript instead of ~30MB of Opus sitting in
 * temp, and nothing is left on disk afterwards to find.
 *
 * IT KEEPS UP. Whisper `base` runs at roughly 2.7x realtime on this machine,
 * so a piece cut at a pause is transcribed well before the next one closes.
 * The transcript is therefore always current, which is what makes asking
 * about it mid-meeting work at all, rather than being a thing you can only do
 * at the end.
 *
 * AND IT DOES NOT SAY WHO SPOKE. The microphone and the loopback tap are
 * mixed into one channel upstream, so this is notes of a conversation, not
 * minutes with attributions. Naming that here because a summary that invents
 * "Alice said" from an unattributed transcript is the failure mode, and the
 * prompt below forbids it.
 */

/** One piece of a listening session, as it was transcribed. */
export interface Heard {
  /** Milliseconds from the start of the session, so the notes can be ordered. */
  at: number
  text: string
  /** Whisper's code for what it decided this piece was. */
  language: string
}

/** What a listening session has gathered so far. */
export interface Listening {
  /** Wall-clock start, for "we have been going 40 minutes". */
  startedAt: number
  pieces: Heard[]
}

/** mm:ss, or h:mm:ss once there is an hour of it. */
export function stamp(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** How many words are in hand, which is the honest measure of a transcript. */
export function wordCount(session: Listening): number {
  return session.pieces.reduce((n, p) => n + countWords(p.text), 0)
}

/**
 * Words, counting a CJK character as one.
 *
 * Chinese has no spaces, so splitting on whitespace reports a forty-character
 * sentence as one word - and this number is used to decide whether there is
 * enough transcript to summarise. Getting it wrong in that direction would
 * refuse to write notes of a meeting held in Chinese, which is precisely the
 * case this was built alongside.
 */
export function countWords(text: string): number {
  const cjk = text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0
  const latin = text
    .replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + latin
}

/**
 * Below this there is not enough to summarise, and saying so is better than
 * a paragraph of invention.
 *
 * Thirty words is about ten seconds of speech. A model handed less than that
 * and asked for "the key decisions" will produce key decisions.
 */
export const ENOUGH_WORDS = 30

/**
 * The transcript as one block, timestamped every so often.
 *
 * Stamps are what make a detail findable afterwards - "around 12:30 they said
 * the deadline moved" is worth more than the same sentence floating free -
 * but one per piece would be a stamp every few seconds, which is noise and
 * tokens. One per minute of elapsed audio is enough to navigate by.
 */
export function transcriptText(session: Listening, everyMs = 60_000): string {
  const lines: string[] = []
  let marked = -Infinity
  for (const piece of session.pieces) {
    if (!piece.text.trim()) continue
    if (piece.at - marked >= everyMs) {
      lines.push(`[${stamp(piece.at)}]`)
      marked = piece.at
    }
    lines.push(piece.text.trim())
  }
  return lines.join('\n')
}

/**
 * What to ask for, and the three things not to do.
 *
 * Written as prohibitions because each one is a failure that was predictable
 * from the input rather than a style preference:
 *
 *   No speakers, because the channels are mixed and there is no way to tell
 *   them apart. A model will happily write "Alice raised the budget" from a
 *   transcript that never contained a name.
 *
 *   No filling gaps, because this is machine transcription of a far-field
 *   mix: names and numbers are exactly what it gets wrong, and a plausible
 *   correction of a misheard figure is worse than the misheard figure, which
 *   at least looks wrong.
 *
 *   No preamble, because this lands in a panel the user is reading, not in a
 *   letter.
 */
export const NOTES_PROMPT = [
  'You are writing notes from a live transcript of a meeting or call.',
  '',
  'The transcript is automatic speech recognition of a mixed audio stream. It',
  'has no speaker labels, it contains mistakes, and the mistakes are',
  'concentrated in names, numbers and technical terms.',
  '',
  'Write, in this order, and leave out any heading you have nothing for:',
  '',
  '**Summary** — three or four sentences on what the conversation was about.',
  '**Decisions** — what was actually settled. Not what was discussed.',
  '**Actions** — who is doing what, only where the transcript says so.',
  '**Details** — specific figures, dates, names and links worth keeping.',
  '**Unclear** — anything important the transcript garbled, quoted as heard.',
  '',
  'Rules:',
  '- Never attribute a line to a named person unless the transcript names them.',
  '  The channels are mixed; you cannot tell who is speaking.',
  '- Never repair a name or a number into something more plausible. If it',
  '  sounds wrong, quote it as heard and put it under Unclear.',
  '- Never invent an action item to fill the heading. Omit the heading.',
  '- No preamble, no sign-off, no offer to help further. Notes only.',
  '- Answer in the language the transcript is mostly in.'
].join('\n')

/**
 * The question put to the model, transcript included.
 *
 * `ask` is what the user typed after `/listen`, when they asked something
 * specific rather than for notes. A question about the transcript is the same
 * request with a different instruction, so it shares the prompt and the
 * guard-rails instead of having its own.
 */
export function notesRequest(session: Listening, ask = ''): string {
  const minutes = Math.max(1, Math.round(elapsed(session) / 60_000))
  const head = ask.trim()
    ? `Answer this about the transcript below: ${ask.trim()}`
    : 'Write the notes.'
  return [
    head,
    '',
    `Transcript of about ${minutes} minute${minutes === 1 ? '' : 's'}, ` +
      `${wordCount(session)} words:`,
    '',
    transcriptText(session)
  ].join('\n')
}

/** How long the session has been running, by its last piece. */
export function elapsed(session: Listening): number {
  const last = session.pieces[session.pieces.length - 1]
  return last ? last.at : 0
}
