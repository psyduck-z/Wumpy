import type { ChatMessage } from '@shared/types'
import type { ProviderId, WireMessage } from '@shared/cloud'
import {
  PROVIDERS,
  classifyLimit,
  countTokens,
  maxTokensFor,
  providerFor,
  reasoningEffortFor,
  thinkingKwargsFor,
  wireMessagesFor
} from '@shared/cloud'
import type { ChatOptions, StreamFailure, StreamHandlers, StreamStats } from './ollama'
import type { KeyStore } from './keys'

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

  constructor(private readonly keys: KeyStore) {}

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

  private headers(provider: ProviderId): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.keys.secret(provider) ?? ''}`
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
    messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
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
        ...messages.map((m) => ({ role: m.role as WireMessage['role'], content: m.content }))
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
    for (let attempt = 0; attempt < 3; attempt++) {
      await pace(provider)
      const res = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(provider),
        body: JSON.stringify(body),
        signal
      })
      if (res.ok && res.body) return res

      const detail = await res.text().catch(() => '')

      if (res.status === 401 || res.status === 403) {
        // Explicitly not answerable elsewhere. A bad key is bad everywhere,
        // and quietly answering locally would hide the one thing the user
        // actually has to go and fix.
        handlers.onError(
          `${PROVIDERS[provider].label} rejected the key. Add a new one with /key.`,
          {
            kind: 'auth',
            elsewhere: false
          }
        )
        return null
      }

      const verdict = classifyLimit(res.status, detail, model)
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
      const generating = Math.max(1, Date.now() - firstTokenAt)
      stats.tokensPerSecond = (completion / generating) * 1000
      stats.loadMs = firstTokenAt - startedAt
    }
    handlers.onDone(stats)
  }

  /**
   * One non-streamed answer, for titles, compaction and transcript polish.
   *
   * Returns null on any failure, exactly as the Ollama one does, because every
   * caller treats those as optional niceties and must carry on without them.
   */
  async complete(
    model: string,
    messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
    // keepAlive and numCtx are Ollama's and are accepted only so the two
    // clients stay drop-in for one another at the call site. There is nothing
    // resident to keep alive and the context window is the provider's business.
    opts: { keepAlive?: string; numPredict?: number; numCtx?: number }
  ): Promise<string | null> {
    const check = this.ready(model)
    if (!check.ok || !check.provider) return null
    const provider = check.provider

    try {
      await pace(provider)
      const res = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(provider),
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
