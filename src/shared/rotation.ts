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
 * This holds no keys and knows nothing about providers. It is a scheduler
 * over N slots and a ledger of what each slot has spent, which makes it
 * testable without a network, a provider, or a secret.
 *
 * The ledger itself lives in pool.ts, so that it can be written to disk and
 * read back: a cooldown that is forgotten on restart means every dead key is
 * tried again, and during development Wumpy restarts several times an hour.
 */

import {
  chooseKey,
  emptyPool,
  nextFreeMs,
  outOn,
  pacificDayKey,
  poolView,
  readyCount,
  requestsOn,
  restOn,
  rollPool,
  spendOn,
  type PoolDay,
  type PoolView
} from './pool'

export { nextPacificMidnight, pacificDayKey } from './pool'

export class KeyRotation {
  private pool: PoolDay
  private cursor = 0

  /**
   * Picks up where a previous run left off, when it is handed a ledger.
   *
   * Without one it starts clean, which is the right default for a test and
   * for a first run. With one, a key that is out until midnight Pacific stays
   * out across a restart instead of costing another 429 to rediscover.
   */
  constructor(
    private count: number,
    saved?: PoolDay | null,
    now: number = Date.now()
  ) {
    const day = pacificDayKey(now)
    this.pool = rollPool(saved ?? emptyPool(day, count), day, count)
  }

  /** Tells it how many keys there are now, after one was added or removed. */
  resize(count: number, now: number = Date.now()): void {
    this.count = count
    this.pool = rollPool(this.pool, pacificDayKey(now), count)
    if (this.cursor >= count) this.cursor = 0
  }

  /** Rolls the ledger over at midnight Pacific without needing a timer. */
  private fresh(now: number): PoolDay {
    const day = pacificDayKey(now)
    if (this.pool.day !== day) this.pool = rollPool(this.pool, day, this.count)
    return this.pool
  }

  /**
   * The next key to try, or null when every one of them is resting.
   *
   * The decision is `chooseKey`, in pool.ts, made from the ledger on disk
   * rather than from the in-memory cursor this used to walk. The cursor did
   * not survive a restart - it starts at zero every launch - so every short
   * session spent its requests on the first few keys, and the three projects
   * Google went on to restrict were Wumpy1, Wumpy2 and Wumpy3.
   *
   * The cursor is still here, as the last tie-break on a pool where nothing
   * distinguishes one key from another.
   *
   * Takes the model because the allowance is per model as well as per
   * project: a key that is out of one model is still the right key for
   * another, and skipping it for everything was quota thrown away.
   */
  next(now: number = Date.now(), model = ''): number | null {
    if (this.count <= 0) return null
    this.fresh(now)
    const index = chooseKey(this.pool, model, now, this.cursor)
    if (index === null) return null
    this.cursor = (index + 1) % this.count
    this.pool = spendOn(this.pool, index, model, now)
    return index
  }

  /**
   * Marks a key as spent until a moment, for every model.
   *
   * For a throttle, or a key the provider rejected. A daily cap is per model
   * and belongs in `out` instead.
   */
  rest(index: number, until: number, why = 'rate limited'): void {
    if (index < 0 || index >= this.count) return
    this.pool = restOn(this.pool, index, until, why)
  }

  /** Marks one model on one key as out until the quota day turns over. */
  out(index: number, model: string, until: number): void {
    if (index < 0 || index >= this.count) return
    this.pool = outOn(this.pool, index, model, until)
  }

  /** How long until something is usable again, or 0 if one already is. */
  waitMs(now: number = Date.now(), model = ''): number {
    if (this.count <= 0) return 0
    return nextFreeMs(this.fresh(now), model, now)
  }

  /** For a status line: how many are usable right now. */
  availableCount(now: number = Date.now(), model = ''): number {
    if (this.count <= 0) return 0
    return readyCount(this.fresh(now), model, now)
  }

  /** What this key has spent on this model today, for a measured cap. */
  requests(index: number, model = '', now: number = Date.now()): number {
    return requestsOn(this.fresh(now), index, model)
  }

  /** The whole ledger, to be written to disk. */
  snapshot(now: number = Date.now()): PoolDay {
    return this.fresh(now)
  }

  /** The pool as a report can print it. */
  view(model: string, perKeyCap: number, resetAt: number, now: number = Date.now()): PoolView {
    return poolView(this.fresh(now), model, perKeyCap, now, resetAt)
  }
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
