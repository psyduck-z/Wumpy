/**
 * When each of their messages was sent, written onto it for the model.
 *
 * Asked for: "when i send messages, allow it to note the TIME i sent it, so
 * ... it can tell when i was away, adapt, etc". A model sees a chat as one
 * unbroken exchange: a question this morning about a battery read last
 * night was answered from last night's output as if it were still true.
 * So each message the person wrote goes out as "[sent Thu 19 Nov, 7:26 am]
 * ...", and one that comes long after the one before says how long - the
 * model is poor at subtracting clock times, and the gap is the point.
 *
 * Stamped on the wire only (see withContext in main): the transcript keeps
 * what they typed. A stamp never changes once written, so the history ahead
 * of the newest message stays the same from turn to turn, as a cache wants.
 *
 * Pure: times in, text out, in the computer's own time zone.
 */

/** A gap shorter than this is one sitting, and not worth a word. */
export const AWAY_AFTER_MS = 10 * 60_000

/** "25 minutes", "an hour", "9 hours", "3 days". */
export function gapWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 2) return 'an hour'
  if (hours < 48) return `${hours} hours`
  return `${Math.round(ms / 86_400_000)} days`
}

/** "Thu 19 Nov, 7:26 am", and after a long gap how long it was. */
export function sentStamp(at: number, before: number | null): string {
  const when = new Date(at)
  const day = when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, '')
  const hour = when.getHours()
  const clock = `${hour % 12 || 12}:${String(when.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`
  const gap = before !== null && at - before >= AWAY_AFTER_MS ? ` - ${gapWords(at - before)} after their last message` : ''
  return `[sent ${day}, ${clock}${gap}]`
}

/** The start of a stamp, for anything that must find one or take it off. */
export const STAMP = /^\[sent [^\]\n]{6,80}\]\s*/

/**
 * Their messages, each with its stamp in front. Only those with a `sentAt`:
 * the ones they wrote, not output handed back on their behalf. The gap is
 * from the last message they wrote, whatever came between.
 */
export function withSentTimes<T extends { role: string; content: string; sentAt?: number }>(messages: readonly T[]): T[] {
  let before: number | null = null
  return messages.map((m) => {
    if (m.role !== 'user' || typeof m.sentAt !== 'number' || !Number.isFinite(m.sentAt)) return m
    const stamp = sentStamp(m.sentAt, before)
    before = m.sentAt
    return { ...m, content: `${stamp} ${m.content}` }
  })
}
