/**
 * Tokens per second, or nothing.
 *
 * The old sum was `completion / max(1, ms) * 1000`, and that 1ms floor is a
 * lie dressed as arithmetic: when a short reply arrives in a single chunk the
 * streaming window is under a millisecond, so the rate came out as the token
 * count times a thousand. That is where "8,000 tokens a second" came from -
 * eight tokens in one chunk. Nothing was fast; the clock was too coarse to
 * measure it.
 *
 * A number nobody can trust is worse than no number, because the meter exists
 * to tell the user which model is quick. So below a window long enough to
 * measure, this reports null and the meter shows nothing.
 */

/**
 * The shortest window worth dividing by.
 *
 * Deltas arrive in bursts a few tens of milliseconds apart, so anything under
 * about an eighth of a second is one or two samples and the result is noise
 * either way.
 */
export const MIN_WINDOW_MS = 120

/**
 * And the fewest tokens worth a rate.
 *
 * "1 word, instantly" is not a throughput measurement whatever the window,
 * and `/btw` answers are deliberately one line.
 */
export const MIN_TOKENS = 4

export function tokensPerSecond(completion: number, windowMs: number): number | null {
  if (!Number.isFinite(completion) || !Number.isFinite(windowMs)) return null
  if (completion < MIN_TOKENS) return null
  if (windowMs < MIN_WINDOW_MS) return null
  return (completion / windowMs) * 1000
}
