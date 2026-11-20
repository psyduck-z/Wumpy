/**
 * The commands currently waiting for a decision, so the keyboard can reach them.
 *
 * A proposal that needs approving is the one moment Wumpy asks for the mouse:
 * the buttons are in the transcript, not in the composer where the hands are.
 * Cards register here while they are waiting, and Ctrl+Enter approves the
 * newest — which is the one just proposed, and therefore the one being asked
 * about.
 */
export interface PendingCommand {
  run(): void
  skip(): void
  /** Shown in the hint strip so the key has something to refer to. */
  command: string
  /**
   * How to say it, for a voice turn asking out loud: "write notes.md", read
   * as "Can I write notes.md?". Commands leave it out - their "# why" line
   * already reads as a question (see @shared/spoken).
   */
  spoken?: string
}

const waiting = new Map<string, PendingCommand>()
const listeners = new Set<() => void>()

function announce(): void {
  for (const cb of listeners) cb()
}

export function registerPending(id: string, entry: PendingCommand): () => void {
  waiting.set(id, entry)
  announce()
  return () => {
    waiting.delete(id)
    announce()
  }
}

/** The most recently registered, which is the one on screen being asked about. */
export function newestPending(): PendingCommand | null {
  let last: PendingCommand | null = null
  for (const entry of waiting.values()) last = entry
  return last
}

export function pendingCount(): number {
  return waiting.size
}

/**
 * Cards waiting in one message. The line under the last answer asks this
 * rather than pendingCount: an unclicked card in an old message of a reopened
 * chat is not this turn waiting, and would have held "waiting for you" there
 * for good. Keys are the message id and the command; see CommandCard.
 */
export function pendingIn(messageId: string | null): number {
  if (!messageId) return 0
  let n = 0
  for (const key of waiting.keys()) if (key.startsWith(messageId)) n++
  return n
}

export function onPendingChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/* ------------------------------------------------------- what is running */

/**
 * Commands that have been approved and are still going.
 *
 * A voice turn has to tell "nothing is happening, the answer is final" from
 * "an install is half way through": in both, no answer is streaming and
 * nothing is waiting for a click. This is the difference.
 */
let running = 0

export function startedRunning(): () => void {
  running++
  announce()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    running = Math.max(0, running - 1)
    announce()
  }
}

export function runningCount(): number {
  return running
}
