/**
 * Speech made faster without making it higher.
 *
 * "Can you make him speak a little bit faster? ...I'm able to listen
 * faster." Magpie takes SSML's <prosody rate>, and ignores it: measured
 * from here, the same sentence at 0.8, 1, 1.15, 1.3 and 1.5 came back
 * between 5.7 and 5.9 seconds every time. Playing it faster would raise
 * his voice with it. So it is time-stretched here, by WSOLA: the sound is
 * cut into short overlapping windows, taken from further apart than they
 * are laid down, and each one is nudged - within a few milliseconds - to
 * where it lines up best with the one before, so the voice's own waveform
 * runs on unbroken and its pitch stays where it was.
 *
 * Streaming, because Magpie's sound arrives a fifth of a second at a time
 * and is played as it comes: push() takes each piece and returns what can
 * be laid down so far; flush() the rest, at the end of a stretch of speech.
 * Pure, so scripts/check-speakahead.mjs can time and pitch it.
 */

/** Window length, in samples at Magpie's 22.05kHz: about 29ms, a little over two periods of a low voice. */
export const WINDOW = 640
const HALF = WINDOW / 2
/** How far a window may be nudged to line up, either way: about 7ms. */
export const NUDGE = 160

const HANN = Float32Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW))

export class Stretcher {
  /** Input not yet used up, starting at absolute sample `base`. */
  private input = new Float32Array(0)
  private base = 0
  /** Windows laid down so far. */
  private k = 0
  /** Where the last window was taken from, absolute; -1 before the first. */
  private last = -1
  /** The second half of the last window, waiting for the next one to overlap it. */
  private tail = new Float32Array(HALF)

  /** `speed` 1.15 is fifteen percent faster. */
  constructor(private readonly speed: number) {}

  push(samples: Float32Array): Float32Array {
    if (this.speed === 1) return samples
    const joined = new Float32Array(this.input.length + samples.length)
    joined.set(this.input)
    joined.set(samples, this.input.length)
    this.input = joined
    return this.run(false)
  }

  /** Everything left, once no more is coming. */
  flush(): Float32Array {
    if (this.speed === 1) return new Float32Array(0)
    const out = this.run(true)
    const rest = new Float32Array(out.length + HALF)
    rest.set(out)
    rest.set(this.tail, out.length)
    this.input = new Float32Array(0)
    this.tail = new Float32Array(HALF)
    this.k = 0
    this.last = -1
    this.base = 0
    return rest
  }

  private at(abs: number): number {
    const i = abs - this.base
    return i >= 0 && i < this.input.length ? this.input[i] : 0
  }

  private run(ending: boolean): Float32Array {
    const end = this.base + this.input.length
    const out: number[] = []
    for (;;) {
      const nominal = Math.round(this.k * HALF * this.speed)
      /* Room to search either side and a whole window after. At the end,
         whatever is there, padded with silence, until the input runs out. */
      if (!ending && nominal + NUDGE + WINDOW > end) break
      if (ending && nominal >= end) break
      let from = nominal
      if (this.last >= 0) {
        /* Line up with what naturally followed the last window. */
        const natural = this.last + HALF
        let best = -Infinity
        const lo = Math.max(this.base, nominal - NUDGE)
        const hi = nominal + NUDGE
        for (let c = lo; c <= hi; c += 2) {
          let sum = 0
          for (let i = 0; i < HALF; i += 2) sum += this.at(c + i) * this.at(natural + i)
          if (sum > best) {
            best = sum
            from = c
          }
        }
      }
      for (let i = 0; i < HALF; i++) out.push(this.tail[i] + this.at(from + i) * HANN[i])
      for (let i = 0; i < HALF; i++) this.tail[i] = this.at(from + HALF + i) * HANN[HALF + i]
      this.last = from
      this.k++
    }
    /* Keep only what the next window can still reach. */
    const keepFrom = Math.min(this.last >= 0 ? this.last + HALF : this.base, Math.round(this.k * HALF * this.speed) - NUDGE)
    const drop = Math.max(0, Math.min(this.input.length, keepFrom - this.base))
    if (drop > 0) {
      this.input = this.input.slice(drop)
      this.base += drop
    }
    return Float32Array.from(out)
  }
}
