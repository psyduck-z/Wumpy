/**
 * What each key has spent today, which model it spent it on, and when it
 * comes back.
 *
 * The app already rotated across twenty keys and already counted requests per
 * model. What it could not do was say how much was left, because the two
 * halves were never put together: the counter knew "forty turns today" and
 * the rotation knew "three keys are resting", and the thing the user actually
 * asked - "make it easier to navigate the quota, make it more accurate" -
 * needs both at once.
 *
 * Three facts about Google's free tier shape all of this, and each one was a
 * bug before it was a fact.
 *
 *   1. The allowance is per PROJECT and per MODEL. Twenty keys is twenty
 *      allowances, and a key that is out of gemini-3.8-flash still has its
 *      whole gemini-3.5-flash allowance - so resting the key itself for the
 *      day, which is what used to happen, threw away quota that existed.
 *   2. It resets at midnight Pacific, not at local midnight. Counting on the
 *      local day meant the totals cleared eight hours early and the meter
 *      read 0% while the quota was spent.
 *   3. Nothing reports it. There is no endpoint for "how much is left", so
 *      the only figures available are the ones this machine observed, which
 *      is why they are kept per key rather than averaged into one number.
 *
 * Pure: no electron, no disk, no clock of its own. Every function takes the
 * state and returns new state, so the checks can run a whole day of traffic
 * through it in a millisecond.
 */

/** What one key has done today. */
export interface KeySpend {
  /** Requests handed to this key today, per model. */
  models: Record<string, number>
  /**
   * Resting until this moment for EVERY model: a per-minute throttle, or a
   * key the provider rejected outright. 0 when it is ready.
   */
  restUntil: number
  why: string
  /**
   * Models this key is out of for the rest of the quota day, each with the
   * moment it comes back.
   *
   * Separate from restUntil because a daily cap is per model: one exhausted
   * model must not take the other models on that key down with it.
   */
  outOf: Record<string, number>
}

/** One quota day for one provider's pool of keys. */
export interface PoolDay {
  /** The Pacific calendar day these counts belong to. */
  day: string
  /** How many keys the pool had. A different number means it changed. */
  keys: number
  spend: KeySpend[]
}

export function emptySpend(): KeySpend {
  return { models: {}, restUntil: 0, why: '', outOf: {} }
}

/**
 * Has anything expensive to rediscover changed?
 *
 * Request counts can wait for the debounce - losing the last few costs the
 * meter a little accuracy. A REST cannot: it is the one fact in this ledger
 * that costs a request to learn, and a key rejected at 10:50 was being
 * rejected again at 12:21 after a restart in between. The restart is
 * `Stop-Process -Force`, so nothing gets a chance to save on the way out and
 * whatever was sitting in a four-second timer is simply gone.
 *
 * So the store asks this and writes immediately when the answer is yes. It
 * happens a handful of times a day, against a file of two kilobytes.
 */
export function restsChanged(before: PoolDay | null, after: PoolDay): boolean {
  if (!before) return after.spend.some((s) => s.restUntil > 0 || Object.keys(s.outOf).length > 0)
  if (before.spend.length !== after.spend.length || before.day !== after.day) return true
  return after.spend.some((now, i) => {
    const was = before.spend[i]
    if (!was) return true
    if (was.restUntil !== now.restUntil || was.why !== now.why) return true
    const models = new Set([...Object.keys(was.outOf), ...Object.keys(now.outOf)])
    for (const m of models) if (was.outOf[m] !== now.outOf[m]) return true
    return false
  })
}

export function emptyPool(day: string, keys: number): PoolDay {
  return { day, keys, spend: Array.from({ length: Math.max(0, keys) }, emptySpend) }
}

/**
 * Brings a pool up to date: a new quota day, or a different number of keys.
 *
 * Growing keeps what the existing keys have spent, because they are the same
 * keys - KeyStore.add appends and never reorders. Shrinking throws the whole
 * ledger away, because the only way to shrink is to replace the list and
 * there is then no way to know which key is now at which index. Starting
 * clean costs one 429 per dead key; guessing wrongly costs quota all day.
 *
 * Days only ever move FORWARD. An earlier day arriving is a clock that went
 * backwards, a timestamp from somewhere else, or a daylight-saving wobble,
 * and none of those are a reason to forget that eight keys are out until
 * midnight - which is exactly what a plain inequality did: it wiped the
 * ledger every time it was asked about a moment in the past.
 */
export function rollPool(pool: PoolDay, day: string, keys: number): PoolDay {
  const want = Math.max(0, Math.floor(keys))
  if (day > pool.day) return emptyPool(day, want)
  if (want === pool.spend.length) return { ...pool, keys: want }
  if (want < pool.spend.length) return emptyPool(pool.day, want)
  const spend = pool.spend.slice(0, want)
  while (spend.length < want) spend.push(emptySpend())
  return { ...pool, keys: want, spend }
}

function withSpend(pool: PoolDay, index: number, next: KeySpend): PoolDay {
  if (index < 0 || index >= pool.spend.length) return pool
  const spend = pool.spend.slice()
  spend[index] = next
  return { ...pool, spend }
}

/** One request, about to be sent on this key for this model. */
export function spendOn(pool: PoolDay, index: number, model: string): PoolDay {
  const prev = pool.spend[index]
  if (!prev) return pool
  const key = model || 'unknown'
  return withSpend(pool, index, {
    ...prev,
    models: { ...prev.models, [key]: (prev.models[key] ?? 0) + 1 }
  })
}

/**
 * Rests the whole key, for a throttle or a rejection.
 *
 * Never shortens an existing rest: a daily exhaustion arrives with a
 * retryDelay measured in seconds, and letting that overwrite a longer rest is
 * how a dead key gets hammered all day.
 */
export function restOn(pool: PoolDay, index: number, until: number, why: string): PoolDay {
  const prev = pool.spend[index]
  if (!prev) return pool
  if (prev.restUntil >= until) return pool
  return withSpend(pool, index, { ...prev, restUntil: until, why })
}

/** Takes one model out on one key until `until`, leaving its other models alone. */
export function outOn(pool: PoolDay, index: number, model: string, until: number): PoolDay {
  const prev = pool.spend[index]
  if (!prev) return pool
  const key = model || 'unknown'
  if ((prev.outOf[key] ?? 0) >= until) return pool
  return withSpend(pool, index, { ...prev, outOf: { ...prev.outOf, [key]: until } })
}

/** Can this key serve this model right now? */
export function isReady(spend: KeySpend | undefined, model: string, now: number): boolean {
  if (!spend) return false
  if (spend.restUntil > now) return false
  return (spend.outOf[model || 'unknown'] ?? 0) <= now
}

export function readyCount(pool: PoolDay, model: string, now: number): number {
  let free = 0
  for (const spend of pool.spend) if (isReady(spend, model, now)) free++
  return free
}

/** How long until some key can serve this model, 0 when one already can. */
export function nextFreeMs(pool: PoolDay, model: string, now: number): number {
  if (!pool.spend.length) return 0
  let soonest = Infinity
  for (const spend of pool.spend) {
    if (isReady(spend, model, now)) return 0
    const mine = Math.max(spend.restUntil, spend.outOf[model || 'unknown'] ?? 0)
    if (mine > now) soonest = Math.min(soonest, mine)
  }
  return soonest === Infinity ? 0 : soonest - now
}

export function requestsOn(pool: PoolDay, index: number, model: string): number {
  return pool.spend[index]?.models[model || 'unknown'] ?? 0
}

/** Every request today on this model, across the pool. */
export function requestsFor(pool: PoolDay, model: string): number {
  let total = 0
  for (const spend of pool.spend) total += spend.models[model || 'unknown'] ?? 0
  return total
}

/* ------------------------------------------------------------ what to show */

/**
 * 'rejected' is its own thing, and finding that out was the point.
 *
 * Measured on this machine: three of twenty keys answered 401 with "the
 * bound service account is deleted or disabled". The app had been rotating
 * across all twenty for weeks, so one turn in seven was spending a request
 * to rediscover a key that will never work again, and the meter was
 * measuring the day against 500 requests when 425 existed. Nothing said so,
 * because a rejected key was rested like any other and read as "resting".
 */
export type KeyState = 'ready' | 'resting' | 'out' | 'rejected'

/** A rest with this reason is a key that needs replacing, not waiting for. */
export const REJECTED = 'rejected'

export interface KeyRow {
  /** 1-based, because that is how the log lines name them. */
  number: number
  requests: number
  state: KeyState
  /** When it comes back, 0 when it is ready. */
  untilMs: number
  why: string
}

export interface PoolView {
  day: string
  model: string
  keys: number
  /** Usable for this model right now. */
  ready: number
  /** Out of this model until the quota day turns over. */
  spent: number
  /** Resting for a minute or so, not for the day. */
  resting: number
  /**
   * Keys the provider refused outright - deleted project, revoked key.
   *
   * Counted apart from the rest because it is the only state the user has to
   * do something about: waiting does not fix it and tomorrow will not
   * either. Three of twenty were in this state here and nothing said so.
   */
  rejected: number
  /** Requests made on this model today, across the pool. */
  requests: number
  /** The per-project daily cap, or 0 when nothing credible is known. */
  perKeyCap: number
  /** The pool's ceiling: the per-key cap times the number of keys. */
  cap: number
  /** Requests still available today, or null when the cap is unknown. */
  remaining: number | null
  /** 0 to 1 of the pool's day spent, or null when the cap is unknown. */
  usedFraction: number | null
  /** 0 when something is usable now. */
  nextFreeMs: number
  /** When Google's day turns over, which is when everything comes back. */
  resetAt: number
  rows: KeyRow[]
}

/**
 * The pool as a human would describe it.
 *
 * `remaining` deliberately does not count keys that are out for the day: it
 * sums what the keys that can still answer have left. That makes it the
 * number worth acting on - "I have 310 requests before this stops working" -
 * where the old meter multiplied one key's allowance by twenty whether or not
 * the twenty were alive.
 *
 * A per-minute rest does NOT reduce it, because those keys come back within
 * the minute and nothing about the day's allowance was lost.
 */
export function poolView(
  pool: PoolDay,
  model: string,
  perKeyCap: number,
  now: number,
  resetAt: number
): PoolView {
  const key = model || 'unknown'
  const cap = Math.max(0, Math.floor(perKeyCap))
  let ready = 0
  let spent = 0
  let resting = 0
  let rejected = 0
  let requests = 0
  let left = 0
  const rows: KeyRow[] = []

  pool.spend.forEach((spend, index) => {
    const mine = spend.models[key] ?? 0
    requests += mine
    const out = (spend.outOf[key] ?? 0) > now
    const held = spend.restUntil > now
    const dead = held && spend.why === REJECTED
    const state: KeyState = dead ? 'rejected' : out ? 'out' : held ? 'resting' : 'ready'
    if (state === 'ready') ready++
    else if (state === 'out') spent++
    else if (state === 'rejected') rejected++
    else resting++
    /*
     * Only a key that can still answer has anything left to give. One that
     * is out for the day contributes nothing; one the provider rejected
     * contributes nothing ever, and counting its full allowance is how the
     * meter came to promise 500 requests on a pool that could serve 425.
     */
    if (!out && !dead && cap) left += Math.max(0, cap - mine)
    rows.push({
      number: index + 1,
      requests: mine,
      state,
      untilMs: out ? (spend.outOf[key] ?? 0) : held ? spend.restUntil : 0,
      why: dead ? REJECTED : out ? 'daily quota' : held ? spend.why : ''
    })
  })

  /*
   * The ceiling counts only the keys that could serve today, so a dead key
   * lowers the ceiling rather than silently inflating what is remaining.
   */
  const ceiling = cap * (pool.spend.length - rejected)
  return {
    day: pool.day,
    model: key,
    keys: pool.spend.length,
    ready,
    spent,
    resting,
    rejected,
    requests,
    perKeyCap: cap,
    cap: ceiling,
    remaining: ceiling ? left : null,
    usedFraction: ceiling ? Math.min(1, Math.max(0, 1 - left / ceiling)) : null,
    nextFreeMs: nextFreeMs(pool, key, now),
    resetAt,
    rows
  }
}

/* -------------------------------------------------------- the quota clock */

/**
 * The Pacific calendar day, which is the day Google's counters belong to.
 *
 * Not the local day. The usage file rolled over at local midnight, which from
 * here is eight hours before the quota resets: a late-night session saw its
 * totals clear and the meter read 0% while every key was still spent. The
 * date is the one thing in this file that has to come from a real timezone
 * database rather than from arithmetic.
 */
export function pacificDayKey(now: number = Date.now()): string {
  const formatted = new Date(now).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles'
  })
  /* en-CA is ISO, but a runtime without full ICU would answer something else
     and a malformed day key would never match and so never roll. */
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(formatted)) return formatted
  const shifted = new Date(now - 8 * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * When a daily quota comes back.
 *
 * Google resets requests-per-day at midnight Pacific, which is the one reset
 * time worth hardcoding because the error body never carries it - a daily
 * exhaustion arrives with a retryDelay measured in seconds, and sleeping for
 * that is how a key gets hammered all day.
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
