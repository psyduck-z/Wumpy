/**
 * Output from commands that are still running, held outside React.
 *
 * Two reasons it does not live in the card's own state. The subscription has
 * to exist before the card asks for it, because the first chunk of a fast
 * command can arrive before the effect that would have listened for it has
 * run. And the card remounts — appending the "Ran:" message to the transcript
 * does it — so anything kept in a hook is lost halfway through a three-minute
 * install, which is precisely the case this feature exists for.
 *
 * Same shape as once.ts: module state keyed per run, cleared when the
 * conversation is.
 */
import type { ShellProgress } from '@shared/types'

const text = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()

let wired = false
function wire(): void {
  if (wired) return
  wired = true
  window.wumpy.shell.onProgress((p: ShellProgress) => {
    text.set(p.runId, p.text)
    for (const fn of listeners.get(p.runId) ?? []) fn()
  })
}

/** Everything the run has printed so far, or '' before its first write. */
export function liveOutput(runId: string): string {
  wire()
  return text.get(runId) ?? ''
}

/** Calls back whenever this run prints something. Returns the unsubscribe. */
export function onLive(runId: string, fn: () => void): () => void {
  wire()
  let set = listeners.get(runId)
  if (!set) {
    set = new Set()
    listeners.set(runId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(runId)
  }
}

/**
 * Dropped once the real result is on screen.
 *
 * The finished card shows the full captured output, so keeping the live copy
 * would be a second, shorter version of the same text held for as long as the
 * app is open.
 */
export function forgetLive(runId: string): void {
  text.delete(runId)
}

/** Cleared with the conversation, like the once-only claims. */
export function forgetAllLive(): void {
  text.clear()
}
