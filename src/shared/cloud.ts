/**
 * Talking to a hosted model, and the four surprises that cost a day to find.
 *
 * Wumpy is local first and stays that way: Ollama is the default, the offline
 * path, and what runs when no key exists. This module is what a tier uses when
 * the user has deliberately pointed it at a hosted model instead.
 *
 * Everything here is pure so the checks can drive it without a network or a
 * key. The transport lives in src/main/cloud.ts.
 *
 * Both providers speak the OpenAI chat-completions shape, which is why one
 * adapter covers them. They do not speak it the same way, and the differences
 * are not in the documentation - each of the quirks below was measured against
 * the live API, and three of the four fail silently.
 */

export type ProviderId = 'google' | 'groq'

export interface Provider {
  id: ProviderId
  label: string
  base: string
  /** Where the user gets a key, shown when one is missing. */
  keyUrl: string
  /**
   * Google keeps only the LAST system message and silently drops every earlier
   * one. Not a 400, not a warning - they simply never reach the model.
   *
   * Measured: system A then system B bills exactly what B alone bills and the
   * model obeys B; reversed, it obeys A. Sending Wumpy's real shape - the
   * 905-token preamble, the worked examples, then the 65-token facts block -
   * billed 205 prompt tokens instead of 1162 and scored 0/6 at proposing a
   * write block, for the excellent reason that the model had never been told
   * the write block exists.
   *
   * So the merge is unconditional, not a retry after a refusal, because the
   * refusal never comes.
   */
  foldSystem: boolean
  /**
   * Smallest stable prefix that caches, or 0 where caching is free of charge
   * and of rate limit.
   *
   * Measured on gemini-3.5-flash, identical prefix sent twice: 1495 tokens
   * cached nothing, 2775 cached nothing, 7495 cached 4076. Caching is real and
   * is reported, but it works in blocks of about 4096 and a prefix shorter
   * than one block caches nothing at all. Wumpy's preamble is ~1080 tokens, a
   * quarter of the way to the first block, so on Google it is paid in full
   * every turn and no amount of reordering changes that.
   *
   * Groq is the opposite: caching is automatic on the gpt-oss models, costs
   * nothing, and cached tokens do not count against the rate limit either.
   */
  cacheBlockTokens: number
  /** Gap to leave between requests to stay under the per-minute ceiling. */
  minGapMs: number
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  google: {
    id: 'google',
    label: 'Google AI Studio',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    foldSystem: true,
    cacheBlockTokens: 4096,
    // 10 requests a minute on the free tier, so 6s plus a margin.
    minGapMs: 7000
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    foldSystem: false,
    cacheBlockTokens: 0,
    // 30 requests a minute on the free tier.
    minGapMs: 2100
  }
}

/* ------------------------------------------------------------ which is which */

/**
 * The hosted models a tier may be pointed at.
 *
 * Deliberately a short list of ones that have been measured or are the obvious
 * flagship, rather than everything the endpoints will accept. A model that is
 * not here can still be typed in by hand; this is what the picker offers.
 */
export interface CloudModel {
  id: string
  provider: ProviderId
  label: string
  /** What it is for, in the voice of the tier blurbs. */
  blurb: string
}

export const CLOUD_MODELS: CloudModel[] = [
  {
    id: 'gemini-3.5-flash',
    provider: 'google',
    label: 'Gemini 3.5 Flash',
    blurb: 'Free, fast, and writes code that compiles. The one to start with.'
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'google',
    label: 'Gemini 3.8 Flash',
    // Measured the hard way: roughly 25 requests and the day is over. Google
    // answered the next one with retryDelay 65304s, which is eighteen hours.
    blurb: 'Newer, but the free tier allows only ~25 requests a day.'
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    label: 'Gemini 3.1 Flash Lite',
    blurb: 'Smaller and cheaper, for quick lookups.'
  },
  {
    id: 'openai/gpt-oss-120b',
    provider: 'groq',
    label: 'GPT-OSS 120B',
    blurb: 'Very fast. Prompt caching is free and does not count against limits.'
  },
  {
    id: 'openai/gpt-oss-20b',
    provider: 'groq',
    label: 'GPT-OSS 20B',
    blurb: 'Faster and lighter on the token budget.'
  }
]

/**
 * Which provider serves a model, or null when it is a local Ollama name.
 *
 * Decided by the catalogue first and then by shape, so a model typed in by hand
 * still routes correctly. An Ollama model is `name:tag` with no slash before
 * the colon, which is what separates `qwen2.5-coder:14b` from
 * `openai/gpt-oss-120b`.
 */
export function providerFor(model: string): ProviderId | null {
  const name = (model ?? '').trim()
  if (!name) return null

  const known = CLOUD_MODELS.find((m) => m.id === name)
  if (known) return known.provider

  if (name.startsWith('gemini-') || name.startsWith('models/gemini-')) return 'google'
  if (name.startsWith('openai/') || name.startsWith('groq/') || name.startsWith('moonshotai/')) {
    return 'groq'
  }
  return null
}

export function isCloudModel(model: string): boolean {
  return providerFor(model) !== null
}

/* --------------------------------------------------------------- the folding */

export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Collapses every system message into one at the front.
 *
 * Order is preserved, because the preamble has to precede the facts that refer
 * to it. Non-system messages keep their own order and position relative to each
 * other; only the system parts move.
 *
 * This is lossy in one respect worth naming: a system message placed after some
 * conversation was presumably meant to be read in that position, and here it is
 * hoisted to the front. That is still better than the alternative on Google,
 * which is for it to be deleted without telling anyone.
 */
export function foldSystemMessages(messages: WireMessage[]): WireMessage[] {
  const systems = messages.filter((m) => m.role === 'system').map((m) => m.content.trim())
  const rest = messages.filter((m) => m.role !== 'system')
  if (systems.length <= 1) return messages.slice()
  return [{ role: 'system', content: systems.filter(Boolean).join('\n\n') }, ...rest]
}

/** Applies whatever reshaping a provider needs before the request goes out. */
export function wireMessagesFor(provider: ProviderId, messages: WireMessage[]): WireMessage[] {
  return PROVIDERS[provider].foldSystem ? foldSystemMessages(messages) : messages.slice()
}

/* ------------------------------------------------------------- the accounting */

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface TokenCount {
  prompt: number
  cached: number
  completion: number
  /** Reasoning the model did and charged for without reporting as either. */
  thinking: number
  /** What the budget is actually spent against. */
  billed: number
}

/**
 * What a call cost, including the part neither field admits to.
 *
 * Thinking tokens appear in neither prompt_tokens nor completion_tokens.
 * Measured on gemini-3.5-flash: a reply of "Ok" came back as 3 prompt and 1
 * completion with total_tokens 78 - the other 74 were reasoning, invisible and
 * billed. On the real tasks it was 487 a call against 335 of visible output,
 * about a quarter of the bill. Any estimate built on prompt + completion
 * understates by that much.
 */
export function countTokens(usage: Usage | null | undefined): TokenCount {
  const prompt = usage?.prompt_tokens ?? 0
  const completion = usage?.completion_tokens ?? 0
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
  const total = usage?.total_tokens ?? prompt + completion
  const thinking = Math.max(0, total - prompt - completion)
  return { prompt, cached, completion, thinking, billed: Math.max(0, total - cached) }
}

/* ----------------------------------------------------------- the two kinds of 429 */

export type LimitKind =
  /** Too fast. Wait the stated moment and carry on. */
  | 'throttle'
  /** Out for the day. Waiting is not a strategy. */
  | 'exhausted'
  /** The model is busy, which is the provider's problem and usually brief. */
  | 'busy'
  | 'other'

export interface LimitVerdict {
  kind: LimitKind
  /** How long to wait, or 0 when waiting is pointless. */
  waitMs: number
  /** Said to the user, so it names the model and what to do. */
  message: string
}

/**
 * Anything longer than this is a cap dressed up as a retry.
 *
 * gemini-3.8-flash answered an exhausted day with retryDelay 65304s - eighteen
 * hours - using the same 429 it uses for going too fast. Honouring that
 * literally is how the bench came to sit and sleep until tomorrow.
 */
export const GIVE_UP_AFTER_MS = 120_000

/**
 * Past this, the delay is describing a day, not a minute.
 *
 * There were two thresholds here and one was wrong. Treating everything over
 * two minutes as an exhausted day was too eager: gemini-3.5-flash was told it
 * "has used up its quota for today — it frees up in about 18h" and answered
 * normally forty minutes later. A daily cap does not refill in forty minutes,
 * so that verdict was simply false, and the cost of being wrong that way is
 * Wumpy refusing a model that would have worked.
 *
 * So the long delays are split. Four hours or more is a day being over, which
 * is what an exhausted model actually reports (65304s, or 18 hours). Anything
 * between two minutes and that is a limit which will clear, but not soon
 * enough to sit and wait for - worth saying so, and worth falling back to the
 * local model, but not worth claiming the day is gone.
 */
export const EXHAUSTED_AFTER_MS = 4 * 3_600_000

export function classifyLimit(status: number, body: string, model: string): LimitVerdict {
  if (status !== 429 && status !== 503) {
    return { kind: 'other', waitMs: 0, message: '' }
  }

  const asked = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body ?? '')
  const askedMs = asked ? Math.round(Number(asked[1]) * 1000) + 500 : 0

  if (status === 503) {
    return {
      kind: 'busy',
      waitMs: Math.min(GIVE_UP_AFTER_MS, askedMs || 8000),
      message: `${model} is busy right now.`
    }
  }

  if (askedMs >= EXHAUSTED_AFTER_MS) {
    const hours = Math.round(askedMs / 3_600_000)
    return {
      kind: 'exhausted',
      waitMs: 0,
      message: `${model} has used up its free quota for today — it frees up in about ${hours}h.`
    }
  }

  if (askedMs > GIVE_UP_AFTER_MS) {
    return {
      kind: 'throttle',
      waitMs: 0,
      message: `${model} is rate limited for the moment. Try again shortly.`
    }
  }

  return {
    kind: 'throttle',
    waitMs: askedMs || 20_000,
    message: `${model} is rate limited; waiting a moment.`
  }
}

/* --------------------------------------------------------------- the key itself */

/**
 * Whether something looks like a key for this provider, before it is stored.
 *
 * The point is catching a paste that went wrong - a truncated key, a whole URL,
 * the word "Bearer" left on the front - rather than validating it, which only
 * the provider can do. Google issues both the old AIza form and the newer AQ.
 * one, so neither prefix can be required.
 */
export function looksLikeKey(provider: ProviderId, raw: string): { ok: boolean; why: string } {
  const key = (raw ?? '').trim()
  if (!key) return { ok: false, why: 'No key was given.' }
  if (/\s/.test(key)) return { ok: false, why: 'That has a space in it — paste the key alone.' }
  if (/^bearer/i.test(key)) return { ok: false, why: 'Leave off the word "Bearer".' }
  if (/^https?:/i.test(key)) return { ok: false, why: 'That is a URL, not a key.' }
  if (key.length < 20) return { ok: false, why: 'That looks too short to be a whole key.' }
  if (key.length > 400) return { ok: false, why: 'That looks too long to be a key.' }
  if (provider === 'groq' && !key.startsWith('gsk_')) {
    return { ok: false, why: 'A Groq key starts with gsk_.' }
  }
  return { ok: true, why: '' }
}

/* ------------------------------------------------------------- the thinking */

/**
 * Headroom added to the output cap when reasoning is left on.
 *
 * Reasoning is spent out of max_tokens before a single visible word is
 * produced, so a cap sized for the answer truncates the answer to nothing.
 * Measured on gemini-3.5-flash: asking for one sentence with max_tokens 200
 * spent 188 on thinking, emitted 8 tokens of prose and stopped with
 * finish_reason "length" - "A tray application is a computer program that".
 *
 * Wumpy's own tiers ask for 384 to 1500, and the four real write-a-file tasks
 * averaged 487 thinking tokens. So the allowance is sized above that, and a
 * tier's num_predict keeps meaning what it says: room for the answer.
 */
export const THINKING_ALLOWANCE = 1024

/**
 * How a tier's thinking flag reaches the provider.
 *
 * The same shape as the Ollama client's rule and for the same reason, only
 * inverted. There, `think: false` made the model reason anyway and dump the
 * reasoning into the answer, so the field is only ever sent as true. Here the
 * default is to reason, and switching it off is both possible and worth doing:
 * measured on gemini-3.5-flash, one sentence asked for with max_tokens 200 cost
 * 188 thinking tokens and came back truncated mid-word, and the same question
 * with reasoning off cost 31 and came back whole.
 *
 * The two providers do not share a vocabulary, which is why this is not a
 * constant. Google accepts 'none' and means it. Groq's gpt-oss takes only
 * 'low', 'medium' and 'high' - there is no 'none', and sending one would be a
 * 400 on every turn. So Groq's thinking-off is 'low', the least it will do.
 *
 * Returns null when the field should be omitted entirely, which is how a tier
 * that genuinely wants reasoning gets the provider's own default.
 */
export function reasoningEffortFor(provider: ProviderId, thinking: boolean): 'none' | 'low' | null {
  if (thinking) return null
  return provider === 'google' ? 'none' : 'low'
}

/** The output cap to send, given the tier's and whether reasoning is on. */
export function maxTokensFor(numPredict: number, thinking: boolean): number {
  const asked = numPredict > 0 ? numPredict : 1024
  return thinking ? asked + THINKING_ALLOWANCE : asked
}

/* --------------------------------------------------------------- the key itself */

/** Never log or display a key in full, including in an error. */
export function maskKey(raw: string): string {
  const key = (raw ?? '').trim()
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
