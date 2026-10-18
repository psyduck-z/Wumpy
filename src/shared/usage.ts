/**
 * What has been spent today, and how much of it there was to spend.
 *
 * This exists because the free tiers turned out to be the binding constraint
 * and they are invisible until you hit them. A day's allowance on
 * gemini-3.8-flash was exhausted in a single session of testing, and the first
 * sign of it was a 429 asking us to come back in eighteen hours. Nothing in
 * the app could have told you that was coming.
 *
 * Counted per day and per model, because that is how Google counted and it
 * is the shape a person asks in anyway ("how much have I used today"). It is
 * not how every provider counts: NVIDIA names no daily meter when it
 * refuses, so for those models a day is a reporting period rather than an
 * allowance, and the cap stays blank until a key is actually turned away.
 * Local models are counted too - not because anything runs out, but because
 * seeing 14 tok/s against 170 beside each other is the clearest statement of
 * what the two backends are.
 *
 * Pure, so the checks can drive it without a clock or a disk.
 */

export interface ModelUsage {
  model: string
  /** 'local' or a ProviderId. */
  via: string
  requests: number
  promptTokens: number
  completionTokens: number
  /** Reasoning that was billed but reported in neither of the above. */
  thinkingTokens: number
  cachedTokens: number
  /** Milliseconds spent generating, for a tokens-per-second figure. */
  generatingMs: number
  errors: number
  /** Turns refused because a limit had been reached. */
  limited: number
  /**
   * Requests ONE KEY made before this model first said it was out, today.
   *
   * The published caps for these disagreed with each other and with reality -
   * one source had gemini-3.8-flash at 1500 requests a day and another at 20 -
   * so the only figure worth showing is the one this machine observed. When a
   * model reports an exhausted quota, the count at that moment is the cap, as
   * far as anyone here can tell.
   *
   * Per key, and that distinction was a bug for as long as it was not made.
   * This used to be the POOL's request count at the moment one key died, and
   * was then multiplied by the number of keys to get a ceiling - so with
   * twenty keys a measured 25-a-day was recorded as 500 and shown as 10,000,
   * and the meter read 2% on the way into a wall.
   */
  exhaustedAt?: number
}

/** One day's worth, keyed by model. */
export interface DayUsage {
  /** Local calendar date, YYYY-MM-DD: what to call the day when showing it. */
  date: string
  /**
   * The Pacific day these counts belong to, which is the day they reset on.
   *
   * Two dates, because the two questions are different. "What have I used
   * today" is asked in the local calendar; "when does it come back" is
   * answered on the provider's clock, and the only one ever published was
   * Google's midnight in California. Rolling the counters on the local day
   * cleared them eight hours early from here: a session past midnight saw 0%
   * while every key was still spent, which is the exact failure this file
   * was written to prevent. See pacificDayKey for why that clock is kept.
   */
  quotaDay?: string
  models: Record<string, ModelUsage>
}

export function emptyModelUsage(model: string, via: string): ModelUsage {
  return {
    model,
    via,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    generatingMs: 0,
    errors: 0,
    limited: 0
  }
}

export interface UsageEvent {
  model: string
  via: string
  promptTokens?: number
  completionTokens?: number
  thinkingTokens?: number
  cachedTokens?: number
  generatingMs?: number
  error?: boolean
  limited?: boolean
  /** The provider said the day's allowance is gone, not merely to slow down. */
  exhausted?: boolean
  /**
   * What the key that ran out had spent on this model, when that is known.
   *
   * Falls back to the pool's own count, which is right when there is one key
   * and is the only thing an older caller can supply.
   */
  exhaustedAfter?: number
}

/** Folds one turn into a day. Returns a new object; never mutates the input. */
export function record(day: DayUsage, event: UsageEvent): DayUsage {
  const key = `${event.via}:${event.model}`
  const prev = day.models[key] ?? emptyModelUsage(event.model, event.via)
  const next: ModelUsage = {
    ...prev,
    requests: prev.requests + 1,
    promptTokens: prev.promptTokens + (event.promptTokens ?? 0),
    completionTokens: prev.completionTokens + (event.completionTokens ?? 0),
    thinkingTokens: prev.thinkingTokens + (event.thinkingTokens ?? 0),
    cachedTokens: prev.cachedTokens + (event.cachedTokens ?? 0),
    generatingMs: prev.generatingMs + (event.generatingMs ?? 0),
    errors: prev.errors + (event.error ? 1 : 0),
    limited: prev.limited + (event.limited ? 1 : 0),
    // The first one is the honest number. Later refusals are just the same
    // wall being hit again.
    exhaustedAt:
      prev.exhaustedAt ??
      (event.exhausted ? (event.exhaustedAfter ?? prev.requests) : undefined)
  }
  return { ...day, models: { ...day.models, [key]: next } }
}

/* ------------------------------------------------------------ the allowances */

/**
 * Free-tier ceilings, as measured rather than as documented.
 *
 * The published figures for these disagreed with each other and with reality -
 * one source had gemini-3.8-flash at 1500 requests a day and another at 20.
 * The number here is the one that was observed: roughly 25 requests before an
 * 18-hour lockout. Where a limit has not been measured it is left out rather
 * than guessed, because a wrong ceiling shown confidently is worse than none.
 */
export interface Allowance {
  /** Requests a day, or 0 when unknown. */
  requestsPerDay: number
  /** Tokens a day, or 0 when the tier is not counted that way. */
  tokensPerDay: number
  /** Requests a minute, or 0 when unknown. Recorded, not yet enforced. */
  requestsPerMinute: number
  /** How this number was arrived at, shown so it can be disbelieved. */
  note: string
}

/**
 * What a free tier allows, per model, where anyone here knows.
 *
 * GOOGLE PUBLISHED ITS METERS AND NOBODY ELSE HERE DOES, which is why this
 * table looks lopsided. A 429 from Google's free tier names the meters it
 * tripped, and there are four rather than the one "requests a day" everybody
 * quotes:
 *
 *   GenerateRequestsPerMinutePerProjectPerModel-FreeTier
 *   GenerateRequestsPerDayPerProjectPerModel-FreeTier
 *   GenerateContentInputTokensPerModelPerMinute-FreeTier
 *   GenerateContentInputTokensPerModelPerDay-FreeTier
 *
 * Two things in those names decided how Wumpy behaves. They are keyed
 * PerProjectPerModel, so a second key is a second project and multiplies all
 * four - which is why rotation works at all, and why `summarise` multiplies
 * a cap by the number of keys. And the token meters count INPUT tokens: the
 * preamble, the transcript and every screenshot are what spend the day's
 * allowance, while the model's own answer is not metered this way. A long
 * preamble is not only slower and dearer, it is less of the day.
 *
 * NVIDIA SAYS NONE OF THAT. There is no per-day meter named in a refusal, no
 * published figure for these models, and the community numbers disagree with
 * each other - so nothing here claims one. The entries below exist to put
 * that in words where the user can read it, because an empty note next to
 * the model they are actually running looks like a bug rather than like
 * honesty. A zero cap is never multiplied and never drawn as a meter.
 */
export const ALLOWANCES: Record<string, Allowance> = {
  /**
   * Measured 15 Oct 2026: all four meters answer limit: 0 on a fresh key,
   * with retryDelay 8650s, for a two-token request. A ten-rung ladder across
   * rotated keys returned 429 on every rung. Zero does not multiply.
   */
  'gemini-3.1-pro-preview': {
    requestsPerDay: 0,
    tokensPerDay: 0,
    requestsPerMinute: 0,
    note: 'measured — free tier reports limit 0 on all four meters; needs billing'
  },
  'gemini-3.8-flash': {
    requestsPerDay: 25,
    tokensPerDay: 0,
    requestsPerMinute: 10,
    note: 'measured — ~25 requests, then an 18h lockout'
  },
  'gemini-3.5-flash': {
    requestsPerDay: 0,
    tokensPerDay: 0,
    requestsPerMinute: 10,
    note: 'daily cap not yet established; throttles at 10/min'
  },
  'gemini-3.1-flash-lite': {
    requestsPerDay: 0,
    tokensPerDay: 0,
    requestsPerMinute: 10,
    note: 'daily cap not yet established; throttles at 10/min'
  },
  'openai/gpt-oss-120b': {
    requestsPerDay: 1000,
    tokensPerDay: 200_000,
    requestsPerMinute: 30,
    note: 'documented; cached tokens do not count'
  },
  'openai/gpt-oss-20b': {
    requestsPerDay: 1000,
    tokensPerDay: 200_000,
    requestsPerMinute: 30,
    note: 'documented; cached tokens do not count'
  }
}

/**
 * What to say about a model the table has never heard of.
 *
 * Keyed by provider, because the thing worth saying is a property of the
 * tier and not of the model: NVIDIA's catalogue moves faster than this file
 * does, and a row per model id would be stale by the time a name changed.
 *
 * It exists because the move off Google left `/usage` printing a blank note
 * beside `deepseek-ai/deepseek-v4.1-flash` - the default model, the one in
 * use on nearly every turn - while four Gemini rows that cannot be reached
 * any more still had their measurements. The blank was correct and it read
 * as broken.
 *
 * The caps stay at zero on purpose. Community sources put NVIDIA's free tier
 * at about 40 requests a minute and disagree about whether the credit
 * allowance still exists; none of it has been seen from this machine, and
 * this file's whole rule is that a measurement beats a published figure and
 * a published figure beats nothing. So the number stays absent and the
 * sentence says why - which is what `exhaustedAt` is for: the first time a
 * key is refused, the count at that moment becomes the cap.
 */
export const PROVIDER_ALLOWANCES: Record<string, Allowance> = {
  nvidia: {
    requestsPerDay: 0,
    tokensPerDay: 0,
    requestsPerMinute: 0,
    note: 'no daily figure published — the first key to run out sets the cap'
  }
}

/**
 * The allowance for a model, falling back to whatever its provider allows.
 *
 * Model first, because a measurement on one model is not a fact about its
 * neighbours.
 */
export function allowanceFor(model: string, via = ''): Allowance | undefined {
  return ALLOWANCES[model] ?? (via ? PROVIDER_ALLOWANCES[via] : undefined)
}

/* ------------------------------------------------------------ what to show */

export interface UsageLine {
  model: string
  via: string
  requests: number
  /** Billed: everything except what the cache absorbed. */
  tokens: number
  thinking: number
  tokensPerSecond: number
  errors: number
  limited: number
  /** Fraction of the day's allowance used, or null when there is no known cap. */
  usedFraction: number | null
  note: string
  /** Requests made before this model first said it was out today, if it did. */
  exhaustedAt?: number
}

/**
 * The day's usage, against a ceiling that knows how many keys there are.
 *
 * A free-tier cap is per PROJECT, and each key is its own project - which is
 * the entire reason there are twenty of them. Measuring against one key's
 * allowance while rotating across twenty said the day was spent when a
 * twentieth of it was, and the user had been collecting keys specifically
 * because they were worried about running out: "update my usage based on
 * the amount of API keys i have".
 *
 * Rested keys are not subtracted. A key that returned 429 today is out, so
 * the true remaining allowance is lower than this - but the rotation already
 * refuses to use it, and a meter that jumped backwards as keys dropped out
 * would be harder to read than one that is honestly the optimistic bound.
 */
export function summarise(day: DayUsage, keys = 1): UsageLine[] {
  /* At least one: zero keys is not a zero allowance, it is no provider. */
  const projects = Math.max(1, Math.floor(keys))
  return Object.values(day.models)
    .map((u) => {
      const billed = u.promptTokens + u.completionTokens + u.thinkingTokens - u.cachedTokens
      const allowance = allowanceFor(u.model, u.via)
      let usedFraction: number | null = null

      // What this machine saw beats what anyone published. If the model has
      // already said it is out today, the count at that moment is the cap.
      /*
       * exhaustedAt is one key running out, not the pool. It is still the
       * best evidence of what ONE project allows, so it is multiplied like
       * the published figure rather than treated as the total.
       */
      const perKey = u.exhaustedAt ?? allowance?.requestsPerDay ?? 0
      const cap = perKey * (u.via === 'local' ? 1 : projects)
      const tokenCap = (allowance?.tokensPerDay ?? 0) * (u.via === 'local' ? 1 : projects)
      if (cap || tokenCap) {
        const byRequests = cap ? u.requests / cap : 0
        const byTokens = tokenCap ? billed / tokenCap : 0
        const worst = Math.max(byRequests, byTokens)
        if (worst > 0) usedFraction = Math.min(1, worst)
      }
      return {
        model: u.model,
        via: u.via,
        requests: u.requests,
        tokens: Math.max(0, billed),
        thinking: u.thinkingTokens,
        tokensPerSecond: u.generatingMs > 0 ? (u.completionTokens / u.generatingMs) * 1000 : 0,
        errors: u.errors,
        limited: u.limited,
        usedFraction,
        exhaustedAt: u.exhaustedAt,
        note: noteFor(u, allowance, projects)
      }
    })
    .sort((a, b) => b.requests - a.requests)
}

/** Says what the ceiling is and that it was multiplied, so it can be checked. */
function noteFor(
  u: { exhaustedAt?: number; via: string },
  allowance: Allowance | undefined,
  projects: number
): string {
  const across = projects > 1 ? ` x ${projects} keys` : ''
  if (u.exhaustedAt !== undefined) {
    return `one key ran out after ${u.exhaustedAt} requests — measured here${across}`
  }
  if (u.via === 'local') return 'no limit — runs on this PC'
  if (!allowance) return ''
  return projects > 1 && allowance.requestsPerDay
    ? `${allowance.note} (x ${projects} keys = ${allowance.requestsPerDay * projects}/day)`
    : allowance.note
}

/**
 * What ONE key is allowed on this model in a day, as best anyone here knows.
 *
 * The measurement beats the table, because the table is other people's
 * guesses: one source had gemini-3.8-flash at 1500 a day and another at 20,
 * and this machine saw about 25. Zero means nothing credible is known, and a
 * zero must be shown as "cap unknown" rather than as a full meter.
 *
 * `via` used to default to 'google', from when that was the only provider
 * with keys to rotate. It defaults to nothing now: a caller that does not
 * know the provider must not be handed Google's row, which is both the wrong
 * number and a number for a model the app can no longer reach.
 */
export function perKeyCapFor(day: DayUsage, model: string, via = ''): number {
  const measured = day.models[`${via}:${model}`]?.exhaustedAt
  if (measured !== undefined) return measured
  return allowanceFor(model, via)?.requestsPerDay ?? 0
}

/** The local date, which is the day the providers reset on from here. */
export function todayKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
