import { useCallback, useEffect, useRef, useState } from 'react'
import { HistoryWalk } from '../history'

/**
 * Walks back through what the user has typed before, as a shell or Claude Code
 * does: Up goes older, Down goes newer, and coming back past the newest entry
 * restores whatever was half-written before the walk began.
 *
 * The walk itself lives in HistoryWalk, which is plain and tested; this is only
 * the wiring to the main process and the one piece of state React needs to
 * re-render on.
 */
export interface InputHistory {
  /** Older. Returns the text to show, or null when there is nothing older. */
  older(current: string): string | null
  /** Newer, ending at the stashed draft. Null when already at the newest. */
  newer(): string | null
  /** True while showing a recalled entry rather than the live draft. */
  browsing: boolean
  /** Records a submitted line and leaves the walk. */
  push(text: string): void
  /** Abandons the walk without changing the box. */
  reset(): void
}

export function useInputHistory(): InputHistory {
  const walk = useRef(new HistoryWalk())
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    void window.wumpy.history.get().then((list) => walk.current.load(list))
  }, [])

  const older = useCallback((current: string): string | null => {
    const text = walk.current.older(current)
    if (text !== null) setBrowsing(walk.current.browsing)
    return text
  }, [])

  const newer = useCallback((): string | null => {
    const text = walk.current.newer()
    if (text !== null) setBrowsing(walk.current.browsing)
    return text
  }, [])

  const reset = useCallback(() => {
    walk.current.reset()
    setBrowsing(false)
  }, [])

  const push = useCallback((text: string) => {
    const entry = text.trim()

    /**
     * A line carrying an API key is never remembered, here or on disk.
     *
     * Input history survives restarts, so without this a key would sit in a
     * plain file and come back on one press of Up - which would undo the point
     * of encrypting it with safeStorage in the first place. `/key google clear`
     * is harmless and still worth not recording, so the whole command is
     * excluded rather than only the lines with a secret in them.
     */
    /* No \b after the word: anything beginning `/key` is treated as possibly
       carrying one. A near-miss is the dangerous case - `/keys nvidia
       <secret>` is one letter from the real command, and if some later
       command happened to answer to that spelling the line would be stored
       in plain text. Nothing whose name starts with "key" is worth
       remembering anyway. */
    /* `/sync key <github token>` carries one too. */
    if (/^\/(key|apikey)/i.test(entry) || /^\/sync\s+(key|token)\b/i.test(entry)) {
      setBrowsing(false)
      return
    }

    // Recorded locally first, so Up reaches the line just sent without waiting
    // for a round trip to the main process.
    walk.current.push(text)
    setBrowsing(false)
    if (!entry) return
    void window.wumpy.history.add(entry).then((list) => walk.current.load(list))
  }, [])

  return { older, newer, browsing, push, reset }
}
