/**
 * Where to cut a long turn so Whisper hears all of it.
 *
 * Whisper listens in thirty-second windows. Handed 34.7 seconds of one
 * person talking - "heard 36.5s of talking" is a real turn - it got 21 of
 * 119 words wrong, against 1.7% on short clips: a stretch at the window's
 * edge simply did not come back. So a turn longer than LONGEST is cut into
 * pieces, each at the quietest moment between SHORTEST and LONGEST seconds
 * into it - the gap between two words, or a breath - and each piece is
 * heard on its own, all of them at once, and joined.
 *
 * Pure: 16-bit mono samples in, sample offsets out. See hear() in main.
 */

/** No piece longer than this, in seconds: a margin under Whisper's thirty. */
export const LONGEST_PIECE_S = 25

/** Nor, where it can be helped, shorter than this: a pause is looked for after it. */
export const SHORTEST_PIECE_S = 12

/** How long a quiet moment has to be to cut in, in seconds. */
const GAP_S = 0.12

/**
 * The offsets to cut at, in samples, in order. Empty for anything that fits
 * one window, which is nearly every turn.
 */
export function cutsFor(
  samples: Int16Array,
  rate: number,
  longest = LONGEST_PIECE_S,
  shortest = SHORTEST_PIECE_S
): number[] {
  const most = Math.round(longest * rate)
  if (samples.length <= most) return []
  const least = Math.round(shortest * rate)
  const gap = Math.max(1, Math.round(GAP_S * rate))
  const step = Math.max(1, Math.round(gap / 4))
  /* Running sums of energy, so any window's is one subtraction. */
  const energy = new Float64Array(samples.length + 1)
  for (let i = 0; i < samples.length; i++) energy[i + 1] = energy[i] + samples[i] * samples[i]
  const cuts: number[] = []
  let start = 0
  while (samples.length - start > most) {
    const from = start + least
    const to = Math.min(start + most, samples.length) - gap
    let at = start + most
    let quietest = Infinity
    for (let i = from; i <= to; i += step) {
      const e = energy[i + gap] - energy[i]
      if (e < quietest) {
        quietest = e
        at = i + Math.round(gap / 2)
      }
    }
    cuts.push(at)
    start = at
  }
  return cuts
}

/** The pieces themselves, between the cuts. */
export function piecesOf(samples: Int16Array, cuts: readonly number[]): Int16Array[] {
  const edges = [0, ...cuts, samples.length]
  return edges.slice(1).map((end, i) => samples.subarray(edges[i], end))
}
