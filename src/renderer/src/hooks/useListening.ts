import { useCallback, useRef, useState } from 'react'
import { listenTo, type AudioSource } from '../loopback'
import { record, type Recording } from '../recorder'
import type { Heard, Listening } from '@shared/meeting'

/**
 * A long listen, from the panel's point of view.
 *
 * Deliberately not part of `useDictation`, although they share the recorder
 * underneath. The two are opposites in every way that matters to the state
 * machine: dictation is seconds long, ends by itself at a pause, and hands
 * back one sentence to put in a box. This runs for an hour, must NOT end at a
 * pause - a silence in a meeting is a silence in a meeting - and hands back
 * nothing until it is asked.
 *
 * What they do share is the thing worth sharing: pieces cut at pauses and
 * transcribed while the next is still arriving. See src/renderer/src/recorder.
 */
export interface ListeningSession {
  on: boolean
  /** What it is listening to, while it is listening. */
  source: AudioSource
  /** Pieces so far. Grows while the meeting runs. */
  session: Listening | null
  /** Transcribed but not yet counted - the piece currently in Whisper. */
  pending: number
  error: string | null
  start(source: AudioSource): Promise<boolean>
  stop(): Promise<Listening | null>
  /** The transcript as it stands, without stopping. */
  peek(): Listening | null
}

/**
 * A ceiling, because a forgotten `/listen` is the likely failure.
 *
 * Four hours of transcript is a long meeting and a very long accident. The
 * text itself is small; what this bounds is a microphone and a loopback tap
 * left open overnight because the panel was closed and forgotten.
 */
const MAX_MS = 4 * 60 * 60 * 1000

export function useListening(commands: () => string[]): ListeningSession {
  const [on, setOn] = useState(false)
  const [source, setSource] = useState<AudioSource>('both')
  const [session, setSession] = useState<Listening | null>(null)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const live = useRef<Recording | null>(null)
  const closeAudio = useRef<(() => void) | null>(null)
  /** The pieces, in a ref: they arrive from a callback, out of React's sight. */
  const piecesRef = useRef<Heard[]>([])
  const startedAt = useRef(0)
  const chain = useRef<Promise<void>>(Promise.resolve())

  const snapshot = useCallback(
    (): Listening | null =>
      piecesRef.current.length || startedAt.current
        ? { startedAt: startedAt.current, pieces: [...piecesRef.current] }
        : null,
    []
  )

  const start = useCallback(
    async (want: AudioSource): Promise<boolean> => {
      if (live.current) return false
      setError(null)
      piecesRef.current = []
      startedAt.current = Date.now()
      chain.current = Promise.resolve()

      let audio: { stream: MediaStream; stop(): void }
      try {
        audio = await listenTo(want)
      } catch (err) {
        setError(
          err instanceof Error && /denied|not allowed|NotAllowed/i.test(err.message)
            ? 'Windows did not allow the capture. Nothing was recorded.'
            : err instanceof Error
              ? err.message
              : 'Could not start listening.'
        )
        return false
      }
      closeAudio.current = audio.stop

      const began = performance.now()
      try {
        live.current = await record({
          stream: audio.stream,
          /*
           * NEVER ENDS BY ITSELF. A pause in a meeting is a pause in a
           * meeting; dictation's 1.4-second silence timeout would stop
           * the session every time somebody thought about an answer.
           */
          silenceMs: null,
          maxMs: MAX_MS,
          /*
           * Longer pieces than dictation cuts.
           *
           * Dictation wants the last phrase transcribed the instant you
           * let go, so it cuts at every breath. Nobody is waiting here,
           * and Whisper is markedly better on a whole sentence than on a
           * fragment - so the pause that closes a piece is longer, and
           * the ceiling is half a minute rather than a few seconds.
           */
          segmentPauseMs: 1_200,
          minSegmentMs: 4_000,
          maxSegmentMs: 30_000,
          onSegment: (seg) => {
            if (seg.silent || seg.blob.size === 0) return
            const at = seg.index === 0 ? 0 : performance.now() - began - seg.ms
            setPending((n) => n + 1)
            chain.current = chain.current.then(async () => {
              try {
                const part = await window.wumpy.voice.transcribe(
                  await seg.blob.arrayBuffer(),
                  seg.extension,
                  commands()
                )
                const text = (part.text || part.heard || '').trim()
                if (text) {
                  piecesRef.current.push({ at: Math.max(0, at), text })
                  setSession(snapshot())
                }
              } catch {
                /* One lost piece is a gap in the notes, not the end of the
                   meeting. The next one is already being recorded. */
              } finally {
                setPending((n) => Math.max(0, n - 1))
              }
            })
          }
        })
      } catch (err) {
        audio.stop()
        closeAudio.current = null
        setError(err instanceof Error ? err.message : 'Could not start recording.')
        return false
      }

      setSource(want)
      setOn(true)
      setSession({ startedAt: startedAt.current, pieces: [] })
      return true
    },
    [commands, snapshot]
  )

  const stop = useCallback(async (): Promise<Listening | null> => {
    const recording = live.current
    live.current = null
    if (!recording) return snapshot()
    recording.stop()
    await recording.done
    closeAudio.current?.()
    closeAudio.current = null
    /* The last piece is still inside Whisper when the recording ends, and
       it is usually the one that matters - the thing said just before
       somebody reached for the keyboard. */
    await chain.current
    setOn(false)
    setPending(0)
    const final = snapshot()
    setSession(final)
    return final
  }, [snapshot])

  return { on, source, session, pending, error, start, stop, peek: snapshot }
}
