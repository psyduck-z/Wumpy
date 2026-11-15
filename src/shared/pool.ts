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
  /**
   * The provider refused this key outright: a deleted or disabled service
   * account, a project Google restricted for heavy free-tier use.
   *
   * A STATE, not a wait, and that distinction is the whole of this field.
   * It used to be a 24-hour rest tagged `rejected`, which made a permanent
   * fact expire twice over: once when the day advanced and `rollPool` threw
   * the ledger away, and once when the 24 hours were up. Measured here on
   * 14 October: three keys refused at 16:14 the day before read `ready`
   * again at 15:00, because midnight Pacific had wiped them - so the meter
   * promised twenty keys' allowance on a pool of seventeen, and the
   * rotation, which prefers the keys with the fewest requests, reached for
   * the three dead ones FIRST every morning.
   *
   * Nothing about a restricted project changes at midnight. So this survives
   * the roll, and the only things that clear it are a key list that changed
   * and `/key <provider> check`, which asks the provider and costs nothing
   * from the day's allowance.
   */
  rejected?: boolean
  /**
   * When this key was last handed a request.
   *
   * For spreading the load in TIME as well as in total. Two keys that have
   * each served forty requests today are equally used by the count, and the
   * one that served its fortieth ten seconds ago is the wrong one to pick
   * next when the limit being avoided is five a minute.
   *
   * Optional because ledgers written before it exists load without it, and
   * a missing timestamp reads as "not for a long time", which is the safe
   * direction: a key nobody has a record of using is a fine key to use.
   */
  lastAt?: number
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
  if (!before)
    return after.spend.some(
      (s) => s.restUntil > 0 || s.rejected === true || Object.keys(s.outOf).length > 0
    )
  if (before.spend.length !== after.spend.length || before.day !== after.day) return true
  return after.spend.some((now, i) => {
    const was = before.spend[i]
    if (!was) return true
    if (was.restUntil !== now.restUntil || was.why !== now.why) return true
    /* A refusal is the most expensive fact in here to rediscover, and the
       one most likely to be lost: it arrives mid-turn, and the next thing
       that happens to this process is usually Stop-Process -Force. */
    if ((was.rejected === true) !== (now.rejected === true)) return true
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
 *
 * A new day clears the counts and the rests, because that is what the quota
 * day means, and keeps the REFUSALS, because that is not. See `rejected`.
 */
export function rollPool(pool: PoolDay, day: string, keys: number): PoolDay {
  const want = Math.max(0, Math.floor(keys))
  if (day > pool.day) return nextDay(pool, day, want)
  if (want === pool.spend.length) return { ...pool, keys: want }
  if (want < pool.spend.length) return emptyPool(pool.day, want)
  const spend = pool.spend.slice(0, want)
  while (spend.length < want) spend.push(emptySpend())
  return { ...pool, keys: want, spend }
}

/**
 * The same keys, a clean day, and the refusals still refused.
 *
 * Only the positions that exist in both ledgers carry anything over, and the
 * only thing they carry is the flag. A key appended since yesterday is new
 * and gets a blank slot, and nothing here can turn a working key into a
 * refused one.
 *
 * UNLESS THE LIST GOT SHORTER, in which case nothing carries at all. This is
 * the same rule the shrink branch of rollPool has, for the same reason: the
 * only way to shrink is to replace the list, and after that no index means
 * what it did. It is reachable from here and not only from a resize, because
 * KeyStore.drop writes keys.bin immediately while the ledger flush can still
 * be sitting in a four-second timer when Stop-Process -Force arrives. Launch
 * the next day with seventeen keys and a twenty-key ledger and carrying by
 * position would mark the old keys 4, 5 and 6 as refused - three working
 * projects retired, by the mechanism meant to retire dead ones. Starting
 * clean costs one 401 per genuinely dead key, once.
 */
function nextDay(pool: PoolDay, day: string, keys: number): PoolDay {
  const fresh = emptyPool(day, keys)
  if (keys < pool.spend.length) return fresh
  return {
    ...fresh,
    spend: fresh.spend.map((blank, index) =>
      isRejected(pool.spend[index]) ? { ...blank, rejected: true } : blank
    )
  }
}

function withSpend(pool: PoolDay, index: number, next: KeySpend): PoolDay {
  if (index < 0 || index >= pool.spend.length) return pool
  const spend = pool.spend.slice()
  spend[index] = next
  return { ...pool, spend }
}

/** One request, about to be sent on this key for this model. */
export function spendOn(pool: PoolDay, index: number, model: string, now = 0): PoolDay {
  const prev = pool.spend[index]
  if (!prev) return pool
  const key = model || 'unknown'
  return withSpend(pool, index, {
    ...prev,
    models: { ...prev.models, [key]: (prev.models[key] ?? 0) + 1 },
    lastAt: now || prev.lastAt
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

/**
 * Sets a key aside until someone does something about it.
 *
 * No `until`, on purpose. The provider has said this key does not work, and
 * the pool has no way to find out that it does again except by asking -
 * which `/key <provider> check` does for nothing.
 */
export function rejectOn(pool: PoolDay, index: number): PoolDay {
  const prev = pool.spend[index]
  if (!prev || prev.rejected === true) return pool
  return withSpend(pool, index, { ...prev, rejected: true })
}

/**
 * Takes it back: this key just authenticated.
 *
 * The way out of `rejected`, and the reason a sticky flag is safe to have.
 * A 401 is not always permanent - billing that has not propagated, a project
 * suspended and restored - so there has to be a path back that does not
 * involve the user retyping twenty keys. It also clears the legacy timed
 * form, so a key refused by an older build is properly revived rather than
 * flagged again the moment its rest is read.
 */
export function reviveOn(pool: PoolDay, index: number): PoolDay {
  const prev = pool.spend[index]
  if (!prev) return pool
  if (prev.rejected !== true && prev.why !== REJECTED) return pool
  const { rejected: _was, ...rest } = prev
  return withSpend(pool, index, {
    ...rest,
    restUntil: prev.why === REJECTED ? 0 : prev.restUntil,
    why: prev.why === REJECTED ? '' : prev.why
  })
}

/**
 * Has the provider refused this key?
 *
 * Reads the legacy form too - a 24-hour rest whose reason was `rejected` -
 * because ledgers written before the flag existed are on disk right now,
 * with three of them in exactly that state. Whether that rest has expired
 * is not consulted: it expiring is the bug.
 */
export function isRejected(spend: KeySpend | undefined): boolean {
  if (!spend) return false
  return spend.rejected === true || spend.why === REJECTED
}

/** How many keys the provider has refused. */
export function rejectedCount(pool: PoolDay): number {
  let dead = 0
  for (const spend of pool.spend) if (isRejected(spend)) dead++
  return dead
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
  /* Before the clock, because this one is not a matter of waiting. */
  if (isRejected(spend)) return false
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
    /* A refused key never "comes back", and offering its rest as the answer
       is how "the soonest is back in 2h" came to mean "never". */
    if (isRejected(spend)) continue
    const mine = Math.max(spend.restUntil, spend.outOf[model || 'unknown'] ?? 0)
    if (mine > now) soonest = Math.min(soonest, mine)
  }
  return soonest === Infinity ? 0 : soonest - now
}

export function requestsOn(pool: PoolDay, index: number, model: string): number {
  return pool.spend[index]?.models[model || 'unknown'] ?? 0
}

/** Everything this key has served today, whichever model it was for. */
export function requestsTotalOn(pool: PoolDay, index: number): number {
  const models = pool.spend[index]?.models ?? {}
  let total = 0
  for (const count of Object.values(models)) total += count
  return total
}

/**
 * Which key should serve the next request.
 *
 * Round-robin from a counter was the old answer, and it had a hole big enough
 * to lose three projects through: THE COUNTER DID NOT SURVIVE A RESTART. It
 * lives in memory, starts at zero, and `npm run restart` is Stop-Process
 * -Force - so every launch began the rotation at key one again. A short
 * session is a handful of requests, which means key one served the first of
 * them every single time, key two the second, and keys twelve to twenty saw
 * traffic only in sessions long enough to wrap around.
 *
 * Then Google restricted three projects for heavy free-tier use, and the
 * three were Wumpy1, Wumpy2 and Wumpy3. The first three in the list.
 *
 * So the choice is made from the LEDGER, which is written to disk, instead of
 * from a counter that forgets. Fewest requests on this model wins, because
 * that is the allowance being spent; ties go to the key that has served least
 * in total, because that is the project being noticed; then to the one used
 * longest ago, which spreads the five-a-minute limit across time as well as
 * across keys; and last to the cursor, so a cold pool with nothing to choose
 * between still walks rather than sticking.
 *
 * Pure, and takes `now` rather than reading a clock, so a day of traffic can
 * be run through it and the spread measured.
 */
export function chooseKey(
  pool: PoolDay,
  model: string,
  now: number,
  cursor = 0,
  /**
   * A key to stay off if any other is ready - the one the worker just used,
   * when self-reflection's mentor wants the other. Still chosen when it is
   * the only one ready: a review on the same key beats no review.
   */
  avoid: number | null = null
): number | null {
  const slots = pool.spend.length
  if (slots <= 0) return null
  const key = model || 'unknown'

  let best: number | null = null
  let bestRank: [number, number, number, number] | null = null

  for (let step = 0; step < slots; step++) {
    /* Walked from the cursor so that the final tie-break is "whichever came
       up next", not "whichever is lowest-numbered" - the bias being fixed. */
    const index = (cursor + step) % slots
    const spend = pool.spend[index]
    if (!isReady(spend, key, now)) continue
    if (index === avoid && slots > 1) continue
    const rank: [number, number, number, number] = [
      spend?.models[key] ?? 0,
      requestsTotalOn(pool, index),
      spend?.lastAt ?? 0,
      step
    ]
    if (!bestRank || less(rank, bestRank)) {
      best = index
      bestRank = rank
    }
  }
  if (best === null && avoid !== null && slots > 1) return chooseKey(pool, model, now, cursor, null)
  return best
}

function less(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
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
  /**
   * Whether `perKeyCap` is per key or the whole account's.
   *
   * Carried so the report can say which it means. "25 per key x 20" and
   * "25 shared across 20 keys" are the same two numbers and opposite
   * answers, and the reader cannot tell them apart from the figures.
   */
  perKeyQuota: boolean
  /** The pool's ceiling: the per-key cap times the number of keys. */
  cap: number
  /** Requests still available today, or null when the cap is unknown. */
  remaining: number | null
  /** 0 to 1 of the pool's day spent, or null when the cap is unknown. */
  usedFraction: number | null
  /** 0 when something is usable now. */
  nextFreeMs: number
  /** When the quota day turns over, which is when everything comes back. */
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
  resetAt: number,
  /**
   * Whether each key carries its own allowance, which only Google's do.
   *
   * Passed in rather than looked up, so this file stays free of imports and
   * every case can be driven from a check. See `Provider.quotaPerKey` for
   * why it is false everywhere else: an NVIDIA key is a credential against
   * an account and the ceiling belongs to the account, so five of them are
   * five ways in to one allowance rather than five allowances.
   *
   * Defaults true, which is what every caller meant before this existed and
   * what the Google-only history of this file assumed throughout.
   */
  perKeyQuota = true
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
    /* From the flag, not from a rest that is still running: the refusal used
       to disappear from this report the moment its 24 hours were up, while
       the key behind it was as dead as ever. */
    const dead = isRejected(spend)
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
      /* 0 for a refusal: there is no moment at which it comes back. */
      untilMs: dead ? 0 : out ? (spend.outOf[key] ?? 0) : held ? spend.restUntil : 0,
      why: dead ? REJECTED : out ? 'daily quota' : held ? spend.why : ''
    })
  })

  /*
   * The ceiling counts only the keys that could serve today, so a dead key
   * lowers the ceiling rather than silently inflating what is remaining.
   *
   * On a shared allowance there is nothing to multiply: the cap IS the
   * ceiling however many keys reach it, and a dead key costs a way in
   * rather than a slice of the budget. Guarded on there being a live key at
   * all, so a pool of nothing but refused keys still reports no ceiling
   * rather than a full one.
   */
  const live = pool.spend.length - rejected
  const ceiling = perKeyQuota ? cap * live : live > 0 ? cap : 0
  /*
   * And what is left of it, which has to be counted the same way or the two
   * numbers disagree. Per key it is the sum of each live key's remainder,
   * accumulated above. Shared, every key has been drinking from the one pot,
   * so it is the cap less what the whole pool has drawn - summing per key
   * would report five times the truth on five keys.
   */
  if (!perKeyQuota) left = ceiling ? Math.max(0, cap - requests) : 0
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
    perKeyQuota,
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
 * The Pacific calendar day, which is the latest day any of this could roll on.
 *
 * Not the local day. The usage file rolled over at local midnight, which from
 * here is eight hours before Google's quota resets: a late-night session saw
 * its totals clear and the meter read 0% while every key was still spent. The
 * date is the one thing in this file that has to come from a real timezone
 * database rather than from arithmetic.
 *
 * STILL PACIFIC AFTER THE MOVE OFF GOOGLE, and not by inertia. NVIDIA names
 * no daily meter in a refusal and publishes no reset time, so there is no
 * second clock to switch to - and of the two candidates this is the safe one.
 * Pacific midnight is the later of the two from here, so the counters are
 * cleared late rather than early. Clearing late over-reports what is spent;
 * clearing early reports a fresh day while every key is still out, which is
 * the exact failure this function was written for. If a provider is ever
 * observed resetting on its own clock, that evidence belongs here.
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
