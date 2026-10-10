/**
 * Which of several API keys to use next, and which are resting.
 *
 * Measured on this machine, Gemini's free tier allows FIVE requests a minute
 * on gemini-3.5-flash and gemini-3-flash-preview, fifteen on
 * gemini-3.5-flash-lite. One Wumpy install - propose, run, report, verify,
 * run, report - is four requests, so a single project is spent most of a
 * minute by one interaction.
 *
 * Google applies those limits PER PROJECT, not per key, which is the thing
 * most advice gets wrong: three keys in one project share one allowance and
 * rotating between them buys nothing. Five keys from five projects is five
 * times the allowance.
 *
 * This holds no keys and knows nothing about providers. It is a cooldown
 * tracker over N slots, which makes it testable without a network, a
 * provider, or a secret.
 */

/** A slot that is resting until `until`, with the reason for the record. */
interface Resting {
  until: number
  why: string
}

export class KeyRotation {
  private readonly resting = new Map<number, Resting>()
  private cursor = 0

  constructor(private count: number) {}

  /** Tells it how many keys there are now, after one was added or removed. */
  resize(count: number): void {
    this.count = count
    for (const index of [...this.resting.keys()]) {
      if (index >= count) this.resting.delete(index)
    }
    if (this.cursor >= count) this.cursor = 0
  }

  /**
   * The next key to try, or null when every one of them is resting.
   *
   * Round-robin rather than always-the-first, so the load spreads instead of
   * hammering key one until it dies and then key two. That matters for a
   * per-minute limit: five keys used evenly give five times the rate, five
   * keys used in order give the same rate and five times the duration.
   */
  next(now: number = Date.now()): number | null {
    if (this.count <= 0) return null
    for (let step = 0; step < this.count; step++) {
      const index = (this.cursor + step) % this.count
      const rest = this.resting.get(index)
      if (rest && rest.until > now) continue
      if (rest) this.resting.delete(index)
      this.cursor = (index + 1) % this.count
      return index
    }
    return null
  }

  /** Marks a key as spent until a moment, after a 429 that named one. */
  rest(index: number, until: number, why = 'rate limited'): void {
    if (index < 0 || index >= this.count) return
    const current = this.resting.get(index)
    // Never shorten an existing rest: a daily exhaustion outranks a
    // per-minute one that arrives afterwards.
    if (current && current.until >= until) return
    this.resting.set(index, { until, why })
  }

  /** How long until something is usable again, or 0 if one already is. */
  waitMs(now: number = Date.now()): number {
    if (this.count <= 0) return 0
    if (this.resting.size < this.count) return 0
    let soonest = Infinity
    for (const { until } of this.resting.values()) {
      if (until > now) soonest = Math.min(soonest, until)
      else return 0
    }
    return soonest === Infinity ? 0 : soonest - now
  }

  /** For a status line: how many are usable right now. */
  availableCount(now: number = Date.now()): number {
    let free = 0
    for (let i = 0; i < this.count; i++) {
      const rest = this.resting.get(i)
      if (!rest || rest.until <= now) free++
    }
    return free
  }
}

/**
 * When a daily quota comes back.
 *
 * Google resets requests-per-day at midnight Pacific, which is the one
 * reset time worth hardcoding because the error body never carries it - a
 * daily exhaustion arrives with a retryDelay measured in seconds, and
 * sleeping for that is how a key gets hammered all day.
 */
export function nextPacificMidnight(now: number = Date.now()): number {
  const here = new Date(now)
  // Pacific is UTC-8, or UTC-7 while daylight saving is on. Asking the
  // runtime avoids getting the changeover wrong twice a year.
  const pacificNow = new Date(here.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const offsetMs = here.getTime() - pacificNow.getTime()
  const midnight = new Date(pacificNow)
  midnight.setHours(24, 0, 0, 0)
  return midnight.getTime() + offsetMs
}

/**
 * Splits a pasted blob into keys.
 *
 * Lives here rather than on KeyStore because KeyStore imports electron, and
 * a pure function behind an electron import cannot be tested without one.
 * Five keys arrive as a single paste; looksLikeKey refuses anything with a
 * space in it, so the splitting has to happen before the validating.
 */
export function splitKeys(blob: string): string[] {
  return (blob ?? '')
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter(Boolean)
}
