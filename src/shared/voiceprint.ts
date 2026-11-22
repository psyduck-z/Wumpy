/**
 * Knowing the person's voice from anyone else's.
 *
 * Asked for in these words: "integrate voice detection so only your voice is
 * detected and trained against your voice". The conversation's mic is open
 * for minutes at a time, in earbuds, in a room: someone else talking, a
 * video, a call on the other side of the desk all reached Wumpy as if the
 * person had said them - and talking over an answer stopped it whoever did
 * the talking.
 *
 * So each thing heard in a conversation is also turned into a voiceprint (a
 * speaker embedding: 512 numbers that are close together for one voice and
 * far apart for two), on this machine, by a small model (CAM++, trained on
 * VoxCeleb; see main/voiceprint.ts), and compared with the person's.
 *
 * The person's own is best calibrated: "you can also... calibrate your
 * voice". They read ENROL_CLIPS sentences (components/VoiceCalibration),
 * which are kept for good. Without that it is learned: the first
 * LEARN_CLIPS things they say in conversations, each long enough to judge,
 * are kept - it is their earbuds, so the voice in them is usually theirs,
 * but whoever talks first is learned first. Either way a clip that sounds
 * clearly like them keeps being learned from (oldest out), so a new
 * microphone, a cold or a quiet evening voice are taken in as they come
 * rather than turned away; once calibrated, always anchored to the
 * sentences read (ANCHOR).
 *
 * It is a filter, not a lock: a recording of the person, or a clone of
 * their voice, gets through. It keeps the television from being answered;
 * it does not keep anyone determined out.
 *
 * Pure: the features and the decisions, so they can be checked without a
 * microphone or a model.
 */

export const RATE = 16000

/** Clips that make the voice known, before anything is turned away. */
export const LEARN_CLIPS = 6

/** The most kept: enough to cover a few microphones, few enough to follow a voice that changes. */
export const KEEP_CLIPS = 24

/**
 * Talking shorter than this is not judged: a voiceprint from under a second
 * is close to a guess, and the short things - "stop", "yes", "the second
 * one" - are exactly the ones that must not go missing.
 */
export const JUDGE_FROM_MS = 1000

/** Talking shorter than this is not learned from. */
export const LEARN_FROM_MS = 1500

/**
 * Below this it is someone else. Measured on 26 LibriSpeech speakers, each
 * learned from six clips and tested on 8 more of their own and 200 of the
 * others' (scripts/check-voiceprint.mjs runs the same test), as recorded
 * and cut to telephone bandwidth, which is what a Bluetooth headset mic
 * on its older codec sends:
 *
 *   talking   cut-off   own turned away     strangers let in
 *                       full     phone      full     phone
 *   1s        0.40      4.9%     7.8%       0.5%     2.0%
 *   1.5s      0.45      1.0%     2.9%       0.3%     1.2%
 *   4s        0.50      ~1%      ~1.5%      <0.5%    ~1.5%
 *
 * Longer talking makes a steadier voiceprint, and strangers' come out more
 * alike too, so the bar rises with it; lower for the short ones, because
 * turning the person away costs more than letting a stranger through.
 * Their own clips of 4s sit at 0.67 or more nineteen times in twenty.
 */
export const SAME_ABOVE_SHORT = 0.4
export const SAME_ABOVE = 0.45
export const SAME_ABOVE_LONG = 0.5
/** Talking shorter than this is judged by SAME_ABOVE_SHORT. */
export const SHORT_MS = 1500
/** And this long or longer by SAME_ABOVE_LONG. */
export const LONG_MS = 3000

/** The cut-off for a clip of this much talking. */
export const cutOff = (talkedMs: number): number =>
  talkedMs < SHORT_MS ? SAME_ABOVE_SHORT : talkedMs < LONG_MS ? SAME_ABOVE : SAME_ABOVE_LONG

/** Above this it is them beyond doubt, and is learned from: 94-99% of their own clips of 1.5s or more. */
export const LEARN_ABOVE = 0.55

/**
 * A yes or no to something that is about to run. Every other short thing
 * goes unjudged (JUDGE_FROM_MS), but "yes" is under a second, and an
 * unjudged "yes" from the television, or from whoever is in the room, would
 * run a command. So an answer is judged however short, against a lower bar
 * that suits half a second of talking; turned away, it is only asked again,
 * which costs one more "yes". Measured on 0.6s cut from 26 LibriSpeech
 * speakers, each calibrated from five sentences (full / phone bandwidth):
 *
 *   cut-off   own turned away    strangers let in
 *   0.25      4.0%   6.5%        5.3%   5.8%
 *   0.30      7.0%   9.0%        2.3%   2.7%
 *   0.35      11.6%  17.1%       0.9%   0.9%
 *
 * 0.35 would ask the person to say it again one time in six.
 */
export const SAME_ABOVE_ANSWER = 0.3

/*
 * Calibrating: the person reads a few sentences on purpose, so their voice is
 * known from the start rather than from whoever happened to talk first. The
 * clips read are kept for good (`enrolled`): the voice keeps being learned
 * from conversations, but it is always pulled back towards how it sounded
 * when they calibrated, so it cannot drift, a clip at a time, into someone
 * else's.
 */

/** Sentences read to calibrate. */
export const ENROL_CLIPS = 5
/** Each one at least this much talking: a sentence, not a word. */
export const ENROL_FROM_MS = 2000
/**
 * A clip read while calibrating must be at least this like the others, or it
 * was not the same voice - someone else answering, the television, a mic
 * that cut out - and is asked for again. Measured as above: the person's own
 * sentence turned away 3.9% of the time (one more to read), a stranger's
 * taken 0.3%.
 */
export const ENROL_AGREE = 0.5
/**
 * Calibrated with sentences less alike than this (see steadiness), the
 * person is told the room or the mic was likely the trouble. 1 in 19
 * LibriSpeech speakers came out under it, reading clean audiobooks.
 */
export const STEADY_BELOW = 0.55
/** Learned clips kept beside the calibrated ones. */
export const KEEP_LEARNED = 16
/** How much the calibrated clips count for in the voice, against everything learned since. */
export const ANCHOR = 0.5

/**
 * The most talking a voiceprint is made from. A minute-long monologue does
 * not make a better voiceprint than eight seconds of it, and the model's time
 * grows with the clip: 30s took 4.4s, longer than the answer waits for it
 * (VOICEPRINT_WAIT_MS), and a clip judged too late counts as theirs. Cut to
 * 8s, nobody's own clip was turned away either way, and strangers were let
 * in about as often (0.9% at 0.5 against 0.5% for whole clips, on fewer).
 */
export const MAX_EMBED_MS = 8000

export interface Clip {
  v: number[]
  at: number
  ms: number
  device: string
  /** Read on purpose while calibrating: kept for good. */
  enrolled?: boolean
}

export interface Voiceprint {
  /** The model the clips came from: another model's numbers mean nothing to this one. */
  model: string
  clips: Clip[]
  /** The person turned it off: everyone is heard again, and nothing more is learned. */
  off?: boolean
}

export const emptyVoiceprint = (model: string): Voiceprint => ({ model, clips: [] })

export type Verdict =
  /** Theirs, or too short to say. */
  | { kind: 'theirs'; score: number | null; why: 'learning' | 'short' | 'match' | 'off' }
  | { kind: 'someone else'; score: number }

// ---------------------------------------------------------------------------
// Features: 80 log mel filterbanks, as Kaldi makes them, which is what the
// model was trained on: 25ms frames every 10ms, dither off, DC removed,
// pre-emphasis 0.97, a Povey window, a 512-point power spectrum, bins from
// 20Hz to 8kHz. Then each bin's mean over the clip is taken off.
// ---------------------------------------------------------------------------

const FRAME = 400
const SHIFT = 160
const FFT = 512
export const BINS = 80

const melOf = (hz: number): number => 1127 * Math.log(1 + hz / 700)

let banks: { start: number; weights: Float32Array }[] | null = null
let window: Float32Array | null = null
let twiddle: { cos: Float32Array; sin: Float32Array; rev: Uint16Array } | null = null

function setUp(): void {
  if (banks) return
  window = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85)
  const low = melOf(20)
  const high = melOf(RATE / 2)
  const delta = (high - low) / (BINS + 1)
  const width = RATE / FFT
  banks = []
  for (let b = 0; b < BINS; b++) {
    const left = low + b * delta
    const centre = left + delta
    const right = centre + delta
    let start = -1
    const w: number[] = []
    for (let i = 0; i < FFT / 2; i++) {
      const mel = melOf(width * i)
      if (mel > left && mel < right) {
        if (start < 0) start = i
        w.push(mel <= centre ? (mel - left) / (centre - left) : (right - mel) / (right - centre))
      } else if (start >= 0) break
    }
    banks.push({ start: Math.max(0, start), weights: Float32Array.from(w) })
  }
  const cos = new Float32Array(FFT / 2)
  const sin = new Float32Array(FFT / 2)
  for (let i = 0; i < FFT / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / FFT)
    sin[i] = -Math.sin((2 * Math.PI * i) / FFT)
  }
  const rev = new Uint16Array(FFT)
  const bits = Math.log2(FFT)
  for (let i = 0; i < FFT; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  twiddle = { cos, sin, rev }
}

/** In place, radix 2. */
function fft(re: Float32Array, im: Float32Array): void {
  const { cos, sin, rev } = twiddle!
  for (let i = 0; i < FFT; i++) {
    const j = rev[i]
    if (j > i) {
      const t = re[i]
      re[i] = re[j]
      re[j] = t
      const u = im[i]
      im[i] = im[j]
      im[j] = u
    }
  }
  for (let size = 2; size <= FFT; size <<= 1) {
    const half = size >> 1
    const step = FFT / size
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step]
        const s = sin[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * c - im[b] * s
        const ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

/**
 * The clip's features, frames by BINS, flat; mean taken off. Samples are
 * 16 kHz mono in [-1, 1]. Empty if the clip is shorter than one frame.
 */
export function features(samples: Float32Array): { data: Float32Array; frames: number } {
  setUp()
  const frames = samples.length < FRAME ? 0 : 1 + Math.floor((samples.length - FRAME) / SHIFT)
  const data = new Float32Array(frames * BINS)
  const re = new Float32Array(FFT)
  const im = new Float32Array(FFT)
  const power = new Float32Array(FFT / 2)
  for (let f = 0; f < frames; f++) {
    re.fill(0)
    im.fill(0)
    let mean = 0
    for (let i = 0; i < FRAME; i++) mean += samples[f * SHIFT + i]
    mean /= FRAME
    for (let i = 0; i < FRAME; i++) re[i] = samples[f * SHIFT + i] - mean
    for (let i = FRAME - 1; i > 0; i--) re[i] -= 0.97 * re[i - 1]
    re[0] -= 0.97 * re[0]
    for (let i = 0; i < FRAME; i++) re[i] *= window![i]
    fft(re, im)
    for (let i = 0; i < FFT / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i]
    for (let b = 0; b < BINS; b++) {
      const { start, weights } = banks![b]
      let e = 0
      for (let k = 0; k < weights.length; k++) e += weights[k] * power[start + k]
      data[f * BINS + b] = Math.log(Math.max(e, 1.1920929e-7))
    }
  }
  if (frames) {
    for (let b = 0; b < BINS; b++) {
      let m = 0
      for (let f = 0; f < frames; f++) m += data[f * BINS + b]
      m /= frames
      for (let f = 0; f < frames; f++) data[f * BINS + b] -= m
    }
  }
  return { data, frames }
}

/**
 * Only the talking in a clip. A conversation's clip carries half a second
 * from before the first word and the pause that ended it - a second and a
 * half of room - and a voiceprint averages over everything it is given, so
 * the room would be part of the voice. Kept: every 10ms stretch within 30 dB
 * of the loudest, with 100ms either side so word edges stay whole.
 */
export function voiced(samples: Float32Array): Float32Array {
  const step = RATE / 100
  const n = Math.floor(samples.length / step)
  if (n < 3) return samples
  const level = new Float32Array(n)
  let top = 0
  for (let i = 0; i < n; i++) {
    let e = 0
    for (let k = 0; k < step; k++) e += samples[i * step + k] ** 2
    level[i] = Math.sqrt(e / step)
    top = Math.max(top, level[i])
  }
  if (top <= 1e-5) return samples
  const keep = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    if (level[i] >= top * 0.0316) for (let j = Math.max(0, i - 10); j <= Math.min(n - 1, i + 10); j++) keep[j] = 1
  let count = 0
  for (let i = 0; i < n; i++) count += keep[i]
  const out = new Float32Array(count * step)
  let at = 0
  for (let i = 0; i < n; i++)
    if (keep[i]) {
      out.set(samples.subarray(i * step, (i + 1) * step), at)
      at += step
    }
  return out
}

/** The talking a voiceprint is made from: the voiced part, at most MAX_EMBED_MS of it from the middle. */
export function forPrint(samples: Float32Array): Float32Array {
  const talk = voiced(samples)
  const most = Math.round((MAX_EMBED_MS / 1000) * RATE)
  if (talk.length <= most) return talk
  const from = Math.floor((talk.length - most) / 2)
  return talk.subarray(from, from + most)
}

// ---------------------------------------------------------------------------
// Comparing.
// ---------------------------------------------------------------------------

export function unit(v: ArrayLike<number>): number[] {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return d / (Math.sqrt(na * nb) || 1)
}

/** The average of some clips' voiceprints, as one of unit length. */
function mean(clips: { v: ArrayLike<number> }[]): number[] {
  const sum = new Array<number>(clips[0].v.length).fill(0)
  for (const c of clips) {
    const u = unit(c.v)
    for (let i = 0; i < sum.length; i++) sum[i] += u[i]
  }
  return unit(sum)
}

/**
 * The voice: the average of the clips learned. Once calibrated, the clips
 * read then count for ANCHOR of it however many more are learned, so the
 * voice can follow a new mic or a cold but not wander off.
 */
export function centre(print: Voiceprint): number[] | null {
  if (!print.clips.length) return null
  const read = print.clips.filter((c) => c.enrolled)
  const heard = print.clips.filter((c) => !c.enrolled)
  if (!read.length || !heard.length) return mean(print.clips)
  const a = mean(read)
  const b = mean(heard)
  return unit(a.map((x, i) => x * ANCHOR + b[i] * (1 - ANCHOR)))
}

/** Calibrated: the person read sentences for it on purpose. */
export const calibrated = (print: Voiceprint): boolean => print.clips.some((c) => c.enrolled)

export const known = (print: Voiceprint): boolean => calibrated(print) || print.clips.length >= LEARN_CLIPS

/** How like the person a clip is. Null before there is anything to compare with. */
export function likeness(print: Voiceprint, v: ArrayLike<number>): number | null {
  const c = centre(print)
  return c ? cosine(c, v) : null
}

/**
 * Whose voice this was, for a clip of `talkedMs` talking. `answer` is a yes
 * or no to something about to run: judged however short (SAME_ABOVE_ANSWER).
 */
export function judge(print: Voiceprint, v: ArrayLike<number> | null, talkedMs: number, answer = false): Verdict {
  if (print.off) return { kind: 'theirs', score: null, why: 'off' }
  const score = v ? likeness(print, v) : null
  if (!known(print) || score === null) return { kind: 'theirs', score, why: 'learning' }
  if (answer && talkedMs < JUDGE_FROM_MS)
    return score < SAME_ABOVE_ANSWER ? { kind: 'someone else', score } : { kind: 'theirs', score, why: 'match' }
  if (talkedMs < JUDGE_FROM_MS) return { kind: 'theirs', score, why: 'short' }
  if (score < cutOff(talkedMs)) return { kind: 'someone else', score }
  return { kind: 'theirs', score, why: 'match' }
}

const kept = (v: ArrayLike<number>): number[] => Array.from(v, (x) => Math.round(x * 1e5) / 1e5)

/**
 * The voiceprint with this clip learned, or the same one if it should not
 * be: too short, turned off, or not clearly them. While still learning, a
 * clip unlike the ones so far (from the third on) is left out too, so a
 * visitor in the first few minutes is not made part of the person's voice.
 * The clips read while calibrating are never pushed out.
 */
export function learn(print: Voiceprint, v: ArrayLike<number>, talkedMs: number, device: string, at = Date.now()): Voiceprint {
  if (print.off || talkedMs < LEARN_FROM_MS) return print
  const score = likeness(print, v)
  const enough = known(print) ? LEARN_ABOVE : print.clips.length >= 2 ? SAME_ABOVE : -1
  if (score !== null && score < enough) return print
  const clip: Clip = { v: kept(v), at, ms: Math.round(talkedMs), device }
  if (!calibrated(print)) return { ...print, clips: [...print.clips, clip].slice(-KEEP_CLIPS) }
  const read = print.clips.filter((c) => c.enrolled)
  const heard = [...print.clips.filter((c) => !c.enrolled), clip].slice(-KEEP_LEARNED)
  return { ...print, clips: [...read, ...heard] }
}

// ---------------------------------------------------------------------------
// Calibrating.
// ---------------------------------------------------------------------------

/** Why a clip read while calibrating was not taken. */
export type EnrolRefusal = 'short' | 'unlike'

/**
 * Whether a clip read while calibrating can be taken, given the ones taken
 * so far. From the second on, it must be like them; the first is checked
 * when the second comes - if those two disagree, nobody can say which was
 * the person, so both go and it starts again.
 */
export function enrolCheck(
  taken: { v: ArrayLike<number> }[],
  v: ArrayLike<number>,
  talkedMs: number
): { ok: true; score: number | null } | { ok: false; why: EnrolRefusal; score: number | null; restart?: boolean } {
  if (talkedMs < ENROL_FROM_MS) return { ok: false, why: 'short', score: null }
  if (!taken.length) return { ok: true, score: null }
  const score = cosine(mean(taken), v)
  if (score >= ENROL_AGREE) return { ok: true, score }
  return { ok: false, why: 'unlike', score, restart: taken.length === 1 }
}

/**
 * The voiceprint once calibrated: the clips read, kept for good, and of what
 * was learned before, only what sounds like them - anything else learned
 * passively was someone else, or the room. Calibrating is asking for it, so
 * it is on afterwards even if it was turned off.
 */
export function enrolled(print: Voiceprint, read: Clip[]): Voiceprint {
  const fresh: Voiceprint = { model: print.model, clips: read.map((c) => ({ ...c, v: kept(c.v), enrolled: true })) }
  const c = centre(fresh)!
  const heard = print.clips.filter((x) => !x.enrolled && cosine(c, x.v) >= LEARN_ABOVE).slice(-KEEP_LEARNED)
  return { ...fresh, clips: [...fresh.clips, ...heard] }
}

/**
 * How steady the voice read was: each clip against the others, the lowest.
 * Low means a noisy room or a mic that struggles, and the person is likelier
 * to be turned away - worth saying, and worth calibrating again somewhere
 * quieter.
 */
export function steadiness(read: { v: ArrayLike<number> }[]): number | null {
  if (read.length < 2) return null
  let low = 1
  for (let i = 0; i < read.length; i++) low = Math.min(low, cosine(mean(read.filter((_, j) => j !== i)), read[i].v))
  return low
}
