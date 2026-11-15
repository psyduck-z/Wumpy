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
  /**
   * How loud it is right now, twice: once to draw and once to judge.
   *
   * `level` is curved for a meter and is the wrong number to reason with -
   * `rms` is the raw figure SPEECH_LEVEL is compared against, so a caller
   * that wants to say whether anything is being heard, or write it into the
   * log, is reading the same quantity the gate reads rather than a
   * sqrt-of-eight-times version of it. `speech` is the level counted as
   * speech right now (see speechThreshold), for the same reason.
   */
  onLevel?(level: number, rms: number, speech: number): void
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
  /**
   * Record this instead of opening the microphone.
   *
   * For `/listen`, which captures what the speakers are playing - alone or
   * mixed with the microphone - and assembles that stream itself. See
   * ./loopback. Everything after the stream is identical: the same level
   * meter, the same pause detector, the same segments, so a meeting is
   * transcribed by the machinery dictation was already using rather than by
   * a second copy of it.
   *
   * The caller that supplies a stream also stops it. This function stops
   * only the tracks it opened, because a stream it was handed may be a
   * mixing graph with more to tear down than tracks.
   */
  stream?: MediaStream
  /** The microphone to open, by deviceId; absent is the system default. */
  deviceId?: string
  /**
   * False to ignore speech until arm() is called: a voice turn opens the
   * mic, waits for it to be live, then chimes - and the chime, in an earbud
   * beside the microphone, must not count as the person starting to talk.
   */
  armed?: boolean
}

export interface Recording {
  /** Ends it early. Safe to call twice. */
  stop(): void
  /**
   * Resolves, with the milliseconds it took, once the microphone delivers
   * actual sound. A Bluetooth mic delivers exact zeros while the earbuds
   * switch to headset mode - seconds, sometimes - and anything said then
   * is lost. Never resolves if the mic stays dead.
   */
  live: Promise<number>
  /** Start counting speech, for a recording opened with armed: false. */
  arm(): void
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
export const SPEECH_LEVEL = 0.02

/**
 * ...and the quietest that can be counted as speech on any microphone.
 *
 * SPEECH_LEVEL was set on microphones where a quiet room is 0.01. This
 * MacBook's own, the one a voice turn now uses so the earbuds need not
 * switch to headset mode, is forty times quieter: its room measured
 * 0.00005, and talking to it peaked at 0.009 - clearly speech, 45 dB above
 * the room, and under the bar every time. Two turns in a row heard
 * "nothing worth sending" while the person was talking.
 *
 * So the bar is set from the room, as heard in the moment before the
 * chime: speech is SPEECH_ABOVE_ROOM times louder than it (about 20 dB),
 * never below MIN_SPEECH_LEVEL and never above SPEECH_LEVEL - so a
 * microphone that was fine before is judged exactly as before.
 */
export const MIN_SPEECH_LEVEL = 0.002
export const SPEECH_ABOVE_ROOM = 10

export function speechThreshold(room: number): number {
  if (!Number.isFinite(room) || room <= 0) return SPEECH_LEVEL
  return Math.min(SPEECH_LEVEL, Math.max(MIN_SPEECH_LEVEL, room * SPEECH_ABOVE_ROOM))
}

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

/**
 * The level meter's clock: a timer, always, never animation frames.
 *
 * It was animation frames whenever the page said it was visible, and a
 * timer otherwise. On Wayland that test is not enough: Wumpy's window on
 * another Hyprland workspace is still "visible" to the page, but the
 * compositor sends it no frame callbacks, so no frames come. The meter
 * stopped, and with it the speech detection - an earbud gesture opened the
 * mic, nothing you said was ever noticed, and after eight seconds the turn
 * quietly gave up. Twenty-five looks a second is plenty for a level bar and
 * for hearing a pause, and a timer runs wherever the window is
 * (backgroundThrottling is off for the panel).
 */
type Frame = { raf: boolean; id: number }
function nextFrame(cb: () => void): Frame {
  return { raf: false, id: window.setTimeout(cb, 40) }
}
function stopFrame(frame: Frame | null | undefined): void {
  if (!frame) return
  if (frame.raf) cancelAnimationFrame(frame.id)
  else clearTimeout(frame.id)
}

export function canRecord(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && pickFormat() !== null
}

export async function record(opts: RecorderOptions = {}): Promise<Recording> {
  const format = pickFormat()
  if (!format) throw new Error('This build cannot record audio.')

  /* Handed one, or open the microphone. Only the one opened here is closed
     here; see RecorderOptions.stream. */
  const ours = !opts.stream
  const stream =
    opts.stream ??
    (await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        channelCount: 1,
        // Whisper was trained on ordinary recordings, and these are what makes a
        // laptop microphone in a room sound like one.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }))

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
  let room = Infinity
  let heardInSegment = false
  let frame: Frame | null = null
  let stopped = false
  let rotating = false
  let reason: 'silence' | 'asked' | 'limit' = 'asked'
  let armed = opts.armed !== false
  let markLive: (ms: number) => void = () => {}
  let isLive = false
  const live = new Promise<number>((resolve) => {
    markLive = resolve
  })

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
    stopFrame(frame)
    if (recorder.state !== 'inactive') recorder.stop()
  }

  const watch = (): void => {
    if (stopped) return
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const s of samples) sum += s * s
    const level = Math.sqrt(sum / samples.length)
    /*
     * Curved, not just scaled, so the meter has something to show.
     *
     * RMS for ordinary speech sits around 0.02 to 0.10, which at a flat
     * x8 is 0.16 to 0.80 - and the bar maps that onto a quarter-to-full
     * scale, so the whole of normal talking moved it between 0.37 and
     * 0.85. Half an inch of travel for the entire dynamic range of a
     * voice, which reads as a bar that barely moves.
     *
     * Hearing is roughly logarithmic, so a square root is closer to what
     * a person expects a level meter to do: quiet speech lifts off the
     * floor properly and the top stays reachable without shouting. Same
     * RMS range now spans about 0.4 to 0.9 before the bar's own mapping,
     * and the difference between a mumble and a clear sentence is
     * visible rather than theoretical.
     */
    /* The room: the quietest it gets, rising only slowly, so a pause in a
       sentence is not mistaken for it and a noisier room is caught up with. */
    if (level > 1e-5) room = level < room ? level : room + (level - room) * 0.002
    const speech = speechThreshold(room)
    opts.onLevel?.(Math.min(1, Math.sqrt(level * 8)), level, speech)

    const now = performance.now()
    /* Any sound at all, even a quiet room, is a live microphone; exact
       zeros are one that is not delivering yet. */
    if (!isLive && level > 1e-5) {
      isLive = true
      markLive(Math.round(now - startedAt))
    }
    if (armed && level > speech) {
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
    frame = nextFrame(watch)
  }

  let attachFinal: (r: MediaRecorder) => void = () => {}

  const done = new Promise<{ blob: Blob; extension: string; ms: number } | null>((resolve) => {
    attachFinal = (r: MediaRecorder): void => {
      r.onstop = () => {
        const ms = performance.now() - startedAt
        const tail = chunks
        const tailMs = performance.now() - segmentStart
        if (ours) for (const track of stream.getTracks()) track.stop()
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
  frame = nextFrame(watch)

  return {
    stop: () => finish('asked'),
    done,
    live,
    arm: () => {
      if (armed) return
      armed = true
      spokeAt = performance.now()
    }
  }
}
