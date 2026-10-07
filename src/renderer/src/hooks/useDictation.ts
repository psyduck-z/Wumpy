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

  const live = useRef<Recording | null>(null)
  const cancelled = useRef(false)
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

  const start = useCallback(async () => {
    cancelled.current = false
    setHeard(null)
    setPolished(false)
    setDetail(null)

    // Loading base.en takes a second or two the first time, and recording before
    // it is ready would mean talking into a process that is not listening yet.
    const status = await window.wumpy.voice.start()
    if (status.kind !== 'ready') {
      apply(status)
      return
    }

    let recording: Recording
    try {
      setState('recording')
      recording = await record({
        onLevel: setLevel,
        // Null means push-to-talk: Ctrl+M again to finish.
        silenceMs: autoStop.current ? 1400 : null
      })
    } catch (err) {
      // Almost always the microphone being refused, by Windows or by the user.
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
    const clip = await recording.done
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
      const buffer = await clip.blob.arrayBuffer()
      const result = await window.wumpy.voice.transcribe(buffer, clip.extension, commandsRef.current)
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
  }, [apply])

  const toggle = useCallback(() => {
    if (state === 'recording') {
      live.current?.stop()
      return
    }
    if (state === 'working' || state === 'loading') return
    void start()
  }, [state, start])

  const cancel = useCallback(() => {
    if (state !== 'recording') return
    cancelled.current = true
    live.current?.stop()
  }, [state])

  // The panel closing mid-sentence must not leave the microphone open.
  useEffect(() => {
    return () => {
      cancelled.current = true
      live.current?.stop()
    }
  }, [])

  const dismiss = useCallback(() => {
    setDetail(null)
    setHeard(null)
  }, [])

  return { state, level, detail, heard, polished, toggle, cancel, dismiss }
}
