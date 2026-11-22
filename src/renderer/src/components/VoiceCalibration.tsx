import { useEffect, useRef, useState } from 'react'
import { record, type Recording } from '../recorder'
import { clipForSpeech } from '../wav'
import type { VoiceprintState } from '@shared/types'
import { STEADY_BELOW } from '@shared/voiceprint'

/**
 * Calibrating the voiceprint: the person reads a few sentences, so Wumpy
 * knows their voice from the start rather than learning it from whoever
 * talked first (see shared/voiceprint.ts).
 *
 * "you can also, like, you know, calibrate your voice"
 *
 * The microphone is opened once, the way a conversation opens it (the
 * system default, the same processing), so the voice is learned as the
 * conversations will hear it - and an earbud's switch to headset mode,
 * which takes seconds, happens once rather than before every sentence.
 */

/** Read aloud, one at a time: varied sounds, the length of a real request. */
export const SENTENCES = [
  'Hey Wumpy, what does the weather look like for the rest of the week?',
  'Open my downloads folder and show me the newest file in there.',
  'Remind me to call the dentist tomorrow morning at half past nine.',
  'Read me the first paragraph, then sum up the rest in two sentences.',
  'Play something calm while I finish working on this project.',
  'Six thick thistle sticks, and a jar of fresh orange juice, please.',
  'Could you check whether my earbuds are charged before I head out?',
  'Search the web for a quick recipe that uses rice, garlic and eggs.'
]

/** A pause this long after talking ends the sentence: long enough for a breath mid-way. */
const END_PAUSE_MS = 1500
/** Before the first word, the wait is not cut off; after it, no sentence is longer than this. */
const LONGEST_MS = 20_000
/** Half a second before the first word is kept, as a conversation keeps it. */
const PRE_ROLL_MS = 500

type Stage =
  | { kind: 'opening' }
  | { kind: 'reading'; heard: boolean }
  | { kind: 'checking' }
  | { kind: 'done'; state: VoiceprintState }
  | { kind: 'failed'; message: string }

const REFUSED: Record<string, string> = {
  short: 'That was too short to learn from. Read the whole sentence, at your normal pace.',
  unlike: 'That didn’t sound like the sentences before it. Read it again, close to the mic.',
  restart: 'The first two sentences didn’t sound like the same voice, so it’s starting again. Read in a quiet spot.',
  nothing: 'Nothing was heard. Read the sentence aloud when you’re ready.',
  unavailable: 'The voice model isn’t available right now (it needs a one-time 29 MB download).'
}

export function VoiceCalibration(props: { onClose(state: VoiceprintState | null): void }): React.JSX.Element {
  const { onClose } = props
  const [stage, setStage] = useState<Stage>({ kind: 'opening' })
  const [count, setCount] = useState(0)
  const [needed, setNeeded] = useState(5)
  const [sentence, setSentence] = useState(0)
  const [level, setLevel] = useState(0)
  const [hint, setHint] = useState('')
  const [device, setDevice] = useState('')
  /* Skip and Done reach into the loop below. */
  const current = useRef<Recording | null>(null)
  const skipped = useRef(false)
  const closed = useRef(false)

  useEffect(() => {
    let mic: MediaStream | null = null
    closed.current = false
    const stopMic = (): void => {
      for (const t of mic?.getTracks() ?? []) t.stop()
      mic = null
    }

    void (async () => {
      try {
        const [start, stream] = await Promise.all([
          window.wumpy.voice.enrolStart(),
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          })
        ])
        mic = stream
        if (closed.current) return stopMic()
        setNeeded(start.needed)
        if (!start.ready) {
          setStage({ kind: 'failed', message: REFUSED.unavailable })
          return stopMic()
        }
        const label = stream.getAudioTracks()[0]?.label ?? ''
        setDevice(label)

        let taken = 0
        let at = 0
        while (!closed.current && taken < start.needed) {
          setSentence(at % SENTENCES.length)
          setStage({ kind: 'reading', heard: false })
          skipped.current = false
          const r = await record({
            stream,
            silenceMs: END_PAUSE_MS,
            maxMs: LONGEST_MS,
            maxFromSpeech: true,
            onLevel: (l) => setLevel(l),
            onSpeech: () => setStage({ kind: 'reading', heard: true })
          })
          current.current = r
          const clip = await r.done
          current.current = null
          setLevel(0)
          if (closed.current) break
          if (skipped.current) {
            setHint('')
            at++
            continue
          }
          if (!clip) {
            setHint(REFUSED.nothing)
            continue
          }
          setStage({ kind: 'checking' })
          const ready = await clipForSpeech(clip.blob, clip.extension, Math.max(0, r.onsetMs() - PRE_ROLL_MS))
          if (closed.current) break
          if (ready.extension !== 'wav') {
            setHint('That recording couldn’t be read. Try that sentence again.')
            continue
          }
          const got = await window.wumpy.voice.enrolClip(ready.audio, label)
          if (closed.current) break
          taken = got.count
          setCount(got.count)
          if (got.ok) {
            setHint('')
            at++
          } else if (got.why === 'unavailable') {
            setStage({ kind: 'failed', message: REFUSED.unavailable })
            return stopMic()
          } else setHint(got.restart ? REFUSED.restart : REFUSED[got.why ?? 'short'])
        }
        stopMic()
        if (closed.current) return
        setStage({ kind: 'done', state: await window.wumpy.voice.enrolFinish() })
      } catch (err) {
        stopMic()
        if (!closed.current) setStage({ kind: 'failed', message: `The microphone could not be used (${String(err)}).` })
      }
    })()

    return () => {
      closed.current = true
      current.current?.stop()
      stopMic()
      void window.wumpy.voice.enrolCancel()
    }
  }, [])

  const close = (): void => {
    closed.current = true
    current.current?.stop()
    onClose(stage.kind === 'done' ? stage.state : null)
  }

  const steady = stage.kind === 'done' ? stage.state.steadiness : null
  const status =
    stage.kind === 'opening'
      ? 'Opening the microphone…'
      : stage.kind === 'checking'
        ? 'Checking…'
        : stage.kind === 'reading'
          ? stage.heard
            ? 'Listening — pause when you’re done'
            : 'Read this aloud'
          : ''

  return (
    <div className="calibrate" role="dialog" aria-label="Calibrate your voice">
      <div className="calibrate-head">
        <span className="calibrate-title">Calibrate your voice</span>
        {stage.kind !== 'done' && stage.kind !== 'failed' && (
          <span className="calibrate-count">
            {count} of {needed}
          </span>
        )}
      </div>

      {(stage.kind === 'reading' || stage.kind === 'checking' || stage.kind === 'opening') && (
        <>
          <p className="calibrate-sentence">{stage.kind === 'opening' ? ' ' : `“${SENTENCES[sentence]}”`}</p>
          <div className={`calibrate-status${stage.kind === 'reading' && stage.heard ? ' is-heard' : ''}`}>
            <span className="calibrate-meter" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.max(0.04, stage.kind === 'reading' ? level : 0)})` }} />
            </span>
            <span>{status}</span>
          </div>
          {hint && <p className="calibrate-hint">{hint}</p>}
          <div className="calibrate-actions">
            {stage.kind === 'reading' && stage.heard && (
              <button type="button" onClick={() => current.current?.stop()}>
                Done
              </button>
            )}
            {stage.kind === 'reading' && (
              <button
                type="button"
                onClick={() => {
                  skipped.current = true
                  current.current?.stop()
                }}
              >
                Another sentence
              </button>
            )}
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
          <p className="calibrate-foot">
            {device ? `On ${device}. ` : ''}Use the mic you talk to Wumpy with — your earbuds, if that’s how you use it. Stays on this
            PC.
          </p>
        </>
      )}

      {stage.kind === 'done' && (
        <>
          <p className="calibrate-sentence is-plain">
            Done. Wumpy knows your voice now: in conversations, other voices aren’t answered, and a spoken “yes” to run
            something has to be yours.
          </p>
          {steady !== null && steady !== undefined && steady < STEADY_BELOW && (
            <p className="calibrate-hint">
              Your sentences didn’t sound very alike ({steady.toFixed(2)}), which usually means a noisy room or a weak mic.
              If Wumpy starts ignoring you, calibrate again somewhere quieter.
            </p>
          )}
          <div className="calibrate-actions">
            <button type="button" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}

      {stage.kind === 'failed' && (
        <>
          <p className="calibrate-hint">{stage.message}</p>
          <div className="calibrate-actions">
            <button type="button" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  )
}
