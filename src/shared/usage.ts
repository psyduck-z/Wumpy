/**
 * What has been spent today, and how much of it there was to spend.
 *
 * This exists because the free tiers turned out to be the binding constraint
 * and they are invisible until you hit them. A day's allowance on
 * gemini-3.8-flash was exhausted in a single session of testing, and the first
 * sign of it was a 429 asking us to come back in eighteen hours. Nothing in
 * the app could have told you that was coming.
 *
 * Counted per day and per model, because that is how the providers count.
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
   * Requests made before the model first said it was out, today.
   *
   * The published caps for these disagreed with each other and with reality -
   * one source had gemini-3.8-flash at 1500 requests a day and another at 20 -
   * so the only figure worth showing is the one this machine observed. When a
   * model reports an exhausted quota, the count at that moment is the cap, as
   * far as anyone here can tell.
   */
  exhaustedAt?: number
}

/** One day's worth, keyed by model. */
export interface DayUsage {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
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
    exhaustedAt: prev.exhaustedAt ?? (event.exhausted ? prev.requests : undefined)
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
  requestsPerMinute: number
  /** How this number was arrived at, shown so it can be disbelieved. */
  note: string
}

export const ALLOWANCES: Record<string, Allowance> = {
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

export function summarise(day: DayUsage): UsageLine[] {
  return Object.values(day.models)
    .map((u) => {
      const billed = u.promptTokens + u.completionTokens + u.thinkingTokens - u.cachedTokens
      const allowance = ALLOWANCES[u.model]
      let usedFraction: number | null = null

      // What this machine saw beats what anyone published. If the model has
      // already said it is out today, the count at that moment is the cap.
      const cap = u.exhaustedAt ?? allowance?.requestsPerDay ?? 0
      if (cap || allowance?.tokensPerDay) {
        const byRequests = cap ? u.requests / cap : 0
        const byTokens = allowance?.tokensPerDay ? billed / allowance.tokensPerDay : 0
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
        note:
          u.exhaustedAt !== undefined
            ? `ran out after ${u.exhaustedAt} requests today — measured here`
            : (allowance?.note ?? (u.via === 'local' ? 'no limit — runs on this PC' : ''))
      }
    })
    .sort((a, b) => b.requests - a.requests)
}

/** The local date, which is the day the providers reset on from here. */
export function todayKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
