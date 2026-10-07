/**
 * Recording a sentence from the microphone.
 *
 * Kept out of React because it is a state machine over hardware, not over
 * rendering: a stream, a recorder, an audio graph and two timers, all of which
 * have to be torn down in the right order whether the user stopped it, silence
 * stopped it, or the panel closed under it.
 *
 * It ends by itself when you stop talking. Push-to-talk works too, but having to
 * press a key twice to say one sentence is worse than the app noticing - and the
 * cost of getting it wrong is low, because the transcript lands in the box for
 * review rather than being sent.
 */

/** What the caller needs to know while recording, for the meter and the label. */
export interface RecorderEvents {
  /** 0..1, roughly how loud it is right now. */
  onLevel?(level: number): void
  onStop?(reason: 'silence' | 'asked' | 'limit'): void
}

export interface RecorderOptions extends RecorderEvents {
  /** End after this long without speech. Null never ends by itself. */
  silenceMs?: number | null
  /** A hard ceiling, so a stuck recording cannot fill the disk. */
  maxMs?: number
}

export interface Recording {
  /** Ends it early. Safe to call twice. */
  stop(): void
  /** Resolves with the audio once it has ended, or null if nothing was said. */
  done: Promise<{ blob: Blob; extension: string; ms: number } | null>
}

/**
 * The quietest level still counted as speech.
 *
 * From RMS over a 2048-sample window, which puts a quiet room around 0.01 and
 * ordinary speech an order of magnitude above it. Erring low costs a little
 * trailing silence, which the transcriber's own voice detection trims anyway;
 * erring high cuts people off mid-sentence.
 */
const SPEECH_LEVEL = 0.02

/** Formats the recorder can produce, best first. */
const FORMATS = [
  { mime: 'audio/webm;codecs=opus', extension: 'webm' },
  { mime: 'audio/webm', extension: 'webm' },
  { mime: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mime: 'audio/mp4', extension: 'm4a' }
]

function pickFormat(): { mime: string; extension: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) ?? null
}

export function canRecord(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && pickFormat() !== null
}

export async function record(opts: RecorderOptions = {}): Promise<Recording> {
  const format = pickFormat()
  if (!format) throw new Error('This build cannot record audio.')

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Whisper was trained on ordinary recordings, and these are what makes a
      // laptop microphone in a room sound like one.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const recorder = new MediaRecorder(stream, { mimeType: format.mime })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  // The level meter, and the silence detector, from one analyser.
  const audio = new AudioContext()
  const source = audio.createMediaStreamSource(stream)
  const analyser = audio.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)

  const startedAt = performance.now()
  let spokeAt = startedAt
  let heardSpeech = false
  let frame = 0
  let stopped = false
  let reason: 'silence' | 'asked' | 'limit' = 'asked'

  const silenceMs = opts.silenceMs === undefined ? 1400 : opts.silenceMs
  const maxMs = opts.maxMs ?? 60_000

  const finish = (why: 'silence' | 'asked' | 'limit'): void => {
    if (stopped) return
    stopped = true
    reason = why
    cancelAnimationFrame(frame)
    if (recorder.state !== 'inactive') recorder.stop()
  }

  const watch = (): void => {
    if (stopped) return
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const s of samples) sum += s * s
    const level = Math.sqrt(sum / samples.length)
    opts.onLevel?.(Math.min(1, level * 8))

    const now = performance.now()
    if (level > SPEECH_LEVEL) {
      spokeAt = now
      heardSpeech = true
    }

    if (now - startedAt > maxMs) {
      finish('limit')
      return
    }
    // Only after something has actually been said, so leaning in to think for a
    // moment before starting does not end the recording before it began.
    if (silenceMs !== null && heardSpeech && now - spokeAt > silenceMs) {
      finish('silence')
      return
    }
    frame = requestAnimationFrame(watch)
  }

  const done = new Promise<{ blob: Blob; extension: string; ms: number } | null>((resolve) => {
    recorder.onstop = () => {
      const ms = performance.now() - startedAt
      for (const track of stream.getTracks()) track.stop()
      void audio.close()
      opts.onStop?.(reason)

      // Nothing audible: hand back nothing rather than a second of room tone for
      // Whisper to hallucinate over.
      if (!heardSpeech) {
        resolve(null)
        return
      }
      resolve({ blob: new Blob(chunks, { type: format.mime }), extension: format.extension, ms })
    }
  })

  recorder.start()
  frame = requestAnimationFrame(watch)

  return { stop: () => finish('asked'), done }
}
