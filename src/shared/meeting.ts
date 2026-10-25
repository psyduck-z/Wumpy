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

/**
 * How many words are in hand, which is the honest measure of a transcript.
 *
 * Whitespace is enough, because the transcriber is `base.en` and English is
 * the only thing it can return. A script without word spaces would need
 * counting by character instead - see WHISPER_MODEL for why there is not
 * one to worry about.
 */
export function wordCount(session: Listening): number {
  return session.pieces.reduce((n, p) => n + countWords(p.text), 0)
}

/** Words in one piece. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Below this there is not enough to SUMMARISE, and saying so is better than
 * a paragraph of invention.
 *
 * Thirty words is about ten seconds of speech. A model handed less than that
 * and asked for "the key decisions" will produce key decisions.
 *
 * IT GATES THE WRITE-UP AND NOTHING ELSE, which it used to. Eleven seconds
 * into a session somebody asked "what are we doing" - the one question this
 * feature exists for - and the transcript was withheld for being eight words
 * long, so the question went to the model with no meeting attached to it and
 * whatever came back was about nothing. A thin transcript cannot produce an
 * invented summary when the message is a question about it: the worst it can
 * do is make the model say there is not much there yet, which is true and is
 * the answer. See `meetingTurn`, which says so itself when there is nothing.
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
/**
 * The rules, which are three predictable failures rather than a house style.
 *
 * No speakers, because the channels are mixed and there is no way to tell
 * them apart. A model will happily write "Alice raised the budget" from a
 * transcript that never contained a name.
 *
 * No filling gaps, because this is machine transcription of a far-field
 * mix: names and numbers are exactly what it gets wrong, and a plausible
 * correction of a misheard figure is worse than the misheard figure, which
 * at least looks wrong.
 *
 * No preamble, because this lands in a panel somebody is reading.
 *
 * THESE ARE SENT, not merely declared. They were exported and asserted on
 * for a day and never reached a model: `notesRequest` built a head and a
 * transcript and left the rules in the file. Every path now goes through
 * `meetingTurn`, which is the only thing that builds a request, so there is
 * nowhere for a second version of them to grow.
 */
export const RULES = [
  'The transcript below is automatic speech recognition of a mixed audio',
  'stream. It has no speaker labels, it contains mistakes, and the mistakes',
  'are concentrated in names, numbers and technical terms.',
  '',
  '- Never attribute anything to a named person unless the transcript names',
  '  them. The channels are mixed; you cannot tell who is speaking.',
  '- Never repair a name or a number into something more plausible. If it',
  '  sounds wrong, quote it as heard and say it was unclear.',
  '- Do not invent detail to fill a heading. Leave the heading out.'
].join('\n')

/**
 * Is this message a request for the write-up rather than a question?
 *
 * Because the only word anyone was told to remember is "notes", and it
 * arrives as an ordinary message like everything else now. Short and exact:
 * a sentence containing the word "notes" is a sentence, and belongs in the
 * question branch where the transcript is still attached and nothing is
 * assumed about what was meant.
 */
export function wantsNotes(ask: string): boolean {
  return /^(notes?|summary|summarise|summarize|write it up|sum ?up|recap)\.?$/i.test(ask.trim())
}

/** The shape of written-up notes, used when nothing specific was asked. */
export const NOTES_PROMPT = [
  'Write notes from the transcript. In this order, leaving out any heading',
  'you have nothing for:',
  '',
  '**Summary** — three or four sentences on what it was about.',
  '**Decisions** — what was actually settled. Not what was discussed.',
  '**Actions** — who is doing what, only where the transcript says so.',
  '**Details** — specific figures, dates, names and links worth keeping.',
  '**Unclear** — anything important it garbled, quoted as heard.',
  '',
  'No preamble, no sign-off, no offer to help further. Notes only.'
].join('\n')

/**
 * One turn with the transcript attached, whatever the user typed.
 *
 * THE COMMAND WAS THE PROBLEM. This used to be reachable only as `/listen
 * what did they say about the deadline`, which is a sentence nobody is going
 * to remember - asked for in those words: "that's too long. How am I
 * supposed to remember this?"
 *
 * They are right, and the fix is that there is nothing to remember. While
 * Wumpy is listening, every message carries the transcript, so asking about
 * the meeting is just asking. `ask` empty means they wanted the notes.
 *
 * The command is gone altogether now - "remove the command, i like it when i
 * ask it directly" - so a session starts from a sentence as well, through
 * intents.ts. Nothing in here changes: this was always the half that had no
 * syntax in it.
 *
 * The last paragraph is what makes that safe. A transcript on every turn
 * means it is also attached to "what is the weather" - so the model is told
 * in as many words that a message which is not about the meeting is an
 * ordinary message, and the transcript is there to be ignored.
 *
 * AND IT GOES OUT HOWEVER SHORT IT IS, including empty. The write-up still
 * waits for ENOUGH_WORDS, because that one invents; a question does not, and
 * withholding the first ten words made "what are we doing" - asked eleven
 * seconds in - a question about nothing at all. Length is stated rather than
 * hidden, so a model with four words to go on says it has four words.
 */
export function meetingTurn(session: Listening, ask = ''): string {
  const words = wordCount(session)
  const question = wantsNotes(ask) ? '' : ask.trim()
  return [
    question
      ? 'I have Wumpy listening to a meeting. My message is at the end.'
      : 'I have Wumpy listening to a meeting.',
    '',
    RULES,
    '',
    /*
     * Measured by the audio, not by the clock.
     *
     * `elapsed` is where the last piece sat in the recording, which stays
     * true after the session stops; wall-clock time from `startedAt` would
     * keep growing and have the model announce three hours of a meeting
     * that ended at twenty minutes.
     */
    words
      ? `Transcript so far — ${stamp(elapsed(session))} in, ${words} words:`
      : 'Nothing has been transcribed yet: it has only just started ' +
        'listening, or has heard nothing but silence. If my message is about ' +
        'the meeting, say that plainly - do not guess at what was said.',
    ...(words ? ['', transcriptText(session)] : []),
    '',
    question
      ? [
          'My message:',
          '',
          question,
          '',
          'If it is about the meeting, answer it from the transcript. If it is',
          'not, answer it normally and ignore the transcript entirely.'
        ].join('\n')
      : NOTES_PROMPT
  ].join('\n')
}

/** How long the session has been running, by its last piece. */
export function elapsed(session: Listening): number {
  const last = session.pieces[session.pieces.length - 1]
  return last ? last.at : 0
}
