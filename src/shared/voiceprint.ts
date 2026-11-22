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
 * The person's own is learned, not recorded on purpose: the first
 * LEARN_CLIPS things they say in conversations, each long enough to judge,
 * are kept. It is their earbuds, so the voice in them is theirs. After
 * that a clip that sounds clearly like them keeps being learned from (up to
 * KEEP_CLIPS, oldest out), so a new microphone, a cold or a quiet evening
 * voice are taken in as they come rather than turned away.
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

export interface Voiceprint {
  /** The model the clips came from: another model's numbers mean nothing to this one. */
  model: string
  clips: { v: number[]; at: number; ms: number; device: string }[]
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

/** The voice, as the average of the clips learned. */
export function centre(print: Voiceprint): number[] | null {
  if (!print.clips.length) return null
  const sum = new Array<number>(print.clips[0].v.length).fill(0)
  for (const c of print.clips) {
    const u = unit(c.v)
    for (let i = 0; i < sum.length; i++) sum[i] += u[i]
  }
  return unit(sum)
}

export const known = (print: Voiceprint): boolean => print.clips.length >= LEARN_CLIPS

/** How like the person a clip is. Null before there is anything to compare with. */
export function likeness(print: Voiceprint, v: ArrayLike<number>): number | null {
  const c = centre(print)
  return c ? cosine(c, v) : null
}

/** Whose voice this was, for a clip of `talkedMs` talking. */
export function judge(print: Voiceprint, v: ArrayLike<number> | null, talkedMs: number): Verdict {
  if (print.off) return { kind: 'theirs', score: null, why: 'off' }
  const score = v ? likeness(print, v) : null
  if (!known(print) || score === null) return { kind: 'theirs', score, why: 'learning' }
  if (talkedMs < JUDGE_FROM_MS) return { kind: 'theirs', score, why: 'short' }
  if (score < cutOff(talkedMs)) return { kind: 'someone else', score }
  return { kind: 'theirs', score, why: 'match' }
}

/**
 * The voiceprint with this clip learned, or the same one if it should not
 * be: too short, turned off, or not clearly them. While still learning, a
 * clip unlike the ones so far (from the third on) is left out too, so a
 * visitor in the first few minutes is not made part of the person's voice.
 */
export function learn(print: Voiceprint, v: ArrayLike<number>, talkedMs: number, device: string, at = Date.now()): Voiceprint {
  if (print.off || talkedMs < LEARN_FROM_MS) return print
  const score = likeness(print, v)
  const enough = known(print) ? LEARN_ABOVE : print.clips.length >= 2 ? SAME_ABOVE : -1
  if (score !== null && score < enough) return print
  const clips = [...print.clips, { v: Array.from(v, (x) => Math.round(x * 1e5) / 1e5), at, ms: Math.round(talkedMs), device }]
  return { ...print, clips: clips.slice(-KEEP_CLIPS) }
}
