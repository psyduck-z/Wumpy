/**
 * How many requests a minute each key really allows, found by asking.
 *
 * "keep testing the api keys and give them 'tests' to find their limits".
 * The pacer has run on one number for every NVIDIA key - 1,700ms between
 * requests, about 35 a minute, under the 40 NVIDIA states - and background
 * agents now spend keys of their own, so what a key really takes matters
 * more than it did. So, when Wumpy is idle, one key at a time is sent tiny
 * requests at a steady pace a little over the stated limit, until it says
 * no or a minute and a quarter has passed. What it accepted in the minute
 * before the first refusal is its limit; with no refusal, at least what it
 * took.
 *
 * Pure: what to test and what the answers mean. main/limits.ts sends.
 */

/** One request in a test: when it went out, and what came back. */
export interface Sample {
  at: number
  status: number
}

export interface KeyLimit {
  /** Requests a minute it took; a floor when `capped` is false. */
  rpm: number
  /** Whether it refused: the number is its limit, not just what was asked. */
  capped: boolean
  at: number
  /** How many keys there were: a record from a different set means nothing. */
  keys: number
}

/** Faster than the stated 40, so a limit of 40 shows itself. */
export const TEST_EVERY_MS = 1200
/** Long enough for a full minute's window and the refusal after it. */
export const TEST_FOR_MS = 75_000
/** How long a key's limit stands before it is tested again. */
export const RETEST_AFTER_MS = 24 * 3_600_000
/** How quiet the user must have been before a test starts. */
export const QUIET_FOR_MS = 10 * 60_000
/** Below this a reading is noise - a dropped connection, not a limit. */
const LEAST = 5

/**
 * What a test found. A failure that is not a refusal (a 500, no answer)
 * says nothing about the rate and is left out of the count.
 */
export function limitFrom(samples: readonly Sample[], keys: number, now: number): KeyLimit | null {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const refused = sorted.find((s) => s.status === 429)
  const ok = sorted.filter((s) => s.status >= 200 && s.status < 300)
  if (refused) {
    const before = ok.filter((s) => s.at <= refused.at && s.at > refused.at - 60_000).length
    return before >= LEAST ? { rpm: before, capped: true, at: now, keys } : null
  }
  /* No refusal: the most it took in any minute is a floor. */
  let best = 0
  for (const s of ok) best = Math.max(best, ok.filter((o) => o.at >= s.at && o.at < s.at + 60_000).length)
  return best >= LEAST ? { rpm: best, capped: false, at: now, keys } : null
}

/** The key to test next, or null: the one tested longest ago, if it is due. */
export function dueKey(limits: Readonly<Record<string, KeyLimit>>, provider: string, keys: number, now: number): number | null {
  let pick: number | null = null
  let oldest = Infinity
  for (let i = 0; i < keys; i++) {
    const known = limits[`${provider}:${i}`]
    /* Never tested, or tested with another set of keys: due first. */
    const at = known && known.keys === keys ? known.at : -Infinity
    if (now - at < RETEST_AFTER_MS) continue
    if (pick === null || at < oldest) {
      oldest = at
      pick = i
    }
  }
  return pick
}

/**
 * The gap the pacer keeps on a key that has been measured: a tenth under
 * its limit, and never faster than one request a second. Null when nothing
 * is known, or it is out of date, and the provider's own gap stands.
 */
export function gapFor(limit: KeyLimit | undefined, keys: number): number | null {
  if (!limit || limit.keys !== keys || limit.rpm < LEAST) return null
  return Math.max(1000, Math.ceil(60_000 / (limit.rpm * 0.9)))
}

/** "Key 2 takes 40 requests a minute", for the log and /log. */
export function limitLine(index: number, limit: KeyLimit): string {
  return `key ${index + 1} takes ${limit.capped ? '' : 'at least '}${limit.rpm} requests a minute`
}
