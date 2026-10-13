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
import { attachmentTokens, sendsBytes, type Attached } from './attach'

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
 * The smallest conversation worth summarising, in tokens.
 *
 * Because the pressure is not always the conversation. The instructions are
 * about 13,300 tokens of a 32,768 budget and a summary cannot touch them, so
 * a chat holding two short messages can sit above the send-time threshold
 * with nothing to compact. Without this floor that is a loop: compact,
 * still over, send, compact again - a request spent per turn, buying
 * nothing, and the user is never told why.
 *
 * Two thousand tokens is roughly five exchanges, or one screenshot and its
 * report. Below that, summarising is not the answer and saying so is.
 */
export const MIN_COMPACTABLE = 2000

/**
 * Don't summarise twice in a minute automatically.
 *
 * The same protection from the other side, for the case where a summary does
 * help but not enough. Each compaction is a model request out of a tier
 * counted per day, and two in quick succession means the second one is
 * summarising a summary.
 */
export const COMPACT_COOLDOWN_MS = 60_000

/**
 * Should this turn wait for a compaction first?
 *
 * One function for all three callers, so a threshold can never be compared
 * with the wrong operator in one place and the right one in another.
 *
 * `instructions` is the part of `used` that a summary cannot shrink. Passing
 * it is what stops the preamble from triggering compactions that cannot
 * possibly help.
 */
export function needsRoom(turn: Turn, used: number, limit: number, instructions = 0): boolean {
  if (fullness(used, limit) <= thresholdFor(turn)) return false
  return used - Math.max(0, instructions) >= MIN_COMPACTABLE
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

/**
 * The same estimate when the attachments are not all pictures.
 *
 * `estimateTokens` charges a flat 1,100 per attachment, which was right while
 * an attachment could only be an image or a clip. A text file costs its own
 * length over four - a 16,000-character file is 4,000 tokens, not 1,100 - and
 * a file that could not be read at all costs one sentence. Charging those as
 * photographs made the meter wrong in both directions at once.
 */
export function estimateWithFiles(
  chars: number,
  files: readonly Attached[],
  keepBytes = KEEP_PICTURES
): number {
  let total = Math.ceil(Math.max(0, chars) / 4)
  /* Only the newest few byte-carrying attachments are actually sent, so only
     those are charged: see trimPictures. Text is always sent. */
  let budget = Math.max(0, Math.floor(keepBytes))
  for (const file of [...files].reverse()) {
    if (sendsBytes(file.kind)) {
      if (budget <= 0) continue
      budget--
    }
    total += attachmentTokens(file)
  }
  return total
}

/**
 * How many screenshots the model is actually sent.
 *
 * Every image in the conversation was re-sent on every turn. That was a
 * deliberate choice while a picture was a rare thing the user attached - "a
 * follow-up question about a screenshot two turns back still has the
 * screenshot" - and it became something else entirely once every step of a
 * desktop plan returns one.
 *
 * The cost is quadratic. Turn one sends one picture, turn two sends two,
 * turn ten sends ten: fifty-five pictures over a ten-step sequence, about
 * 60,000 tokens of photographs, for ten pictures' worth of information.
 * Against a free tier that is counted per minute and per day.
 *
 * Two, because the useful comparison is before and after: the screen as it
 * was and the screen as it is. Anything older has been superseded by the
 * thing that was done to it, and the model is told it was dropped rather
 * than left to wonder why its description of turn three no longer matches.
 */
export const KEEP_PICTURES = 2

/** What is said in place of a picture that is no longer attached. */
export const DROPPED_PICTURE =
  '(The screenshot that was attached here is no longer being sent, to leave room. Look again if you need it.)'

/**
 * Where the list of on-screen controls begins, so it can go with its picture.
 *
 * The same quadratic cost as the screenshots, in text, and missed on the
 * first pass because it does not look like an attachment. Every screenshot
 * carries up to sixty named controls - about 580 tokens - written into the
 * message body, and those were never trimmed: ten steps of a desktop plan
 * re-sent 5,790 tokens of control lists on every turn after the tenth.
 *
 * It is also wrong, which matters more. The list says these controls are on
 * screen RIGHT NOW. For every list but the newest that is false - the window
 * has been clicked, typed into and scrolled since - so the model was being
 * handed nine stale descriptions of a window, each asserting it was current,
 * while the picture they described had already been dropped for being out of
 * date. Nothing marked them as past.
 *
 * Matched by its own first line rather than by a marker, so chats saved
 * before this existed are trimmed too.
 */
export const CONTROLS_LINE = /^\s*These \d+ controls are on screen right now/m

/** What is said in place of a control list that has been superseded. */
export const DROPPED_CONTROLS =
  '(The list of what was on screen at that point is no longer being sent: the window has changed since. Look again to get the current one.)'

/**
 * Cuts the control list off the end of a message, leaving the rest.
 *
 * The list is always written last, so everything from its first line to the
 * end of the message is the list. Returns the text unchanged when there is
 * none, which is every message that is not a screenshot.
 */
export function withoutControls(content: string): { text: string; cut: boolean } {
  const at = content.search(CONTROLS_LINE)
  if (at < 0) return { text: content, cut: false }
  return { text: content.slice(0, at).trimEnd(), cut: true }
}

/**
 * The conversation as it should go out: only the newest pictures attached.
 *
 * Pure, and returns new objects rather than editing them, because the
 * transcript the user is looking at keeps every picture it ever showed. This
 * is only what crosses the wire.
 */
export function trimPictures<T extends { content: string; images?: Array<{ kind?: string }> }>(
  messages: readonly T[],
  keep: number = KEEP_PICTURES
): T[] {
  /*
   * Only what is MADE of bytes counts as a picture here.
   *
   * A text file attached eight turns ago is characters in the prompt like any
   * other characters: dropping it would take away the file the conversation
   * has been about, to save nothing that a summary would not save better. An
   * image, a clip or a PDF is the expensive, re-sent, supersedable thing this
   * function exists for.
   */
  const heavy = (m: T): boolean => (m.images ?? []).some((a) => sendsBytes((a.kind ?? 'image') as never))
  const withPictures = messages.map((m, i) => (heavy(m) ? i : -1)).filter((i) => i >= 0)
  /* slice(-0) is slice(0), which keeps the whole array: asking for none
     would have kept every picture. Caught by the check that asked for none. */
  const wanted = Math.max(0, Math.floor(keep))
  const kept = new Set(wanted === 0 ? [] : withPictures.slice(-wanted))
  return messages.map((m, i) => {
    if (!heavy(m) || kept.has(i)) return m
    /* The light attachments stay; only the bytes go. */
    const rest = (m.images ?? []).filter((a) => !sendsBytes((a.kind ?? 'image') as never))
    /* The control list describes the picture, so it goes when the picture
       does - and says it went, because an absent list is a model looking
       again while a stale one is a model pressing something that moved. */
    const trimmed = withoutControls(m.content)
    const notes = [DROPPED_PICTURE, trimmed.cut ? DROPPED_CONTROLS : '']
      .filter(Boolean)
      .join(String.fromCharCode(10))
    const note = trimmed.text.trim()
      ? `${trimmed.text}${String.fromCharCode(10)}${notes}`
      : notes
    const next = { ...m, content: note } as T
    if (rest.length) return { ...next, images: rest }
    const { images: _dropped, ...bare } = next
    return bare as T
  })
}
