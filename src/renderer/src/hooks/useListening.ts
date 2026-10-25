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
  /**
   * Starts, and RETURNS why not.
   *
   * Not a boolean, and that is the whole of a bug worth remembering. The
   * caller used to read `listening.error` straight after awaiting this -
   * but `error` is React state, and the `listening` it was reading came
   * from the render that is still on screen, so it held whatever was there
   * BEFORE this ran: null. Every failure, whatever it was, printed the
   * fallback sentence "Could not start listening." and the real reason was
   * discarded one line after being worked out.
   *
   * Which is how a `mediaTypes` rule in main refusing the loopback request
   * went unexplained: the renderer knew, said so into a state nobody could
   * read yet, and the panel showed six words. A reason that is returned
   * cannot be stale.
   */
  start(source: AudioSource): Promise<string | null>
  stop(): Promise<Listening | null>
  /** The transcript as it stands, without stopping. */
  peek(): Listening | null
  /**
   * Stop if running, and throw the transcript away.
   *
   * For `/new`. The transcript rides along on every turn while it exists,
   * so it has to stop existing when the conversation it belongs to does -
   * otherwise an hour of somebody's standup is silently attached to a chat
   * about something else, and the only clue is the token count.
   */
  forget(): Promise<void>
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

  /** Remembered and handed back, so the caller never reads a stale render. */
  const failed = useCallback((why: string): string => {
    console.warn(`[listen] ${why}`)
    setError(why)
    return why
  }, [])

  const start = useCallback(
    async (want: AudioSource): Promise<string | null> => {
      /* Said out loud rather than returned bare: a silent false here was one
         of the three ways this could fail with nothing to show for it. */
      if (live.current) return failed('Already listening.')
      setError(null)
      piecesRef.current = []
      startedAt.current = Date.now()
      chain.current = Promise.resolve()

      let audio: { stream: MediaStream; stop(): void }
      try {
        audio = await listenTo(want)
      } catch (err) {
        /*
         * A NotAllowedError is not Windows saying no.
         *
         * There is no per-app permission for loopback and no privacy toggle
         * for it, so this is almost always Wumpy's own permission handler in
         * main/panel.ts refusing the request - which is exactly what it was
         * doing, and this sentence sent the reader to the Windows settings
         * instead. It names both now, in the order worth checking.
         */
        const name = err instanceof Error ? err.name : ''
        const message = err instanceof Error ? err.message : String(err)
        return failed(
          /denied|not allowed|NotAllowed/i.test(`${name} ${message}`)
            ? `The capture was refused (${name || 'NotAllowedError'}). Nothing was recorded.`
            : message || 'Could not start listening.'
        )
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
        return failed(err instanceof Error ? err.message : 'Could not start recording.')
      }

      setSource(want)
      setOn(true)
      setSession({ startedAt: startedAt.current, pieces: [] })
      return null
    },
    [commands, failed, snapshot]
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

  const forget = useCallback(async (): Promise<void> => {
    if (live.current) await stop()
    piecesRef.current = []
    startedAt.current = 0
    setSession(null)
    setError(null)
  }, [stop])

  return { on, source, session, pending, error, start, stop, peek: snapshot, forget }
}
