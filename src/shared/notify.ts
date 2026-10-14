import type { ChatMessage, DesktopResult, ShellResult } from './types'
import { shorten } from './activity'
import { needsElevation, neverRan, notOnPath } from './parsefail'

/**
 * One line in the transcript for each thing Wumpy did, and one line only.
 *
 * Asked for: "when you run a command or whatever, it adds a notification
 * inside your chat. If you run that same command twice consecutively, or
 * more, just update the previous one so that you can't spam."
 *
 * Both halves of that were missing. A command's output goes back to the model
 * as a turn nobody typed, and it was SHOWN as the user's own message - a
 * bubble reading "Ran: `dir`" on their side of the panel, next to things they
 * actually said. That is the misattribution they had already objected to for
 * screenshots ("it makes it look funky, so don't show things like that"), and
 * the fix there was the same one: send it, do not show it, and say what
 * happened in Wumpy's own voice instead.
 *
 * The second half is the part that needs a rule. A model that re-proposes a
 * command it has already run is this app's most common failure - enough of
 * one that autoRunEligible exists to refuse it - so the notification cannot
 * be one-line-per-event or the transcript becomes six identical lines in a
 * loop nobody asked for.
 *
 * So: consecutive among notifications. The model's own answer, the hidden
 * hand-back and any app notice in between do not break a run, because none of
 * them is the person doing anything. A line the user typed does break it, for
 * the same reason the unattended-run budget resets when they type: a count is
 * about repetition nobody is watching, and once they have spoken the next run
 * is a new thing they asked for.
 *
 * Pure, and shared rather than living in the hook, so the rule can be checked
 * against real message arrays without a window.
 */

/**
 * The two things that render as a chip.
 *
 * `notification` is Wumpy's own receipt: local, never sent, nothing but a
 * line for the person. `notice` is a fact the model has to act on, which is
 * also shown as a chip - collapsing those is worth it twice over, because a
 * repeat is paid for in the window as well as on screen.
 *
 * Notes are deliberately absent. A note is Wumpy answering something the
 * user just typed, and the typing is exactly what starts a count again.
 */
export type ChipKind = 'notification' | 'notice'

/** Which chip a message is, or null when it is not one. */
export function chipKind(message: ChatMessage): ChipKind | null {
  if (message.notification) return 'notification'
  // An aside is the user's own words, wearing a chip. Never counted.
  if (message.notice && !message.aside) return 'notice'
  return null
}

/** The message a new chip collapses onto, and what its count becomes. */
export interface Repeat {
  id: string
  /** Times this line has now happened, counting the first. */
  repeat: number
}

/**
 * Looks back for the chip this one repeats, or null to append a new one.
 *
 * Walks from the end so "consecutively" means what it says: the first chip
 * found is the only candidate, and a different chip in between ends the run
 * rather than being skipped over.
 */
export function repeatOf(
  messages: readonly ChatMessage[],
  kind: ChipKind,
  text: string
): Repeat | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // The person speaking starts the count again. Automatic turns are the
    // app handing something back to the model, not the person speaking -
    // and an aside is the person speaking even though it wears a chip.
    if (m.role === 'user' && !m.automatic) return null
    if (m.aside) return null
    const found = chipKind(m)
    if (!found) continue
    if (found !== kind || m.content !== text) return null
    return { id: m.id, repeat: (m.repeat ?? 1) + 1 }
  }
  return null
}

/**
 * Applies a repeat: the chip gets its count and moves to the end.
 *
 * Moved rather than updated where it stands, because the transcript is
 * pinned to the bottom while a turn runs and a count that climbs above the
 * fold is a receipt nobody sees. The id is kept, so it is the same chip
 * rather than a new one wearing a number.
 */
export function collapsed(
  messages: readonly ChatMessage[],
  again: Repeat,
  now: number
): ChatMessage[] {
  const found = messages.find((m) => m.id === again.id)
  if (!found) return [...messages]
  return [
    ...messages.filter((m) => m.id !== again.id),
    { ...found, repeat: again.repeat, createdAt: now }
  ]
}

/** How much of a command fits in a chip before it is cut. */
export const NOTIFY_CHARS = 56

/**
 * What a run says, in a person's words rather than the model's.
 *
 * The ending is the same judgement commandFeedback makes - from the same
 * helpers, in the same order - so the chip and the report can never disagree
 * about whether something worked. Said in four words, because the card
 * directly above it has the command, the output and the exit code.
 */
export function ranLine(result: ShellResult): string {
  const what = shorten(result.command, NOTIFY_CHARS)
  const ending = neverRan(result)
    ? ' — it never ran'
    : notOnPath(result)
      ? ' — nothing by that name to run'
      : needsElevation(result)
        ? ' — not allowed without admin'
        : result.timedOut
          ? ' — stopped at the time limit'
          : result.exitCode !== 0
            ? ' — it failed'
            : ''
  return `Ran \`${what}\`${ending}`
}

export function searchedLine(query: string): string {
  return `Searched the web for "${shorten(query, NOTIFY_CHARS)}"`
}

/**
 * What a plan of clicks says.
 *
 * Steps rather than the window, because the window name is long, often
 * absent, and already on the card. Where it stopped is the part that is
 * worth a line of its own: a plan that did four of seven steps looks exactly
 * like a plan that worked, from the transcript.
 */
export function desktopLine(result: DesktopResult): string {
  if (result.refused) return 'Left your screen alone'
  const ran = result.ran.length
  const steps = `${ran} step${ran === 1 ? '' : 's'}`
  if (result.stopped) return `Stopped after ${steps} on your screen`
  const failed = result.ran.filter((s) => !s.ok).length
  if (failed) return `Did ${steps} on your screen, ${failed} of them failed`
  return `Did ${steps} on your screen`
}

/**
 * A chip's text, split so `a command` can be set in code.
 *
 * The chips have always been rendered as plain text, so the backticks in
 * "Ran `x` — succeeded, no output" were on screen as backticks. Done here
 * rather than by handing the line to the markdown renderer: that is a
 * react-markdown tree per chip, for one span of code, inside a 10px line.
 */
export function inlineCode(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = []
  let rest = text
  for (;;) {
    const open = rest.indexOf('`')
    const close = open === -1 ? -1 : rest.indexOf('`', open + 1)
    // An unpaired backtick is left alone rather than guessed at.
    if (close === -1) break
    if (open > 0) parts.push({ code: false, text: rest.slice(0, open) })
    parts.push({ code: true, text: rest.slice(open + 1, close) })
    rest = rest.slice(close + 1)
  }
  if (rest) parts.push({ code: false, text: rest })
  return parts
}
