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
  /**
   * How much of the last few frames must be speech before speech has
   * started: `frames` of the last `window`, 40ms each. The default, one of
   * one, is the first loud frame - right for dictation, where a missed
   * syllable costs more than a false start. A conversation, whose mic stays
   * open while chimes, typing and answers play into the earbuds beside it,
   * asks for more, so that a click or a cough is not someone talking.
   */
  onset?: { frames: number; window: number }
  /** Called once, the moment speech has started. */
  onSpeech?(): void
  /**
   * Count maxMs from the first speech rather than from the start, for a
   * recording that may wait a long while before anyone talks.
   */
  maxFromSpeech?: boolean
  /**
   * Whether the microphone is really working, from outside the audio: on
   * Linux, whether PipeWire has the earbuds' own mic running (see
   * micState in main). False while they are still switching to headset
   * mode, and if they drop out of it. Absent is always true.
   */
  gate?: () => boolean
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
  /** The microphone's name, as the system gives it. */
  device: string
  /** Start counting speech, for a recording opened with armed: false. */
  arm(): void
  /** Resolves with the audio once it has ended, or null if nothing was said. */
  done: Promise<{ blob: Blob; extension: string; ms: number } | null>
  /** Speech has started in it. */
  spoke(): boolean
  /** Milliseconds from its start to the first speech; -1 before there is any. */
  onsetMs(): number
  /** How long since the person was last heard, once they have been; 0 before. */
  quietMs(): number
  /** When they were last heard, on the page's clock: unchanged means nothing new was said. */
  spokeAt(): number
  /**
   * Everything recorded so far, as a file that decodes on its own, without
   * stopping: for hearing what has been said while the pause that ends it
   * is still being waited out. Null if it has ended.
   */
  snapshot(): Promise<{ blob: Blob; extension: string } | null>
  /**
   * Harder to start: while something plays into the earbuds next to the
   * mic, speech must be louder (STRICT_LOUDER times the bar) and last
   * longer (STRICT_ONSET) before it counts as someone talking over it.
   */
  strict(on: boolean): void
  /** The pause that ends it, changed while it runs. */
  setPause(ms: number): void
  /** For the log: the room, the bar, the loudest, and how long the mic dropped out. */
  stats(): { room: number; bar: number; peak: number; strictPeak: number; dropMs: number }
}

/** While something is playing: twice as loud as the bar... */
export const STRICT_LOUDER = 2
/** ...for seven frames of nine, about 300ms - longer than a key click or the tail of a chime. */
export const STRICT_ONSET = { frames: 7, window: 9 }

/**
 * Once speech has started, a frame a third as loud as the bar still counts
 * as talking if it comes within HOLD_WITHIN_MS of a loud one. The ends of words - a soft
 * "s", a trailing "th" - sit under the bar, and without this each one
 * started the clock on the pause that ends the recording. A room is a
 * tenth of the bar, so it is never held this way, and a steady noise
 * nearer the bar only for HOLD_WITHIN_MS (checked in check-voicebar).
 */
export const HOLD_BELOW = 0.35
export const HOLD_WITHIN_MS = 400

/**
 * A microphone that drops out - nothing at all from it, or PipeWire saying
 * the earbuds' mic stopped - is not the person pausing. Up to this much of
 * a recording's dropouts does not count towards the pause that ends it:
 * "when I'm just speaking halfway through and I hear a small chime... it's
 * a false alarm. And then it actually cuts me off."
 */
export const DROPOUT_CREDIT_MS = 4000

/** Below this RMS is digital silence: no microphone, however quiet, gives it. */
export const DEAD_LEVEL = 1e-6

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

/**
 * What a recording hears, frame by frame: whether the mic is live, when
 * speech starts, and when the person last spoke - the pause that ends a
 * recording is measured from that.
 *
 * Pure, and apart from the recorder, so scripts/check-voicebar.mjs can play
 * it the levels of a real mic: earbuds switching on, a dropout in the
 * middle of a sentence, a click, an answer leaking into the mic.
 */
export class Hearing {
  live = false
  /** Speech has started. */
  spoke = false
  /** When it started, from the start, in ms; -1 before. */
  onsetAt = -1
  /** When the person was last heard, on the frame clock. */
  spokeAt: number
  /** ...and last heard above the bar, which is what a soft end is held from. */
  private loudAt = -Infinity
  room = Infinity
  bar = SPEECH_LEVEL
  peak = 0
  strictPeak = 0
  dropMs = 0
  armed: boolean
  strict = false
  private readonly recent: boolean[] = []
  private lastFrameAt: number

  constructor(
    private readonly startedAt: number,
    private readonly onset: { frames: number; window: number } = { frames: 1, window: 1 },
    armed = true
  ) {
    this.spokeAt = startedAt
    this.lastFrameAt = startedAt
    this.armed = armed
  }

  arm(now: number): void {
    if (this.armed) return
    this.armed = true
    this.spokeAt = now
  }

  setStrict(on: boolean): void {
    if (this.strict === on) return
    this.strict = on
    this.recent.length = 0
  }

  /**
   * One look at the mic: its RMS, the time, and whether it is working by
   * any account from outside the sound (see RecorderOptions.gate). Says
   * what changed: it went live, speech started, or it is still talking.
   */
  frame(level: number, now: number, working = true): { live: boolean; onset: boolean; talking: boolean } {
    const frameMs = Math.min(200, now - this.lastFrameAt)
    this.lastFrameAt = now
    const result = { live: false, onset: false, talking: false }
    /* Any sound at all, even a quiet room, is a live microphone; exact
       zeros are one that is not delivering yet. On Linux the earbuds' mic
       must also be running by PipeWire's account: while they switch, a
       Bluetooth mic delivers a faint hiss that is not exact zeros, and it
       was taken for a live one - "talk now", into a mic that came on five
       seconds later. */
    if (!this.live && working && level > 1e-5) {
      this.live = true
      result.live = true
    }
    const dropped = this.live && (!working || level < DEAD_LEVEL)

    /* The room: the quietest it gets, rising again over a couple of seconds
       so a noisier room is caught up with. Only from quiet frames of a
       working mic - not the near-silence of a Bluetooth mic still
       switching on, which is no room at all, and not speech, which made it
       creep up towards the voice over a long sentence until quieter words
       fell under the bar. */
    /* Not from the soft end of a word either (see HOLD_BELOW), or each one
       nudged the bar up until the next one fell under it. */
    const soft =
      this.spoke && now - this.loudAt < HOLD_WITHIN_MS && level > this.bar * HOLD_BELOW && level <= this.bar
    if (this.live && !dropped && !soft && level > 1e-4 && level < this.bar)
      this.room = level < this.room ? level : this.room + (level - this.room) * 0.02
    const speech = speechThreshold(this.room)
    this.bar = speech
    if (!this.armed) return result

    if (level > this.peak) this.peak = level
    if (this.strict && level > this.strictPeak) this.strictPeak = level
    if (!this.spoke) {
      const rule = this.strict ? STRICT_ONSET : this.onset
      this.recent.push(level > speech * (this.strict ? STRICT_LOUDER : 1))
      while (this.recent.length > rule.window) this.recent.shift()
      if (this.recent.filter(Boolean).length >= rule.frames) {
        this.spoke = true
        this.spokeAt = now
        this.loudAt = now
        this.onsetAt = now - this.startedAt
        result.onset = true
        result.talking = true
      }
    } else if (level > speech) {
      this.spokeAt = now
      this.loudAt = now
      result.talking = true
    } else if (now - this.loudAt < HOLD_WITHIN_MS && level > speech * HOLD_BELOW) {
      /* Held from the last loud frame, not from the last held one: a
         steady noise just under the bar is held for HOLD_WITHIN_MS and no
         longer, so it cannot keep a recording open. */
      this.spokeAt = now
      result.talking = true
    } else if (dropped && this.dropMs < DROPOUT_CREDIT_MS) {
      /* The mic went quiet under the person, not the person: the pause
         clock waits for it to come back. */
      this.spokeAt += frameMs
      this.dropMs += frameMs
    }
    return result
  }
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

  /* Waiting on the recorder to hand over what it has, for snapshot(). */
  const flushed: Array<() => void> = []
  const collect = (r: MediaRecorder): void => {
    r.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data)
        all.push(e.data)
      }
      for (const waiter of flushed.splice(0)) waiter()
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
  const hearing = new Hearing(startedAt, opts.onset, opts.armed !== false)
  let heardInSegment = false
  let frame: Frame | null = null
  let stopped = false
  let rotating = false
  let reason: 'silence' | 'asked' | 'limit' = 'asked'
  let markLive: (ms: number) => void = () => {}
  const live = new Promise<number>((resolve) => {
    markLive = resolve
  })

  let silenceMs = opts.silenceMs === undefined ? 1400 : opts.silenceMs
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
    const now = performance.now()
    const heard = hearing.frame(level, now, opts.gate ? opts.gate() : true)
    if (heard.live) markLive(Math.round(now - startedAt))
    if (heard.talking) heardInSegment = true
    if (heard.onset) opts.onSpeech?.()
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
    opts.onLevel?.(Math.min(1, Math.sqrt(level * 8)), level, hearing.bar)

    // Close the current piece when it is worth transcribing on its own, so
    // the work is spread across the dictation instead of landing all at once
    // when the user stops talking.
    if (
      opts.onSegment &&
      shouldRotate({
        heardSpeechInSegment: heardInSegment,
        segmentMs: now - segmentStart,
        sinceSpeechMs: now - hearing.spokeAt,
        pauseMs: segmentPauseMs,
        minMs: minSegmentMs,
        maxMs: maxSegmentMs
      })
    ) {
      rotate()
    }

    const from = opts.maxFromSpeech ? (hearing.spoke ? startedAt + hearing.onsetAt : now) : startedAt
    if (now - from > maxMs) {
      finish('limit')
      return
    }
    // Only after something has actually been said, so leaning in to think for a
    // moment before starting does not end the recording before it began.
    if (silenceMs !== null && hearing.spoke && now - hearing.spokeAt > silenceMs) {
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
        if (!hearing.spoke) {
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
    device: stream.getAudioTracks()[0]?.label || 'the system default',
    arm: () => hearing.arm(performance.now()),
    spoke: () => hearing.spoke,
    onsetMs: () => hearing.onsetAt,
    quietMs: () => (hearing.spoke ? performance.now() - hearing.spokeAt : 0),
    spokeAt: () => hearing.spokeAt,
    snapshot: () =>
      new Promise<{ blob: Blob; extension: string } | null>((resolve) => {
        if (stopped || recorder.state !== 'recording') return resolve(null)
        const timer = setTimeout(() => resolve(null), 600)
        flushed.push(() => {
          clearTimeout(timer)
          resolve({ blob: new Blob(all, { type: format.mime }), extension: format.extension })
        })
        recorder.requestData()
      }),
    strict: (on: boolean) => hearing.setStrict(on),
    setPause: (ms: number) => {
      silenceMs = ms
    },
    stats: () => ({
      room: Number.isFinite(hearing.room) ? hearing.room : 0,
      bar: hearing.bar,
      peak: hearing.peak,
      strictPeak: hearing.strictPeak,
      dropMs: Math.round(hearing.dropMs)
    })
  }
}
