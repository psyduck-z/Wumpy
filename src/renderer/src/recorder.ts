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

/** One finished piece of a recording, ready to be transcribed on its own. */
export interface Segment {
  blob: Blob
  extension: string
  ms: number
  /** The last one. Nothing more is coming. */
  final: boolean
  /** Position in the recording, so transcripts reassemble in order. */
  index: number
  /**
   * Nothing was said in this piece.
   *
   * Only ever true on the final one, where a pause had already closed the
   * last real piece and what remains is room tone. It is still emitted,
   * because `final` is how a listener learns the recording is over, and
   * flagged, because silence is exactly what Whisper invents "Thank you."
   * over.
   */
  silent: boolean
}

/** What the caller needs to know while recording, for the meter and the label. */
export interface RecorderEvents {
  /** 0..1, roughly how loud it is right now. */
  onLevel?(level: number): void
  onStop?(reason: 'silence' | 'asked' | 'limit'): void
  /**
   * A piece of speech has finished and can be transcribed now.
   *
   * Without this the whole clip went to Whisper at once when the user let go,
   * so a thirty-second sentence meant a wait proportional to how much had been
   * said - all of it after the talking stopped, which is the worst moment for
   * it. Cutting at the pauses means most of a long dictation is already
   * transcribed by the time the last word lands.
   */
  onSegment?(segment: Segment): void
}

/**
 * Whether to close the current piece and start another.
 *
 * Pure, so the timings can be checked without a microphone. Three rules, and
 * the order matters:
 *
 *   Nothing has been said in this piece - never cut. Rotating through silence
 *   would hand Whisper a second of room tone, which is what it hallucinates
 *   "Thank you." over.
 *
 *   It is too short - never cut. Whisper is far worse on a fragment than on a
 *   phrase, and a cut after one word costs accuracy for no gain.
 *
 *   Otherwise cut at a pause, or when the piece has simply gone on long
 *   enough. The pause is the good cut: nothing is lost across it because
 *   nothing was being said. The ceiling is the fallback for someone who does
 *   not pause, where a cut mid-word is still better than one enormous clip.
 */
export function shouldRotate(now: {
  heardSpeechInSegment: boolean
  segmentMs: number
  sinceSpeechMs: number
  pauseMs: number
  minMs: number
  maxMs: number
}): boolean {
  if (!now.heardSpeechInSegment) return false
  if (now.segmentMs < now.minMs) return false
  if (now.segmentMs >= now.maxMs) return true
  return now.sinceSpeechMs >= now.pauseMs
}

export interface RecorderOptions extends RecorderEvents {
  /** End after this long without speech. Null never ends by itself. */
  silenceMs?: number | null
  /** A hard ceiling, so a stuck recording cannot fill the disk. */
  maxMs?: number
  /**
   * Pause that closes a piece, in ms. Shorter than silenceMs on purpose:
   * a breath between sentences should start a new piece, not end the
   * recording.
   */
  segmentPauseMs?: number
  /** Below this a piece is a fragment, and Whisper does badly on fragments. */
  minSegmentMs?: number
  /** Cut here regardless, for someone who does not pause. */
  maxSegmentMs?: number
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

  /**
   * One MediaRecorder per piece, rather than slicing one long one.
   *
   * A webm stream is a container: the first chunk carries the header and the
   * rest do not, so `chunks.slice(n)` is not a file anything can decode.
   * Stopping and starting gives a complete, independently decodable blob each
   * time. It costs a few milliseconds of gap at the cut - which is why the
   * cut is made at a pause, where there is nothing to lose.
   */
  let recorder = new MediaRecorder(stream, { mimeType: format.mime })
  let chunks: Blob[] = []
  const all: Blob[] = []
  let segmentIndex = 0
  let segmentStart = performance.now()

  const collect = (r: MediaRecorder): void => {
    r.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data)
        all.push(e.data)
      }
    }
  }
  collect(recorder)

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
  let heardInSegment = false
  let frame = 0
  let stopped = false
  let rotating = false
  let reason: 'silence' | 'asked' | 'limit' = 'asked'

  const silenceMs = opts.silenceMs === undefined ? 1400 : opts.silenceMs
  const maxMs = opts.maxMs ?? 60_000
  const segmentPauseMs = opts.segmentPauseMs ?? 650
  const minSegmentMs = opts.minSegmentMs ?? 1200
  const maxSegmentMs = opts.maxSegmentMs ?? 14_000

  /**
   * Closes the current piece and opens the next one on the same stream.
   *
   * The microphone is never released, so nothing is lost but the handful of
   * milliseconds between one recorder stopping and the next starting.
   */
  const rotate = (): void => {
    if (rotating || stopped || !opts.onSegment) return
    rotating = true
    const finished = recorder
    const mine = chunks
    const ms = performance.now() - segmentStart
    const index = segmentIndex++

    finished.onstop = () => {
      opts.onSegment?.({
        blob: new Blob(mine, { type: format.mime }),
        extension: format.extension,
        ms,
        final: false,
        index,
        silent: false
      })
    }
    finished.stop()

    chunks = []
    segmentStart = performance.now()
    heardInSegment = false
    recorder = new MediaRecorder(stream, { mimeType: format.mime })
    collect(recorder)
    attachFinal(recorder)
    recorder.start()
    rotating = false
  }

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
      heardInSegment = true
    }

    // Close the current piece when it is worth transcribing on its own, so
    // the work is spread across the dictation instead of landing all at once
    // when the user stops talking.
    if (
      opts.onSegment &&
      shouldRotate({
        heardSpeechInSegment: heardInSegment,
        segmentMs: now - segmentStart,
        sinceSpeechMs: now - spokeAt,
        pauseMs: segmentPauseMs,
        minMs: minSegmentMs,
        maxMs: maxSegmentMs
      })
    ) {
      rotate()
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

  let attachFinal: (r: MediaRecorder) => void = () => {}

  const done = new Promise<{ blob: Blob; extension: string; ms: number } | null>((resolve) => {
    attachFinal = (r: MediaRecorder): void => {
      r.onstop = () => {
        const ms = performance.now() - startedAt
        const tail = chunks
        const tailMs = performance.now() - segmentStart
        for (const track of stream.getTracks()) track.stop()
        void audio.close()
        opts.onStop?.(reason)

        // Nothing audible in the whole recording: hand back nothing rather
        // than a second of room tone for Whisper to hallucinate over.
        if (!heardSpeech) {
          resolve(null)
          return
        }

        // The last piece, which no pause closed. Emitted even when nothing
        // was said in it, with final set, so a listener always learns that
        // the recording has ended.
        opts.onSegment?.({
          blob: new Blob(tail, { type: format.mime }),
          extension: format.extension,
          ms: tailMs,
          final: true,
          index: segmentIndex++,
          silent: !heardInSegment
        })

        // The whole thing as well, for callers that would rather have one
        // clip - and as the fallback when transcribing a piece fails.
        resolve({ blob: new Blob(all, { type: format.mime }), extension: format.extension, ms })
      }
    }
    attachFinal(recorder)
  })

  recorder.start()
  frame = requestAnimationFrame(watch)

  return { stop: () => finish('asked'), done }
}
