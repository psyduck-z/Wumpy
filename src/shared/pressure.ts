/**
 * When the conversation has to be summarised, and who it may interrupt.
 *
 * Asked for in one sentence: "if the context is above 90% while it's doing
 * something, stop whatever it's doing, compact, and then continue. Because
 * when it's burst the context, it can't do anything."
 *
 * That names a gap rather than a preference. Compaction had two triggers and
 * both of them needed the user:
 *
 *   - before a SEND, at 65%, when they press Enter
 *   - while IDLE, at 60%, once the panel is away in the tray
 *
 * Every other turn in this app is automatic. A command's output, a web
 * search's results, a screenshot and the report from a wumpy-do plan are all
 * handed back as a turn the user did not type - and a desktop sequence is a
 * dozen of them in a row, each carrying a fresh ~1,100-token photograph of
 * the screen. Nothing in that loop compacts, because nobody pressed Enter and
 * the panel never goes to the tray while it is running. So the one path that
 * fills the window fastest was the one path that could not make room, and it
 * ran until the model started refusing the request.
 *
 * Hence a third trigger, at 90%: high enough that an ordinary two-step plan
 * is never interrupted, low enough to still be able to afford the summary.
 * The step that was about to happen happens afterwards, which is the "and
 * then continue" half - a compaction that drops the result it was making room
 * for has lost the thing it was protecting.
 *
 * Pure, so the thresholds can be argued with and checked without a window.
 */

/** While the panel is away and nobody is waiting. The cheapest moment. */
export const IDLE_AT = 0.6

/** The user has pressed Enter and will wait for the summary first. */
export const SEND_AT = 0.65

/**
 * Mid-task: a result is being handed back to the model by the app itself.
 *
 * Deliberately the highest of the three. This one costs a request in the
 * middle of a sequence the user is watching, and the two cheaper triggers
 * get first refusal at 60% and 65% - so reaching this one means the
 * conversation grew without the user touching it, which is exactly the
 * runaway case it is here for.
 */
export const MIDTASK_AT = 0.9

/** What kind of turn is about to be sent. */
export type Turn = 'send' | 'auto' | 'idle'

export function thresholdFor(turn: Turn): number {
  return turn === 'idle' ? IDLE_AT : turn === 'send' ? SEND_AT : MIDTASK_AT
}

/** How full the window is, as a fraction. Zero when the limit is nonsense. */
export function fullness(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.max(0, used) / limit
}

/**
 * Should this turn wait for a compaction first?
 *
 * One function for all three callers, so a threshold can never be compared
 * with the wrong operator in one place and the right one in another.
 */
export function needsRoom(turn: Turn, used: number, limit: number): boolean {
  return fullness(used, limit) > thresholdFor(turn)
}

/**
 * What the user is told when a result waited for a summary.
 *
 * Said out loud rather than done silently: the alternative is a pause in the
 * middle of a sequence they are watching, with the panel showing nothing
 * about why. The percentage is in it because it is the reason.
 */
export function roomNote(used: number, limit: number): string {
  return `The conversation was ${Math.round(fullness(used, limit) * 100)}% of the way full, so earlier turns were summarised before carrying on.`
}

/**
 * Did this request fail because what was sent was too big?
 *
 * The three ways it arrives, all seen from Google: a 400 naming the input
 * token count, a 429 against the per-minute TOKEN allowance rather than the
 * request count, and the generic "context length" wording the OpenAI-shaped
 * endpoints use. Matched on words rather than on a status code, because the
 * status alone cannot tell a token overrun from any other rejection - and
 * reacting to an ordinary 429 by rewriting the conversation would throw away
 * history to fix a problem that was only ever a wait.
 *
 * A false negative costs nothing: the turn fails the way it already did. A
 * false positive spends a request and summarises a conversation that did not
 * need it, so the patterns are narrow on purpose.
 */
export function tooBig(message: string): boolean {
  const text = (message ?? '').toLowerCase()
  if (!text) return false
  return (
    /input token count/.test(text) ||
    /token count exceeds/.test(text) ||
    /context length/.test(text) ||
    /context window/.test(text) ||
    /maximum.{0,20}tokens?\b/.test(text) ||
    /too many (?:input )?tokens/.test(text) ||
    /request (?:entity )?too large/.test(text) ||
    /tokens per minute/.test(text) ||
    /\btpm\b/.test(text)
  )
}

/**
 * The cost of a screenshot, for an estimate made before the provider counts.
 *
 * Measured on this app's own captures: 1,568 by 980 arrives as roughly 1,100
 * prompt tokens. The character-based estimate counts none of it, which was
 * survivable while pictures were rare and is not now that every step of a
 * plan returns one - twelve steps is thirteen thousand tokens the meter
 * could not see, in the exact loop that overflows.
 */
export const IMAGE_TOKENS = 1100

/** Characters at four to a token, plus the pictures. */
export function estimateTokens(chars: number, images = 0): number {
  return Math.ceil(Math.max(0, chars) / 4) + Math.max(0, Math.floor(images)) * IMAGE_TOKENS
}
