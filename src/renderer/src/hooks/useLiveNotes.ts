import { useCallback, useEffect, useRef } from 'react'
import {
  liveNotesCard,
  liveNotesDue,
  reached,
  wordCount,
  type Listening
} from '@shared/meeting'
import type { ListeningSession } from './useListening'

/**
 * Live meeting notes: one card in the chat, rewritten in place as the meeting
 * goes on, and given a final pass when it stops. See shared/meeting.ts LIVE
 * NOTES for what an update sends and why it changes items rather than adding
 * contradictions.
 */
export interface LiveNotes {
  /** One last update from the finished session, and the card marked final. */
  finish(session: Listening | null): Promise<void>
  /** Drop the notes (a new chat). */
  reset(): void
}

/** How often to ask whether an update is due; liveNotesDue decides. */
const TICK_MS = 15_000

interface Chat {
  liveNote(content: string): string
  update(id: string, content: string): void
}

export function useLiveNotes(listening: ListeningSession, chat: Chat): LiveNotes {
  const listeningRef = useRef(listening)
  listeningRef.current = listening
  const chatRef = useRef(chat)
  chatRef.current = chat

  const card = useRef<string | null>(null)
  const notes = useRef('')
  /** What the last update covered. */
  const last = useRef({ words: 0, seen: 0, at: 0, reached: 0 })
  /** Which session these notes belong to, by its start. */
  const owner = useRef(0)
  const busy = useRef<Promise<void> | null>(null)

  const reset = useCallback(() => {
    card.current = null
    notes.current = ''
    last.current = { words: 0, seen: 0, at: 0, reached: 0 }
    owner.current = 0
  }, [])

  const show = useCallback((session: Listening, live: boolean) => {
    if (!notes.current) return
    const content = liveNotesCard(notes.current, session, live)
    if (card.current) chatRef.current.update(card.current, content)
    else card.current = chatRef.current.liveNote(content)
  }, [])

  const refresh = useCallback(
    async (session: Listening, live: boolean): Promise<void> => {
      if (owner.current !== session.startedAt) {
        reset()
        owner.current = session.startedAt
      }
      const now = { words: wordCount(session), seen: session.seen?.length ?? 0, at: Date.now() }
      const changed = now.words !== last.current.words || now.seen !== last.current.seen
      if (live && !liveNotesDue(last.current, now)) return
      if (!live && !changed) {
        show(session, false)
        return
      }
      if (!live && !notes.current && now.words === 0 && now.seen === 0) return
      const text = await window.wumpy.voice
        .meetingNotes({ session, previous: notes.current, since: last.current.reached })
        .catch(() => null)
      /* A failed update leaves the notes as they were; the next tick tries again. */
      if (!text || owner.current !== session.startedAt) {
        if (!live) show(session, false)
        return
      }
      notes.current = text
      last.current = { ...now, reached: reached(session) }
      show(session, live)
    },
    [reset, show]
  )

  /* One update at a time: a slow model must not have two rewrites racing. */
  const run = useCallback(
    async (session: Listening, live: boolean): Promise<void> => {
      while (busy.current) await busy.current
      const job = refresh(session, live).finally(() => {
        busy.current = null
      })
      busy.current = job
      await job
    },
    [refresh]
  )

  useEffect(() => {
    if (!listening.on) return
    const timer = setInterval(() => {
      if (busy.current) return
      const session = listeningRef.current.peek()
      if (session) void run(session, true)
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [listening.on, run])

  const finish = useCallback(
    async (session: Listening | null): Promise<void> => {
      if (session) await run(session, false)
    },
    [run]
  )

  return { finish, reset }
}
