import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceStatus } from '@shared/types'
import { canRecord, record, type Recording } from '../recorder'

export type DictationState =
  /** No transcriber installed, or this build cannot record. */
  | 'unavailable'
  /** Ready to listen. */
  | 'idle'
  /** Loading the Whisper model, which only happens once per run. */
  | 'loading'
  | 'recording'
  /** Transcribing what was just said. */
  | 'working'
  | 'error'

export interface Dictation {
  state: DictationState
  /** True when the user has turned voice input on with /voice. */
  enabled: boolean
  /** 0..1 input level, for the meter. */
  level: number
  /** Why it is unavailable, or what went wrong. */
  detail: string | null
  /** The raw transcript of the last utterance, before correction. */
  heard: string | null
  /** True when the local model tidied the punctuation. */
  polished: boolean
  /** Starts listening, or stops if it already is. */
  toggle(): void
  /**
   * Starts listening for as long as a key is held.
   *
   * No silence timeout: the release is the signal, so trailing off mid-thought
   * does not cut the sentence short the way it would for the button.
   */
  beginHold(): void
  /** Stops listening and transcribes what was said. */
  finish(): void
  /** Throws away the recording in progress without transcribing it. */
  cancel(): void
  /** Clears the last error or transcript note. */
  dismiss(): void
}

/**
 * Dictation, from the button's point of view.
 *
 * The transcript is handed back rather than sent: speech recognition is typing
 * that happens to use a microphone, and a sentence that came out wrong has to be
 * as easy to fix as a mistyped one. Nothing here ever reaches the model without
 * the user pressing Enter.
 */
export function useDictation(onText: (text: string) => void, commands: string[]): Dictation {
  const [state, setState] = useState<DictationState>('unavailable')
  const [level, setLevel] = useState(0)
  const [detail, setDetail] = useState<string | null>(null)
  const [heard, setHeard] = useState<string | null>(null)
  const [polished, setPolished] = useState(false)
  const [on, setOn] = useState(false)

  const live = useRef<Recording | null>(null)
  const cancelled = useRef(false)
  /** What the pieces came back as, for the tidy pass at the end. */
  const spokenLanguage = useRef<string>('en')
  /**
   * Pieces transcribed while the user was still talking, by position.
   *
   * Held in a ref rather than state because nothing renders from it: it is
   * assembled once the recording ends and then thrown away.
   */
  const segmentsRef = useRef<{
    partials: Map<number, string>
    settled: () => Promise<void>
  } | null>(null)
  /**
   * Whether the user still wants this recording.
   *
   * Starting is not instantaneous: the first time, the model has to load, and
   * getUserMedia takes a moment after that. Nothing exists to stop during either
   * await - so letting go of the spacebar in that window used to do nothing, and
   * the recording then began on its own, unattended, with no silence timeout to
   * end it. This is checked after every await instead.
   */
  const wanted = useRef(false)
  // Through refs, so starting a recording does not depend on a callback identity
  // that changes every time the conversation does.
  const textRef = useRef(onText)
  const commandsRef = useRef(commands)
  textRef.current = onText
  commandsRef.current = commands

  const apply = useCallback((status: VoiceStatus) => {
    if (status.kind === 'ready') {
      setState((s) => (s === 'recording' || s === 'working' ? s : 'idle'))
      setDetail(null)
      return
    }
    if (status.kind === 'starting') {
      setState('loading')
      return
    }
    if (status.kind === 'absent' || status.kind === 'failed') {
      setState('unavailable')
      setDetail(status.detail)
    }
  }, [])

  /**
   * The two settings dictation needs, read here rather than threaded down as
   * props: the button is the only thing that cares about them, and a prop for
   * each would make every component in between know about the microphone.
   */
  const enabled = useRef(true)
  const autoStop = useRef(true)

  useEffect(() => {
    if (!canRecord()) {
      setState('unavailable')
      setDetail('This build cannot reach a microphone.')
      return
    }

    const read = (s: { voiceEnabled: boolean; voiceAutoStop: boolean }): void => {
      enabled.current = s.voiceEnabled
      autoStop.current = s.voiceAutoStop
      setOn(s.voiceEnabled)
      // Turning it off hides the button rather than disabling it, which is why
      // this leaves no detail behind: there is nothing wrong to explain.
      if (!s.voiceEnabled) {
        setState('unavailable')
        setDetail(null)
      } else {
        void window.wumpy.voice.status().then(apply)
      }
    }

    void window.wumpy.settings.get().then(read)
    const offSettings = window.wumpy.settings.onChange(read)
    const offStatus = window.wumpy.voice.onStatus((s) => {
      if (enabled.current) apply(s)
    })
    return () => {
      offSettings()
      offStatus()
    }
  }, [apply])

  const start = useCallback(
    async (held: boolean) => {
      // One at a time. The guards on `state` cannot catch a second call during the
      // awaits below, because state is still 'idle' until the recorder exists.
      if (wanted.current) return
      wanted.current = true
      cancelled.current = false
      setHeard(null)
      setPolished(false)
      setDetail(null)

      // Loading base.en takes a second or two the first time, and recording before
      // it is ready would mean talking into a process that is not listening yet.
      const status = await window.wumpy.voice.start()
      if (!wanted.current) {
        setState('idle')
        return
      }
      if (status.kind !== 'ready') {
        wanted.current = false
        apply(status)
        return
      }

      let recording: Recording
      try {
        setState('recording')
        /**
         * Each pause closes a piece, and each piece is transcribed while the
         * next is still being spoken.
         *
         * The whole clip used to go to Whisper when the user let go, so the
         * wait was proportional to how much had been said - and all of it
         * landed after the talking stopped, which is the worst possible moment
         * for it. Now a long dictation is mostly transcribed before the last
         * word, and what is left to do at the end is one phrase.
         *
         * Pieces are transcribed one at a time rather than all at once. The
         * transcriber is a single worker holding one model, so overlapping
         * requests would queue inside it anyway, and keeping the queue here
         * means the order is ours to guarantee.
         */
        const partials = new Map<number, string>()
        let chain: Promise<void> = Promise.resolve()
        /* Per recording, never carried over: what was said last time is not
           evidence about this time, and a stale `zh` would hold the English
           repairs off an English sentence. */
        spokenLanguage.current = 'en'

        recording = await record({
          onLevel: setLevel,
          // Held: the release ends it, so no silence timeout at all. Otherwise
          // null means push-to-talk with Ctrl+M at both ends.
          silenceMs: held ? null : autoStop.current ? 1400 : null,
          onSegment: (seg) => {
            // Nothing but room tone, which is what Whisper hallucinates over.
            if (seg.silent || seg.blob.size === 0) return
            chain = chain.then(async () => {
              if (cancelled.current) return
              try {
                const buffer = await seg.blob.arrayBuffer()
                const part = await window.wumpy.voice.transcribe(
                  buffer,
                  seg.extension,
                  commandsRef.current
                )
                if (part.heard?.trim()) partials.set(seg.index, part.heard.trim())
                /*
                 * WHAT LANGUAGE THE WHOLE THING WAS, decided by the pieces.
                 *
                 * The join at the end goes back through the repair tables,
                 * and those are English tables - so it has to be told what
                 * was actually spoken or it will capitalise and de-space a
                 * Chinese sentence. The last piece that carried words wins:
                 * detection is per clip, and the end of an utterance is
                 * where the detector had the most audio to work with.
                 */
                if (part.heard?.trim() && part.language) spokenLanguage.current = part.language
              } catch {
                // A piece that will not transcribe is not fatal: the whole clip
                // is kept and the end falls back to transcribing that instead.
                partials.set(seg.index, '')
              }
            })
          }
        })
        segmentsRef.current = { partials, settled: () => chain }
      } catch (err) {
        // Almost always the microphone being refused, by Windows or by the user.
        wanted.current = false
        setState('error')
        setDetail(
          err instanceof Error && /denied|not allowed|NotAllowed/i.test(err.message)
            ? 'Windows did not allow the microphone. Check Settings - Privacy - Microphone.'
            : err instanceof Error
              ? err.message
              : 'Could not start recording.'
        )
        return
      }

      live.current = recording
      // Let go while the microphone was opening: end it now rather than recording
      // into an empty room until the sixty-second ceiling.
      if (!wanted.current) recording.stop()

      const clip = await recording.done
      wanted.current = false
      live.current = null
      setLevel(0)

      if (cancelled.current) {
        setState('idle')
        return
      }
      if (!clip) {
        setState('idle')
        setDetail('Did not hear anything.')
        return
      }

      setState('working')
      try {
        /**
         * Wait for the pieces, then assemble - or fall back to the whole clip.
         *
         * Most of the work is already done by now; this is usually the last
         * phrase finishing. Falling back matters because a piece can fail on
         * its own (a truncated container, a worker restart) and the complete
         * recording is always kept, so one bad piece costs a little time
         * rather than the dictation.
         */
        const pieces = segmentsRef.current
        segmentsRef.current = null
        let joined = ''
        if (pieces) {
          await pieces.settled()
          const inOrder = [...pieces.partials.entries()].sort((a, b) => a[0] - b[0])
          const missing = inOrder.some(([, text]) => text === '')
          if (!missing)
            joined = inOrder
              .map(([, text]) => text)
              .join(' ')
              .trim()
        }

        if (cancelled.current) {
          setState('idle')
          return
        }

        /**
         * The joined text still goes through the transcriber's own tidying.
         *
         * Vocabulary fixes, the noise filter and the polish pass all live
         * behind this call, and a sentence assembled from pieces needs them as
         * much as one clip did - more, since the seams are where a capital or
         * a full stop goes missing. Passing text instead of audio skips Whisper
         * and keeps everything after it.
         */
        const result = joined
          ? await window.wumpy.voice.tidy(joined, commandsRef.current, spokenLanguage.current)
          : await window.wumpy.voice.transcribe(
              await clip.blob.arrayBuffer(),
              clip.extension,
              commandsRef.current
            )
        setState('idle')
        setHeard(result.heard || null)
        setPolished(result.polished)

        if (!result.text) {
          setDetail(result.heard ? 'Only heard noise.' : 'Did not hear anything.')
          return
        }
        // A low score usually means a word or two is wrong rather than the whole
        // sentence, so the text still goes in - with a note, because silently
        // presenting a guess as a transcript is the thing to avoid.
        if (result.confidence > 0 && result.confidence < 0.4) {
          setDetail('That was hard to make out - worth a read before sending.')
        }
        textRef.current(result.text)
      } catch (err) {
        setState('error')
        setDetail(err instanceof Error ? err.message : 'Could not transcribe that.')
      }
    },
    [apply]
  )

  const toggle = useCallback(() => {
    if (state === 'recording') {
      live.current?.stop()
      return
    }
    if (state === 'working' || state === 'loading') return
    void start(false)
  }, [state, start])

  const beginHold = useCallback(() => {
    void start(true)
  }, [start])

  const finish = useCallback(() => {
    wanted.current = false
    live.current?.stop()
  }, [])

  const cancel = useCallback(() => {
    if (!wanted.current && state !== 'recording') return
    cancelled.current = true
    wanted.current = false
    live.current?.stop()
  }, [state])

  // The panel closing mid-sentence must not leave the microphone open.
  useEffect(() => {
    return () => {
      cancelled.current = true
      wanted.current = false
      live.current?.stop()
    }
  }, [])

  const dismiss = useCallback(() => {
    setDetail(null)
    setHeard(null)
  }, [])

  return {
    state,
    enabled: on,
    level,
    detail,
    heard,
    polished,
    toggle,
    beginHold,
    finish,
    cancel,
    dismiss
  }
}
