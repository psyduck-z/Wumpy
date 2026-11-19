import { useSyncExternalStore } from 'react'

/**
 * Game writes held for an agent, and the ones let go again.
 *
 * A fresh answer that writes a game itself, with no agent, has its write
 * held while main hands the request to an agent (see gameWritten). Main can
 * say no - one key, no agents - and then the write is let go and goes ahead
 * as it would have. Kept outside React, like once.ts, so a re-render does
 * not lose it.
 */
const released = new Set<string>()
const listeners = new Set<() => void>()

export function release(messageId: string): void {
  released.add(messageId)
  for (const l of listeners) l()
}

export function useReleased(messageId: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => released.has(messageId)
  )
}
