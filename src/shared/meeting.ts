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
  /**
   * What was on the screen, when it was being watched: a vision model's
   * note of each screen that looked different from the last - slides,
   * a shared document, names on the call. Text only; no picture is kept.
   */
  seen?: Heard[]
}

/*
 * WATCHING THE SCREEN, as well as listening.
 *
 * Asked for in these words: "when I'm doing meeting recordings, like when I
 * tell it, listen to this meeting... can you allow it to look at my screen
 * too to make it easier?" The transcript cannot spell a name it only heard,
 * read a figure off a slide, or say what document was shared - the screen
 * can. So, only when asked, the screen is looked at every WATCH_EVERY_MS;
 * a screen that has not visibly changed is not sent anywhere, and one that
 * has is described in a few lines by a model that can see. The picture is
 * then dropped, as the audio is: what is kept is text and a time.
 */

/** How often the screen is looked at while it is being watched. */
export const WATCH_EVERY_MS = 20_000

/**
 * How different a screen must look, on average per pixel of a 32x18
 * grey thumbnail (0-255), to be described again. A cursor moving or a
 * clock ticking is under it; a new slide, a different window or a shared
 * screen appearing is far over it.
 */
export const CHANGED_ABOVE = 6

/** Whether two thumbnails differ enough to be worth describing. No last one: yes. */
export function screenChanged(last: readonly number[] | null, now: readonly number[]): boolean {
  if (!last || last.length !== now.length || !now.length) return true
  let sum = 0
  for (let i = 0; i < now.length; i++) sum += Math.abs(now[i] - last[i])
  return sum / now.length > CHANGED_ABOVE
}

/**
 * Whether a new note says what the last one did, so it is not kept twice:
 * a screen can change (a video playing, a speaker's tile lighting up) while
 * what matters on it does not.
 */
export function sameNote(last: string | undefined, now: string): boolean {
  if (!last) return false
  const words = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
  const a = new Set(words(last))
  const b = words(now)
  if (!b.length) return true
  const shared = b.filter((w) => a.has(w)).length
  return shared / Math.max(a.size, b.length) > 0.8
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
  /* What was said and what was shown, in the order they happened. */
  const events = [
    ...session.pieces.map((p) => ({ ...p, shown: false })),
    ...(session.seen ?? []).map((p) => ({ ...p, shown: true }))
  ].sort((a, b) => a.at - b.at)
  for (const piece of events) {
    if (!piece.text.trim()) continue
    if (piece.shown) {
      lines.push(`(on screen, ${stamp(piece.at)}: ${piece.text.trim().replace(/\s+/g, ' ')})`)
      continue
    }
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
  '- Do not invent detail to fill a heading. Leave the heading out.',
  '- Lines "(on screen, mm:ss: ...)" are what was on my screen then, as a',
  '  vision model described it. Use them for names, titles and figures the',
  '  audio garbles - but they are second-hand, and a name on screen is not',
  '  proof of who was speaking.'
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

/*
 * LIVE NOTES, kept up to date while the meeting runs.
 *
 * Asked for as "live notes and updating, and also change things": notes that
 * are on screen during the meeting rather than only at the end, and that
 * CHANGE when the meeting does - the deadline that was Thursday at ten past
 * and Friday at half past is Friday in the notes, with the Thursday struck
 * through, not two deadlines side by side.
 *
 * Each update sends the notes so far plus only the transcript since the last
 * update (with a minute of overlap, so a sentence cut at the seam is seen
 * whole). The notes carry what came before, so an hour-long meeting costs
 * the same per update as a five-minute one.
 */

/** How often the live notes are brought up to date, at most. */
export const LIVE_NOTES_EVERY_MS = 60_000
/** And only when this much more has been said - or the screen showed something new. */
export const LIVE_NOTES_NEW_WORDS = 40
/** How far back before the last update each update re-reads. */
export const LIVE_NOTES_OVERLAP_MS = 60_000

/** Whether the live notes are due an update. */
export function liveNotesDue(
  last: { words: number; seen: number; at: number },
  now: { words: number; seen: number; at: number }
): boolean {
  if (now.at - last.at < LIVE_NOTES_EVERY_MS) return false
  const firstTime = last.words === 0 && last.seen === 0
  if (firstTime) return now.words >= ENOUGH_WORDS || now.seen > 0
  return now.words - last.words >= LIVE_NOTES_NEW_WORDS || now.seen > last.seen
}

/** Where the session has got to, by the last thing heard or seen. */
export function reached(session: Listening): number {
  const seen = session.seen ?? []
  return Math.max(elapsed(session), seen.length ? seen[seen.length - 1].at : 0)
}

export const LIVE_NOTES_PROMPT = [
  'You keep running notes of a meeting that is still going on. You are given',
  'your notes so far and what has been said and shown since. Return the notes',
  'as they should stand NOW:',
  '',
  '- Add what is new.',
  '- When the meeting changes something already in the notes - a date moved,',
  '  a decision reversed, a figure corrected, an action handed to someone',
  '  else - change that item where it is and show the change, like:',
  '  "Due Friday ~~Thursday~~ (changed 12:30)". Never keep the old and the new',
  '  side by side as if both were true.',
  '- Something dropped is struck through: "~~Hire a contractor~~ (dropped 14:05)".',
  '- Leave items that have not changed exactly as they were.',
  '',
  'Headings, in this order, leaving out any you have nothing for:',
  '**Summary** (two or three sentences), **Decisions**, **Actions**,',
  '**Details**, **Open questions**. Short bullets. No preamble, no sign-off.',
  'Notes only.'
].join('\n')

/** The live-notes request: rules, the notes so far, and what is new since `since` ms. */
export function liveNotesRequest(
  session: Listening,
  previous: string,
  since: number
): { system: string; user: string } {
  const from = previous.trim() ? Math.max(0, since - LIVE_NOTES_OVERLAP_MS) : 0
  const recent: Listening = {
    startedAt: session.startedAt,
    pieces: session.pieces.filter((p) => p.at >= from),
    seen: (session.seen ?? []).filter((p) => p.at >= from)
  }
  const text = transcriptText(recent)
  return {
    system: `${RULES}\n\n${LIVE_NOTES_PROMPT}`,
    user: [
      previous.trim() ? `Your notes so far:\n\n${previous.trim()}` : 'There are no notes yet.',
      '',
      from > 0
        ? `What was said and shown from ${stamp(from)} to ${stamp(reached(session))}:`
        : `The meeting so far, ${stamp(reached(session))} in:`,
      '',
      text || '(nothing new)'
    ].join('\n')
  }
}

/** The card the live notes are shown in. */
export function liveNotesCard(notes: string, session: Listening, live: boolean): string {
  const head = live
    ? `**Live notes** · ${stamp(reached(session))} in · updating as the meeting goes`
    : `**Meeting notes** · final, ${stamp(reached(session))} · ask me anything about it`
  return `${head}\n\n${notes.trim()}`
}
