import { clipForSpeech } from '../wav'
import { useCallback, useEffect, useRef, useState } from 'react'
import { listenTo, type AudioSource } from '../loopback'
import { record, SPEECH_LEVEL, type Recording } from '../recorder'
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
  /**
   * How loud it is right now, 0..1, for a meter on the pill.
   *
   * Dictation has had one since the beginning and this had none, which is
   * half of why a session that was hearing nothing looked exactly like a
   * session that was hearing a meeting. An open microphone with no sign of
   * what it can hear is a thing you have to take on faith for an hour.
   *
   * Coarse on purpose - see `BARS`. This is a bar in the corner, not an
   * oscilloscope, and it must not cost a re-render per animation frame for
   * the length of a meeting.
   */
  level: number
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

/**
 * How many steps the meter is quantised to before it reaches React.
 *
 * The level arrives on every animation frame. Putting that in state is 60
 * re-renders a second of the whole status bar, for an hour, to move a bar a
 * fraction of a pixel. Rounded to sixteenths, a quiet room sets state once
 * and then stops, and talking moves it a handful of times a second - which
 * is as much as a 24px bar can show anyway.
 */
const BARS = 16

/**
 * How often the session says what it is hearing, into wumpy.log.
 *
 * Thirty seconds, because the thing being diagnosed takes minutes to become
 * suspicious and the line is one line. Short enough that a four-hour session
 * is still under five hundred lines, and the log keeps its last 512KB.
 */
const BEAT_MS = 30_000

/** Two significant figures is all an RMS reading is worth in a log line. */
const rms = (n: number): string => n.toFixed(4)

export function useListening(commands: () => string[]): ListeningSession {
  const [on, setOn] = useState(false)
  const [source, setSource] = useState<AudioSource>('both')
  const [session, setSession] = useState<Listening | null>(null)
  const [pending, setPending] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const live = useRef<Recording | null>(null)
  const closeAudio = useRef<(() => void) | null>(null)
  /** The pieces, in a ref: they arrive from a callback, out of React's sight. */
  const piecesRef = useRef<Heard[]>([])
  const startedAt = useRef(0)
  const chain = useRef<Promise<void>>(Promise.resolve())

  /*
   * What the heartbeat reports, all in refs: these are written from an
   * animation frame and from a transcription callback, neither of which is
   * a render, and none of them is on screen.
   */
  const stepRef = useRef(0)
  /** Loudest raw RMS since the last beat - the number the gate compares. */
  const peakRef = useRef(0)
  const nowRef = useRef(0)
  /** When the level last crossed SPEECH_LEVEL, or 0 for never. */
  const spokeRef = useRef(0)
  /** Pieces the recorder cut, pieces Whisper returned nothing for. */
  const cutRef = useRef(0)
  const emptyRef = useRef(0)
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const say = useCallback((line: string): void => {
    window.wumpy.voice.log(line)
  }, [])

  const stopBeat = useCallback((): void => {
    if (beatRef.current === null) return
    clearInterval(beatRef.current)
    beatRef.current = null
  }, [])

  /* An hour-long interval outliving the panel is the one leak this hook can
     have; the session itself is torn down by `stop`. */
  useEffect(() => stopBeat, [stopBeat])

  const snapshot = useCallback(
    (): Listening | null =>
      piecesRef.current.length || startedAt.current
        ? { startedAt: startedAt.current, pieces: [...piecesRef.current] }
        : null,
    []
  )

  /** Remembered, handed back, and written down, so no failure is only on screen. */
  const failed = useCallback(
    (why: string): string => {
      console.warn(`[listen] ${why}`)
      say(`could not start: ${why}`)
      setError(why)
      return why
    },
    [say]
  )

  /**
   * One line of what it is hearing, every BEAT_MS.
   *
   * The first branch is the one this was written for. A peak that never
   * reaches SPEECH_LEVEL means the recorder cut nothing, so Whisper saw
   * nothing, so the transcript is empty - and the session looks from the
   * outside exactly like a quiet room. Said in those words, with both
   * numbers, it takes one glance at the log instead of an afternoon.
   */
  const beat = useCallback((): void => {
    const seconds = Math.round((Date.now() - startedAt.current) / 1000)
    const peak = peakRef.current
    peakRef.current = 0
    const words = piecesRef.current.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0)
    const heard = `${seconds}s in: peak ${rms(peak)}, now ${rms(nowRef.current)}`
    if (!spokeRef.current) {
      say(
        `${heard} — never once above the ${SPEECH_LEVEL} speech gate, so nothing ` +
          `has been cut and nothing has reached the transcriber. Check the ` +
          `output device the meeting is playing to, and the volume.`
      )
      return
    }
    const ago = Math.round((performance.now() - spokeRef.current) / 1000)
    say(
      `${heard}, speech ${ago}s ago, ${cutRef.current} pieces cut, ` +
        `${emptyRef.current} came back empty, ${words} words`
    )
  }, [say])

  const start = useCallback(
    async (want: AudioSource): Promise<string | null> => {
      /* Said out loud rather than returned bare: a silent false here was one
         of the three ways this could fail with nothing to show for it. */
      if (live.current) return failed('Already listening.')
      setError(null)
      piecesRef.current = []
      startedAt.current = Date.now()
      chain.current = Promise.resolve()
      peakRef.current = 0
      nowRef.current = 0
      spokeRef.current = 0
      cutRef.current = 0
      emptyRef.current = 0
      stepRef.current = 0
      setLevel(0)

      let audio: Awaited<ReturnType<typeof listenTo>>
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
      /* Named devices, before anything can go wrong with them. A mic that is
         not the one in the headset, or a loopback tap on an output the call
         is not using, is invisible everywhere else. */
      say(`started (${want}) on ${audio.sources.map((s) => `"${s}"`).join(' + ') || 'no named device'}`)

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
          /*
           * Both numbers: the curved one is drawn, the raw one is judged.
           *
           * Quantised before it touches state - see BARS - so a silent hour
           * is one render, not two hundred thousand.
           */
          onLevel: (shown, raw) => {
            nowRef.current = raw
            if (raw > peakRef.current) peakRef.current = raw
            if (raw > SPEECH_LEVEL) spokeRef.current = performance.now()
            const step = Math.round(shown * BARS)
            if (step === stepRef.current) return
            stepRef.current = step
            setLevel(step / BARS)
          },
          onSegment: (seg) => {
            if (seg.silent || seg.blob.size === 0) return
            cutRef.current += 1
            const at = seg.index === 0 ? 0 : performance.now() - began - seg.ms
            setPending((n) => n + 1)
            chain.current = chain.current.then(async () => {
              try {
                const ready = await clipForSpeech(seg.blob, seg.extension)
                const part = await window.wumpy.voice.transcribe(ready.audio, ready.extension, commands())
                const text = (part.text || part.heard || '').trim()
                if (text) {
                  piecesRef.current.push({ at: Math.max(0, at), text })
                  setSession(snapshot())
                } else {
                  /* Audible enough to cut and nothing came back: the other
                     shape of a silent transcript, and a different fault from
                     never cutting at all. The heartbeat tells them apart. */
                  emptyRef.current += 1
                }
              } catch (err) {
                /* One lost piece is a gap in the notes, not the end of the
                   meeting. The next one is already being recorded - but it is
                   written down, because a transcriber failing on every piece
                   looks from the outside like a room with nobody in it. */
                emptyRef.current += 1
                say(`a piece did not transcribe: ${err instanceof Error ? err.message : String(err)}`)
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
      stopBeat()
      beatRef.current = setInterval(beat, BEAT_MS)
      return null
    },
    [beat, commands, failed, say, snapshot, stopBeat]
  )

  const stop = useCallback(async (): Promise<Listening | null> => {
    const recording = live.current
    live.current = null
    stopBeat()
    setLevel(0)
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
    /* The last word on the session, so a log read afterwards says what it
       got rather than only what it was doing. */
    say(
      `stopped after ${Math.round((Date.now() - startedAt.current) / 1000)}s: ` +
        `${cutRef.current} pieces cut, ${emptyRef.current} empty, ` +
        `${final?.pieces.length ?? 0} kept`
    )
    return final
  }, [say, snapshot, stopBeat])

  const forget = useCallback(async (): Promise<void> => {
    if (live.current) await stop()
    piecesRef.current = []
    startedAt.current = 0
    setSession(null)
    setError(null)
  }, [stop])

  return { on, source, session, pending, level, error, start, stop, peek: snapshot, forget }
}
