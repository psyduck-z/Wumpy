import type { ChatMessage } from '@shared/types'
import type { ProviderId, WireMessage } from '@shared/cloud'
import { KeyRotation, nextPacificMidnight } from '@shared/rotation'
import type { PoolDay, PoolView } from '@shared/pool'
import {
  PROVIDERS,
  classifyLimit,
  countTokens,
  maxTokensFor,
  providerFor,
  reasoningEffortFor,
  thinkingKwargsFor,
  wireMessagesFor,
  wireMessage,
  seesMedia
} from '@shared/cloud'
import type { ChatOptions, StreamFailure, StreamHandlers, StreamStats } from './stream'
import type { KeyStore } from './keys'
import { tokensPerSecond } from '@shared/speed'

/**
 * The hosted half of the model layer.
 *
 * Deliberately the same shape as OllamaClient - chat(), complete(), abort() and
 * the same StreamHandlers - so index.ts picks a client and otherwise does not
 * care. Everything above this point (permission cards, approval modes, the
 * unattended-run cap, the write-block parsing) is unchanged and unaware.
 *
 * What differs from Ollama is not the interface but the failure modes, and they
 * are the reason this file is longer than the fetch it wraps:
 *
 *   - the response is SSE, not newline JSON
 *   - a 429 can mean "slow down" or "come back tomorrow", and they look alike
 *   - Google deletes system messages without saying so
 *   - reasoning is billed but reported in neither token field
 *   - there is no keep_alive, no num_ctx, no warming; latency is a round trip
 */

interface Delta {
  choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string }
}

/** Per-provider pacing, so two tiers on one key do not race each other. */
const lastRequestAt = new Map<ProviderId, number>()

/**
 * Tokens spent in the last minute, per provider, as a list of stamped
 * amounts. Trimmed on each use rather than on a timer.
 */
const recentTokens = new Map<ProviderId, Array<{ at: number; tokens: number }>>()

function spentInLastMinute(provider: ProviderId): number {
  const cutoff = Date.now() - 60_000
  const kept = (recentTokens.get(provider) ?? []).filter((t) => t.at > cutoff)
  recentTokens.set(provider, kept)
  return kept.reduce((sum, t) => sum + t.tokens, 0)
}

export function recordSpend(provider: ProviderId, tokens: number): void {
  if (tokens <= 0) return
  const list = recentTokens.get(provider) ?? []
  list.push({ at: Date.now(), tokens })
  recentTokens.set(provider, list)
}

/**
 * Waits long enough not to be refused.
 *
 * Two ceilings, and on Groq the second is the one that bites. Its free tier
 * allows 8,000 tokens a minute, and a Wumpy turn is most of three thousand,
 * so three of them fill the minute - pacing on the request gap alone
 * produced a steady stream of 429s, with one 6,578-token call blocking the
 * three that followed it outright.
 *
 * The estimate is deliberately rough. Being a little early costs one 429 and
 * a retry, which already works; being late costs the user a wait they did
 * not need.
 */
async function pace(provider: ProviderId, estimatedTokens = 0): Promise<void> {
  const gap = PROVIDERS[provider].minGapMs
  const wait = (lastRequestAt.get(provider) ?? 0) + gap - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))

  const perMinute = PROVIDERS[provider].tokensPerMinute
  if (perMinute > 0 && estimatedTokens > 0) {
    const list = recentTokens.get(provider) ?? []
    while (spentInLastMinute(provider) + estimatedTokens > perMinute && list.length) {
      // Wait until the oldest spend falls out of the window, plus a moment.
      const oldest = (recentTokens.get(provider) ?? [])[0]
      if (!oldest) break
      const until = oldest.at + 60_000 - Date.now() + 250
      if (until <= 0) break
      await new Promise((r) => setTimeout(r, Math.min(until, 60_000)))
    }
  }

  lastRequestAt.set(provider, Date.now())
}

export class CloudClient {
  private inflight = new Map<string, AbortController>()

  /**
   * The ledger is optional so a test or a script can build a client without
   * a userData folder; when it is there, what the pool has spent survives a
   * restart instead of being re-probed one 429 at a time.
   */
  constructor(
    private readonly keys: KeyStore,
    private readonly ledger?: { get(p: ProviderId): PoolDay | null; save(p: ProviderId, d: PoolDay): void }
  ) {}

  abort(requestId: string): void {
    this.inflight.get(requestId)?.abort()
  }

  abortAll(): void {
    for (const controller of this.inflight.values()) controller.abort()
  }

  /** Whether this model can be used right now, and why not when it cannot. */
  ready(model: string): { ok: boolean; why: string; provider: ProviderId | null } {
    const provider = providerFor(model)
    if (!provider) return { ok: false, why: 'Not a hosted model.', provider: null }
    if (!this.keys.available()) {
      return { ok: false, why: 'This PC cannot store a key securely.', provider }
    }
    if (!this.keys.has(provider)) {
      const p = PROVIDERS[provider]
      return { ok: false, why: `No ${p.label} key yet. Add one with /key.`, provider }
    }
    return { ok: true, why: '', provider }
  }

  /**
   * One rotation per provider, kept for the life of the process and written
   * to disk behind it.
   *
   * It used to be deliberately forgotten on restart, on the grounds that a
   * cooldown is at most a day. That was wrong in the direction that costs
   * quota: a key out until midnight Pacific is still out after a restart, and
   * finding that out again costs a request per key. Wumpy restarts several
   * times an hour while it is being worked on.
   */
  private readonly rotations = new Map<ProviderId, KeyRotation>()

  private rotation(provider: ProviderId): KeyRotation {
    const count = this.keys.count(provider)
    let r = this.rotations.get(provider)
    if (!r) {
      r = new KeyRotation(count, this.ledger?.get(provider) ?? null)
      this.rotations.set(provider, r)
    } else {
      // Picks up a key added or cleared since the last turn.
      r.resize(count)
    }
    return r
  }

  /** Writes the ledger back, debounced by the store. */
  private remember(provider: ProviderId, rotation: KeyRotation): void {
    this.ledger?.save(provider, rotation.snapshot())
  }

  /**
   * The pool as a report can print it: how many keys can answer with this
   * model, what they have spent, and when the rest come back.
   */
  poolFor(model: string, perKeyCap: number): PoolView | null {
    const provider = providerFor(model)
    if (!provider) return null
    return this.rotation(provider).view(model, perKeyCap, nextPacificMidnight())
  }

  private headers(provider: ProviderId, index: number): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.keys.secrets(provider)[index] ?? ''}`
    }
  }

  /**
   * One streamed turn.
   *
   * Resolves when the stream ends or an error has been reported; it does not
   * throw, because the call site treats a model failure as a message rather
   * than an exception - the same contract OllamaClient keeps.
   */
  async chat(
    requestId: string,
    model: string,
    messages: Array<Pick<ChatMessage, 'role' | 'content' | 'images'>>,
    opts: ChatOptions,
    handlers: StreamHandlers
  ): Promise<void> {
    const check = this.ready(model)
    if (!check.ok || !check.provider) {
      handlers.onError(check.why)
      return
    }
    const provider = check.provider

    const controller = new AbortController()
    this.inflight.set(requestId, controller)

    let hitCap = false
    const cap =
      opts.maxTurnMs > 0
        ? setTimeout(() => {
            hitCap = true
            controller.abort()
          }, opts.maxTurnMs)
        : null

    try {
      const wire: WireMessage[] = wireMessagesFor(provider, [
        ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
        ...messages.map((m) => wireMessage(m, seesMedia(model)))
      ])

      const effort = reasoningEffortFor(provider, opts.thinking, model)
      const kwargs = thinkingKwargsFor(provider, opts.thinking)
      const body = {
        model,
        messages: wire,
        stream: true,
        // Without this the stream carries no usage at all, and the token
        // accounting below has nothing to count.
        stream_options: { include_usage: true },
        temperature: opts.options.temperature,
        top_p: opts.options.top_p,
        // Reasoning is spent out of this before any visible word, so a cap
        // sized for the answer alone truncates the answer to nothing.
        max_tokens: maxTokensFor(opts.options.num_predict, opts.thinking, provider),
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(kwargs ? { chat_template_kwargs: kwargs } : {})
      }

      // Timed from here rather than inside drain(), which only begins once the
      // headers are back: measuring from there reported a 9ms turn at 1500
      // tok/s, which is the stream being read, not the model answering.
      const startedAt = Date.now()
      const res = await this.send(provider, model, body, controller.signal, handlers)
      if (!res) return

      await this.drain(res, handlers, startedAt, provider)
    } catch (err) {
      if (hitCap) {
        handlers.onError('That turn was taking too long, so Wumpy stopped it.')
      } else if ((err as Error)?.name === 'AbortError') {
        handlers.onDone({})
      } else {
        const message = describe(err)
        const failure: StreamFailure = /could not reach the provider/i.test(message)
          ? { kind: 'network', elsewhere: true }
          : { kind: 'other', elsewhere: false }
        handlers.onError(message, failure)
      }
    } finally {
      if (cap) clearTimeout(cap)
      this.inflight.delete(requestId)
    }
  }

  /**
   * Sends, waiting out the delays worth waiting out.
   *
   * Returns null when it has already reported the failure, so the caller can
   * simply stop. A throttle is slept through once; an exhausted quota is not,
   * because the provider is asking for eighteen hours and that is not a wait,
   * it is an answer.
   */
  private async send(
    provider: ProviderId,
    model: string,
    body: unknown,
    signal: AbortSignal,
    handlers: StreamHandlers
  ): Promise<Response | null> {
    /**
     * Enough attempts to give every key a turn.
     *
     * Three was right when there was one key and a retry meant waiting.
     * With five, a quota error on one of them is not a reason to wait at
     * all - it is a reason to use the next one - so the ceiling has to be
     * at least the number of keys, plus a couple for ordinary retries.
     */
    const rotation = this.rotation(provider)
    const keyCount = Math.max(1, this.keys.count(provider))
    for (let attempt = 0; attempt < keyCount + 2; attempt++) {
      /* By model, because a key out of one model is the right key for another. */
      const index = rotation.next(Date.now(), model)
      if (index === null) {
        // Every key is resting. Say for how long rather than failing blank.
        const wait = rotation.waitMs(Date.now(), model)
        const until = wait > 0 ? `The soonest frees up in ${friendlyWait(wait)}.` : ''
        handlers.onError(
          `All ${keyCount} ${PROVIDERS[provider].label} keys are out of ${model}. ${until}`.trim(),
          { kind: 'limit', elsewhere: true }
        )
        return null
      }
      await pace(provider)
      const res = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(provider, index),
        body: JSON.stringify(body),
        signal
      })
      /* The request is on the ledger either way; a 200 is quota spent too. */
      this.remember(provider, rotation)
      if (res.ok && res.body) return res

      const detail = await res.text().catch(() => '')

      /**
       * ONE rejected key is not a rejected account.
       *
       * This used to end the turn outright, and with one key that was right -
       * a bad key is bad everywhere, and answering locally would have hidden
       * the thing the user has to go and fix. With ten it is wrong, and
       * measurably so: a 401 appeared partway through a benchmark run and
       * took whole questions down with it while nine working keys sat
       * unused. A key revoked, a project deleted, a quota shut off - any one
       * of those and roughly every tenth thing the user asked would fail with
       * "Google rejected the key" and no way to tell which key was meant.
       *
       * So the key is set aside and the turn carries on. The error only
       * reaches the user when there is nothing left to try, which is the
       * only time it is actually true.
       */
      if (res.status === 401 || res.status === 403) {
        const A_DAY = 24 * 60 * 60 * 1000
        rotation.rest(index, Date.now() + A_DAY, 'rejected')
        console.warn(
          `[wumpy] ${PROVIDERS[provider].label} key ${index + 1}/${keyCount} ` +
            `(${this.keys.hint(provider, index)}) was REJECTED (${res.status}) and ` +
            'is out of rotation for today. Replace it with /key.'
        )
        this.remember(provider, rotation)
        if (rotation.availableCount(Date.now(), model) > 0) continue
        handlers.onError(
          keyCount > 1
            ? `All ${keyCount} ${PROVIDERS[provider].label} keys were rejected. Add a working one with /key.`
            : `${PROVIDERS[provider].label} rejected the key. Add a new one with /key.`,
          {
            kind: 'auth',
            elsewhere: false
          }
        )
        return null
      }

      // The header is the only thing that separates "slow down" from "not on
      // your plan" - both arrive as 429 with nearly the same words.
      const verdict = classifyLimit(
        res.status,
        detail,
        model,
        res.headers.get('x-ratelimit-limit-req-minute')
      )

      /**
       * A rate limit sets THIS key aside and moves to the next one.
       *
       * With one key the only options were to sleep or to give up. With
       * several, a key that is out of quota is simply not the key to use
       * next, and the turn continues immediately on another - which is the
       * entire reason for having them.
       *
       * A DAILY cap is per model as well as per project, so it takes out one
       * model on one key rather than the key itself. Resting the whole key
       * was quota thrown away: with twenty keys and three Gemini models, an
       * afternoon of hitting 3.8-flash's daily cap would retire the entire
       * pool while every key still had its full 3.5-flash allowance. A
       * per-minute throttle does hold the whole key, because it is over in
       * seconds and the limit is shared by the project.
       */
      if (verdict.kind === 'exhausted' || verdict.kind === 'throttle') {
        const daily = /PerDay/i.test(detail) || /per day/i.test(verdict.message)
        /* Before the rest, or it reads as zero on the key that just died. */
        const spentHere = rotation.requests(index, model)
        if (daily) rotation.out(index, model, nextPacificMidnight())
        else rotation.rest(index, Date.now() + Math.max(1000, verdict.waitMs), 'per-minute')
        this.remember(provider, rotation)
        console.log(
          `[wumpy] ${PROVIDERS[provider].label} key ${index + 1}/${keyCount} ` +
            `(${this.keys.hint(provider, index)}) ` +
            (daily
              ? `is out of ${model} for the day after ${spentHere} request(s); ` +
                `${rotation.availableCount(Date.now(), model)} key(s) left on it`
              : 'rested: rate limit')
        )
        if (rotation.availableCount(Date.now(), model) > 0) continue
        if (daily) {
          /* Every key is out of THIS model. Another model may be untouched,
             which is what elsewhere: true tells the caller to try. */
          handlers.onError(
            `All ${keyCount} ${PROVIDERS[provider].label} keys have used up today's ` +
              `free requests for ${model}. It comes back at ${clockFor(nextPacificMidnight())}.`,
            { kind: 'limit', elsewhere: true, spent: true, afterRequests: spentHere }
          )
          return null
        }
      }
      if (verdict.kind === 'exhausted') {
        handlers.onError(verdict.message, { kind: 'limit', elsewhere: true })
        return null
      }
      if ((verdict.kind === 'throttle' || verdict.kind === 'busy') && attempt < 2) {
        await new Promise((r) => setTimeout(r, verdict.waitMs))
        continue
      }
      if (verdict.kind !== 'other') {
        handlers.onError(verdict.message, { kind: 'limit', elsewhere: true })
        return null
      }

      /**
       * A model that cannot generate at all is worth stepping away from.
       *
       * Probed against the live API: gemini-3.5-flash-lite and
       * gemini-flash-lite-latest answer 400 and gemini-2.5-flash answers
       * 404, all three while appearing in the /models listing. Those three
       * are no longer shipped, but a listing that changes under us will
       * produce more, and the right response is to try something else rather
       * than hand the user a status code.
       *
       * A 5xx is the provider having a bad minute, which another model or
       * the local one does not share. Every other 4xx is ours - a malformed
       * request will be malformed again anywhere.
       */
      const unusableModel = res.status === 404 || res.status === 400
      handlers.onError(
        `${PROVIDERS[provider].label} returned ${res.status}${
          detail ? `: ${truncate(stripKey(detail), 300)}` : ''
        }`,
        {
          kind: unusableModel ? 'unusable' : 'other',
          elsewhere: unusableModel || res.status >= 500
        }
      )
      return null
    }
    handlers.onError(`${PROVIDERS[provider].label} kept asking us to wait.`, {
      kind: 'limit',
      elsewhere: true
    })
    return null
  }

  /** Reads the SSE body, forwarding deltas and totalling what it cost. */
  private async drain(
    res: Response,
    handlers: StreamHandlers,
    startedAt: number,
    provider: ProviderId
  ): Promise<void> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stats: StreamStats = {}
    let firstTokenAt = 0
    let completion = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let chunk: Delta
        try {
          chunk = JSON.parse(payload) as Delta
        } catch {
          continue
        }
        if (chunk.error?.message) {
          handlers.onError(stripKey(chunk.error.message))
          return
        }

        if (chunk.usage) {
          const counted = countTokens(chunk.usage)
          recordSpend(provider, counted.billed)
          completion = counted.completion
          stats = {
            ...stats,
            promptTokens: counted.prompt,
            // Reasoning is charged, so it belongs in what the user is shown as
            // the cost of the turn even though they never see the text.
            completionTokens: counted.completion + counted.thinking
          }
        }

        const delta = chunk.choices?.[0]?.delta
        const content = delta?.content
        // Groq reports reasoning on gpt-oss; Google does not expose it at all,
        // which is why its thinking tokens only ever show up in the total.
        const thinking = delta?.reasoning ?? delta?.reasoning_content
        if (content || thinking) {
          if (!firstTokenAt) firstTokenAt = Date.now()
          handlers.onDelta({ content: content ?? undefined, thinking: thinking ?? undefined })
        }
      }
    }

    const elapsed = Date.now() - startedAt
    stats.totalDurationMs = elapsed
    // Measured over the streaming window only. Counting the round trip as slow
    // generation would make a fast model on a slow link look like a slow model.
    if (firstTokenAt && completion) {
      /**
       * No floor on the window, and no rate when it is too short to divide
       * by. The old `max(1, ms)` turned an unmeasurably fast short answer
       * into "8,000 tokens a second". See speed.ts.
       */
      const rate = tokensPerSecond(completion, Date.now() - firstTokenAt)
      if (rate !== null) stats.tokensPerSecond = rate
      stats.loadMs = firstTokenAt - startedAt
    }
    handlers.onDone(stats)
  }

  /**
   * One non-streamed answer, for titles, compaction and transcript polish.
   *
   * Returns null on any failure, because every caller treats these as optional
   * niceties and must carry on without them.
   *
   * These three used to be pinned to a local model whatever the tiers said,
   * and the reason was not speed: compaction sends the whole conversation,
   * which can hold command output and the contents of files, and the free
   * tiers train on what they are sent. That guarantee died with Ollama. It is
   * recorded here rather than quietly dropped, because it is the one real
   * thing the user gave up by removing the local path.
   */
  async complete(
    model: string,
    messages: Array<Pick<ChatMessage, 'role' | 'content' | 'images'>>,
    opts: { numPredict?: number }
  ): Promise<string | null> {
    const check = this.ready(model)
    if (!check.ok || !check.provider) return null
    const provider = check.provider

    try {
      await pace(provider)
      /**
       * Background work rotates as well. Titles are small but frequent, and
       * on a five-requests-a-minute tier a chat title spent out of the same
       * key the user is typing against is a turn they have to wait for.
       * Falls back to the first key when every one is resting, because a
       * title is not worth refusing outright.
       */
      const background = this.rotation(provider)
      const index = background.next(Date.now(), model) ?? 0
      this.remember(provider, background)
      const res = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(provider, index),
        body: JSON.stringify({
          model,
          messages: wireMessagesFor(
            provider,
            messages.map((m) => ({ role: m.role as WireMessage['role'], content: m.content }))
          ),
          stream: false,
          temperature: 0.2,
          max_tokens: opts.numPredict ?? 400
        }),
        signal: AbortSignal.timeout(120_000)
      })
      if (!res.ok) return null
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      return body.choices?.[0]?.message?.content?.trim() ?? null
    } catch {
      return null
    }
  }
}

/**
 * A wait a person can act on.
 *
 * "The soonest frees up in 28800s" was the old line, which is eight hours
 * written in a unit nobody converts in their head.
 */
export function friendlyWait(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** Pacific midnight, said as the time it will be on this clock. */
export function clockFor(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * A provider's error body can quote the request, and the request carried the
 * key in a header - belt and braces, since one has been seen echoed back.
 */
function stripKey(text: string): string {
  return text.replace(/\b(AIza[\w-]{10,}|AQ\.[\w-]{10,}|gsk_[\w-]{10,})/g, '<key>')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return 'Could not reach the provider. Check the connection.'
  }
  return stripKey(message)
}
