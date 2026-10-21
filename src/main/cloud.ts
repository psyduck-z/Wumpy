import { net } from 'electron'
import type { ChatMessage } from '@shared/types'
import type { ProviderId, WireMessage } from '@shared/cloud'
import { KeyRotation, nextPacificMidnight } from '@shared/rotation'
import type { PoolDay, PoolView } from '@shared/pool'
import {
  CLOUD_MODELS,
  PROVIDER_IDS,
  PROVIDERS,
  budgetsFor,
  classifyLimit,
  countTokens,
  keysAreSeparate,
  maxTokensFor,
  provedBlind,
  rememberBlind,
  providerFor,
  reasoningEffortFor,
  thinkingKwargsFor,
  wireMessagesFor,
  wireMessage,
  seesMedia
} from '@shared/cloud'
import type { CloudModel } from '@shared/cloud'
import {
  MAX_RUNS,
  PROBE_TIMEOUT_MS,
  TOO_SLOW_TO_SUGGEST_MS,
  combineRuns,
  verdictFor
} from '@shared/probe'
import type { ProbeResult } from '@shared/probe'
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
  choices?: Array<{
    delta?: { content?: string; reasoning?: string; reasoning_content?: string }
    /**
     * Why generation stopped: 'stop' when the model finished, 'length' when
     * it ran into the output cap, 'content_filter' when it was blocked.
     *
     * Nobody read this until now, so an answer that hit the cap ended the
     * turn exactly like one that finished: dots gone, runtime printed, half
     * a sentence on screen looking complete.
     */
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string }
}

/**
 * When each KEY was last used, so two requests do not race each other.
 *
 * Per key, because the limit this models is per key. "10 requests a minute
 * on the free tier" is ten per project, and every key in the pool is its own
 * project — so one queue for all twenty of them spent the whole gap on every
 * request however many keys were idle.
 *
 * It is not a small wait. Google's gap is seven seconds, and a turn is
 * rarely one request: a command's output is another, a compaction is
 * another, the chat title is another. A three-step sequence paid twenty-one
 * seconds of sitting still, and the panel has nothing to show while it does.
 *
 * The rotation hands out the least-used key each time, so consecutive
 * requests land on different keys and the gap is one nobody reaches.
 */
const lastRequestAt = new Map<string, number>()

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
async function pace(
  provider: ProviderId,
  key: number,
  estimatedTokens = 0,
  /** Each key its own ceiling? Passed in: see CloudClient.separate. */
  separate = false
): Promise<void> {
  const gap = PROVIDERS[provider].minGapMs
  /**
   * ONE QUEUE PER ALLOWANCE, WHICH IS NOT ALWAYS ONE QUEUE PER KEY.
   *
   * The gap exists to stay under a requests-per-minute ceiling, so it has
   * to be divided the same way that ceiling is. Google's is per project and
   * a key is a project, so per key was right and the distinction never came
   * up while Google was the only provider with more than one.
   *
   * It is wrong the moment a second NVIDIA key is added. That ceiling
   * belongs to the account: two keys each waiting 1,700ms independently put
   * about seventy requests a minute through a limit of forty, so the second
   * key would make 429s MORE likely rather than less - the exact opposite
   * of what someone adds a key for.
   *
   * Shared allowance, shared queue. The cost is that a second key buys
   * resilience rather than speed, which is the truth about what it buys.
   */
  const slot = separate ? `${provider}:${key}` : provider
  const wait = (lastRequestAt.get(slot) ?? 0) + gap - Date.now()
  if (wait > 0) {
    console.log(`[wumpy] holding key ${key + 1} for ${wait}ms before asking ${provider}`)
    await new Promise((r) => setTimeout(r, wait))
  }

  /* The token ceiling is per provider, which is now the same rule the gap
     above follows rather than an exception to it: both are account-level
     ceilings, and the only provider this one applies to is a one-key
     account anyway. */
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

  lastRequestAt.set(slot, Date.now())
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
    private readonly ledger?: { get(p: ProviderId): PoolDay | null; save(p: ProviderId, d: PoolDay): void },
    /**
     * Whether this provider's keys are on separate accounts, which only the
     * user knows. A function rather than a value because they can change it
     * with `/key <provider> accounts` while the app is running, and reading
     * it once at construction would keep the old answer until a restart.
     *
     * Optional like the ledger, so a script can build a client without a
     * settings file; absent means the cautious answer.
     */
    private readonly accountMode?: (p: ProviderId) => 'shared' | 'separate' | undefined
  ) {}

  /** Does each key here carry its own ceiling? See `keysAreSeparate`. */
  private separate(provider: ProviderId): boolean {
    return keysAreSeparate(provider, this.accountMode?.(provider))
  }

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
    /*
     * A keyless provider is ready as soon as it is named.
     *
     * Ollama is the user's own daemon on localhost, authorised by whoever
     * signed in there. There is no key to store, so the two checks below -
     * both of which read "you have not set this up yet" - would be
     * permanently true and the model permanently unreachable.
     */
    if (PROVIDERS[provider].keyless) return { ok: true, why: '', provider }
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
    /* One slot for a keyless provider: there is nothing to rotate, and a
       rotation of size zero hands back null, which reads downstream as
       "every key is resting" for a provider that has none. */
    const count = PROVIDERS[provider].keyless ? 1 : this.keys.count(provider)
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
   * Which keys are still alive, asked without spending any allowance.
   *
   * A models listing authenticates the key and is not a generation, so
   * twenty of them cost nothing from a tier counted in requests per day.
   * That matters because the alternative - finding out by trying to answer
   * with it - is what was happening: measured here, three of twenty keys
   * reply 401 "the bound service account is deleted or disabled", so roughly
   * one turn in seven was spent discovering a key that will never work
   * again, and the meter was measuring the day against 500 requests when
   * 425 existed.
   *
   * Dead keys are rested for the day as they are found, so the rotation
   * stops reaching for them immediately rather than at the next 401.
   *
   * Returns POSITIONS ONLY. No key, no masked form: this result goes to the
   * renderer, and the rule on that boundary has no exceptions.
   */
  async checkKeys(
    provider: ProviderId
  ): Promise<Array<{ number: number; ok: boolean; status: number; why: string }>> {
    const all = this.keys.secrets(provider)
    const rotation = this.rotation(provider)
    const out: Array<{ number: number; ok: boolean; status: number; why: string }> = []

    for (const [index, key] of all.entries()) {
      try {
        const res = await fetch(`${PROVIDERS[provider].base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000)
        })
        if (res.ok) {
          /* The way back. A refusal is kept until something disproves it,
             and this listing is the only thing that ever does - which is
             why it has to clear the flag and not merely report green. */
          rotation.revive(index)
          out.push({ number: index + 1, ok: true, status: res.status, why: '' })
          continue
        }
        const body = stripKey(await res.text().catch(() => ''))
        const why = /"message":\s*"([^"]{0,160})/.exec(body)?.[1] ?? `HTTP ${res.status}`
        /* A 429 means the key works and is busy, which is not a dead key -
           and it is proof of life, so it clears a refusal too. */
        if (res.status === 429) rotation.revive(index)
        else rotation.reject(index)
        out.push({ number: index + 1, ok: res.status === 429, status: res.status, why })
      } catch (err) {
        /* A network failure says nothing about the key, so it is not rested. */
        out.push({ number: index + 1, ok: false, status: 0, why: describe(err) })
      }
    }
    this.remember(provider, rotation)
    return out
  }

  /**
   * Ask every model in the catalogue whether it is alive.
   *
   * ONE REAL REQUEST PER MODEL, which is the only kind of answer worth
   * having: a /models listing proves a key authenticates and says nothing
   * about whether an id still exists or whether the body Wumpy builds for
   * that provider is one it accepts. `checkKeys` is the cheap question and
   * this is the expensive one, so this is never run on its own - only when
   * the user asks for it.
   *
   * Deliberately small and deliberately boring: four words in, sixteen
   * tokens out, thinking off. What is being measured is whether a reply
   * arrives with words in it, and paying for four hundred tokens to find
   * that out would make the check cost more than the thing it checks.
   *
   * Non-streamed, unlike `chat()` and unlike scripts/verify-models.mjs. The
   * failures this is for - a withdrawn id, a refused key, a spent day, an
   * empty answer - all show up identically either way, and the streaming
   * path is 300 lines of frame assembly that would have to be duplicated
   * here to find out nothing more. The script keeps the streaming check for
   * when stream_options itself is the suspect.
   *
   * Models whose provider has no key are reported without being asked, so
   * the check never spends anything discovering what the key store already
   * knows.
   */
  async probeModels(
    runs = 1,
    onEach?: (done: number, total: number) => void,
    /**
     * The instructions a real turn carries, so the times mean something.
     *
     * Passed in rather than built here: the preamble depends on settings
     * and on what the turn is about, and this class has neither. The
     * caller sends the same shape the next question would.
     */
    preamble = 'Answer in one word.'
  ): Promise<ProbeResult[]> {
    const times = Math.min(MAX_RUNS, Math.max(1, Math.floor(runs)))
    const total = CLOUD_MODELS.length * times
    let done = 0

    /*
     * Asked before anything is spent, because the answer is free.
     *
     * With no connection every model fails the same way, and finding
     * that out one model at a time means waiting for twenty DNS lookups
     * to time out before saying the one thing that was knowable at the
     * start. Electron keeps the answer to hand.
     *
     * Not a guarantee the provider is up - online says the machine has a
     * route, not that NVIDIA is answering - so a per-model `offline`
     * still exists for the case this misses. This is the cheap pass.
     */
    if (!net.isOnline()) {
      return CLOUD_MODELS.map((entry) => ({
        model: entry.id,
        label: entry.label,
        provider: entry.provider,
        state: 'offline' as const,
        ms: 0,
        said: '',
        why: '',
        runs: 0,
        times: []
      }))
    }

    /*
     * ONE LANE PER INDEPENDENT BUDGET, which is usually one.
     *
     * This was strictly serial, and the reasoning was right at the time:
     * every entry but one is the same NVIDIA account, so firing them off
     * together would collect 429s - and a 429 is indistinguishable from
     * a model that is genuinely out. A check must not be the reason the
     * thing it checks looks broken.
     *
     * What changed is that there can now be more than one account. A key
     * on a second account has its own per-minute ceiling, so two
     * requests on two accounts are not competing at all, and `pace`
     * already keys its queue per account rather than per key. The lanes
     * are exactly the number of separate budgets - which is 1 unless the
     * user has said `/key <provider> accounts separate`, so the cautious
     * behaviour is still what happens by default.
     *
     * Each lane is pinned to its own key index rather than drawing from
     * the rotation, or two lanes would take the same key and serialise
     * against each other through the pacer while looking parallel.
     */
    const lanes = Math.max(
      1,
      ...PROVIDER_IDS.map((id) =>
        budgetsFor(id, this.keys.count(id), this.accountMode?.(id))
      )
    )

    const queue = CLOUD_MODELS.slice()
    const results = new Map<string, ProbeResult>()

    const lane = async (keyIndex: number): Promise<void> => {
      for (;;) {
        const entry = queue.shift()
        if (!entry) return
        results.set(
          entry.id,
          await this.probeEntry(entry, times, preamble, keyIndex, (n = 1) => {
            done += n
            onEach?.(done, total)
          })
        )
      }
    }

    await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)))
    /* Catalogue order, not the order they happened to finish in: the
       report is read as a list of models, and a list that reshuffles
       itself by whichever answered first is harder to compare. */
    return CLOUD_MODELS.map((m) => results.get(m.id)).filter((r): r is ProbeResult => Boolean(r))
  }

  /** One catalogue entry, run `times` times on one key. */
  private async probeEntry(
    entry: CloudModel,
    times: number,
    preamble: string,
    keyIndex: number,
    tick: (n?: number) => void
  ): Promise<ProbeResult> {
    const check = this.ready(entry.id)
    if (!check.ok || !check.provider) {
      /* Counted as all of its runs at once: nothing was asked, and a
         progress bar that stalled on the keyless entries would be
         describing work that is not happening. */
      tick(times)
      return {
        model: entry.id,
        label: entry.label,
        provider: check.provider ?? '',
        state: 'nokey',
        ms: 0,
        said: '',
        why: check.why,
        runs: 0,
        times: []
      }
    }

    /*
     * Each model's runs together rather than a whole sweep repeated.
     *
     * Back to back is the harder test and the fairer one: a provider
     * that answers and then 503s does it within seconds, which is how
     * nemotron-3-ultra was caught, and a second sweep minutes later
     * would be asking a different question about a different moment.
     */
    const attempts: ProbeResult[] = []
    for (let run = 0; run < times; run++) {
      const got = await this.probeOne(entry, check.provider, preamble, keyIndex)
      attempts.push(got)
      tick()
      /*
       * STOP WHEN A SECOND ASK CANNOT CHANGE THE ANSWER.
       *
       * Two runs exist to catch a model that works only sometimes,
       * which is a question worth asking about a CANDIDATE. It is not
       * worth asking about a model that just took two minutes, or one
       * the endpoint does not have: the first is already past the floor
       * under the recommendation and the second does not exist.
       *
       * Measured over the ten in the catalogue: two runs each is 9.3
       * minutes and 83% of it is deepseek at 112s and glm-5.3 timing out
       * at 120, asked twice apiece. The other eight together are a
       * minute and a half. The report still shows what happened; it just
       * does not pay to confirm it.
       */
      const settled =
        got.state === 'missing' || got.state === 'refused' || got.state === 'offline'
      if (settled || got.ms > TOO_SLOW_TO_SUGGEST_MS) {
        /* The runs it did not use are still progress, or the bar stops
           short of the end on every slow model. */
        tick(times - run - 1)
        break
      }
    }
    return combineRuns(attempts)
  }

  /** One model, with its own timeout so a hung provider cannot stall the rest. */
  private async probeOne(
    entry: CloudModel,
    provider: ProviderId,
    preamble: string,
    /**
     * The key this lane owns, rather than whatever the rotation hands
     * out next. Two lanes drawing from the rotation would sooner or
     * later take the same key and serialise against each other through
     * the pacer, which looks parallel and is not. Clamped, because a
     * provider may have fewer keys than there are lanes.
     */
    lane = 0
  ): Promise<ProbeResult> {
    const base: Omit<ProbeResult, 'state' | 'ms' | 'said' | 'why'> = {
      model: entry.id,
      label: entry.label,
      provider
    }
    const rotation = this.rotation(provider)
    /* Whatever key the next real turn would use, so the probe tests the
       thing being tested. Falls back to the first when all are resting:
       the resulting 429 is itself the answer, and an honest one. */
    const count = Math.max(1, this.keys.count(provider))
    const index = this.separate(provider) ? lane % count : (rotation.next(Date.now(), entry.id) ?? 0)
    this.remember(provider, rotation)
    await pace(provider, index, 0, this.separate(provider))

    const started = Date.now()
    try {
      const res = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(provider, index),
        body: JSON.stringify({
          model: entry.id,
          /*
           * THE REAL PREAMBLE, NOT FOUR WORDS.
           *
           * This asked "Say: ready" under a one-line system message, and
           * the times it produced were not the times anyone experiences.
           * Reported from use: two models the check called 1.6s and 6.7s
           * both took about fifty seconds on a real question - and they
           * would, because a turn carries eight thousand tokens of
           * instructions and this carried eleven. What the old probe
           * measured was the provider's queue, with the whole of prompt
           * processing left out.
           *
           * Which made the recommendation worse than useless: it ranked
           * models on a cost they never pay. The same mistake the
           * catalogue made with medianMs, arrived at from the other side.
           *
           * So the probe sends what a turn sends. It costs more per model
           * - the preamble is the expensive part - and that is the price
           * of the number meaning something.
           */
          messages: wireMessagesFor(provider, [
            { role: 'system', content: preamble },
            { role: 'user', content: 'Say: ready' }
          ]),
          stream: false,
          temperature: 0,
          max_tokens: 16,
          /* Off, and this matters more than the size. A reasoning model
             given sixteen tokens spends all of them thinking and returns
             empty content - which this check would then report as a model
             that answered nothing. Measured on the VL model doing exactly
             that for the borrowed eye. */
          ...(() => {
            const kwargs = thinkingKwargsFor(provider, false)
            return kwargs ? { chat_template_kwargs: kwargs } : {}
          })()
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      const ms = Date.now() - started

      if (!res.ok) {
        const body = stripKey(await res.text().catch(() => ''))
        const why = /"message":\s*"([^"]{0,160})/.exec(body)?.[1] ?? `HTTP ${res.status}`
        return { ...base, state: verdictFor(res.status, '', ms), ms, said: '', why: truncate(why, 120) }
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const said = (payload.choices?.[0]?.message?.content ?? '').trim().replace(/\s+/g, ' ')
      return {
        ...base,
        state: verdictFor(res.status, said, ms),
        ms,
        said: truncate(said, 40),
        why: ''
      }
    } catch (err) {
      const ms = Date.now() - started
      const timedOut = (err as Error)?.name === 'TimeoutError'
      /* A connection that never opened says nothing about the model, so
         it gets its own verdict rather than being filed as a failure of
         the thing it never reached. */
      const message = err instanceof Error ? err.message : String(err)
      const unreachable = /fetch failed|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/i.test(message)
      return {
        ...base,
        state: timedOut ? 'timeout' : unreachable ? 'offline' : 'error',
        ms,
        said: '',
        why: timedOut || unreachable ? '' : describe(err)
      }
    }
  }

  /**
   * The pool as a report can print it: how many keys can answer with this
   * model, what they have spent, and when the rest come back.
   */
  poolFor(model: string, perKeyCap: number): PoolView | null {
    const provider = providerFor(model)
    if (!provider) return null
    return this.rotation(provider).view(
      model,
      perKeyCap,
      nextPacificMidnight(),
      Date.now(),
      /* Whether these keys are separate allowances or separate doors into
         one. Google's always are; anyone else's are when the user has said
         so. See keysAreSeparate. */
      this.separate(provider)
    )
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
        /*
         * "Out of quota" and "refused" are the same blank wall from in here
         * and opposite problems to the user: one ends by itself and the
         * other never does. Telling someone to wait for a midnight that
         * will not help them is the worse of the two mistakes.
         */
        const dead = rotation.rejectedCount(Date.now())
        handlers.onError(
          dead >= keyCount
            ? `All ${keyCount} ${PROVIDERS[provider].label} key(s) have been refused by the ` +
              'provider — waiting will not fix those. Replace them with /key, or run ' +
              `\`/key ${provider} check\` to retry them for free.`
            : dead > 0
              ? `No ${PROVIDERS[provider].label} key can answer: ${dead} refused, ` +
                `the other ${keyCount - dead} out of ${model}. ${until}`.trim()
              : `All ${keyCount} ${PROVIDERS[provider].label} keys are out of ${model}. ${until}`.trim(),
          { kind: 'limit', elsewhere: true }
        )
        return null
      }
      await pace(provider, index, 0, this.separate(provider))
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
        /*
         * Out of the rotation until something disproves it, not until
         * tomorrow. Tomorrow was the bug: this was a 24-hour rest, and the
         * day roll cleared it even sooner, so every morning the three
         * restricted projects came back as the LEAST-used keys in the pool
         * and were therefore the first ones tried.
         */
        rotation.reject(index)
        console.warn(
          `[wumpy] ${PROVIDERS[provider].label} key ${index + 1}/${keyCount} ` +
            `(${this.keys.hint(provider, index)}) was REJECTED (${res.status}) and ` +
            `is out of rotation. Drop it with /key ${provider} drop ${index + 1}, ` +
            `or /key ${provider} check to retry it for free.`
        )
        this.remember(provider, rotation)
        if (rotation.availableCount(Date.now(), model) > 0) continue
        handlers.onError(
          keyCount > 1
            ? `All ${keyCount} ${PROVIDERS[provider].label} keys were refused. ` +
              `Add a working one with /key, or run \`/key ${provider} check\` — ` +
              'it re-asks the provider and costs nothing from today.'
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
       *
       * ALL OF THAT IS TRUE OF A PER-PROJECT KEY AND FALSE OF A SHARED ONE.
       * Where the ceiling belongs to the account - NVIDIA, Groq, Mistral -
       * "move to the next key" moves to a key behind the same wall, and
       * spends a request proving it. So the refusal is applied to every key
       * instead, which is both the truth and one request cheaper. See
       * `restAll`/`outAll` and `Provider.quotaPerKey`.
       */
      if (verdict.kind === 'exhausted' || verdict.kind === 'throttle') {
        const daily = /PerDay/i.test(detail) || /per day/i.test(verdict.message)
        const shared = !this.separate(provider)
        /* Before the rest, or it reads as zero on the key that just died. */
        const spentHere = rotation.requests(index, model)
        const until = Date.now() + Math.max(1000, verdict.waitMs)
        if (daily && shared) rotation.outAll(model, nextPacificMidnight())
        else if (daily) rotation.out(index, model, nextPacificMidnight())
        else if (shared) rotation.restAll(until, 'per-minute (account)')
        else rotation.rest(index, until, 'per-minute')
        this.remember(provider, rotation)
        console.log(
          `[wumpy] ${PROVIDERS[provider].label} key ${index + 1}/${keyCount} ` +
            `(${this.keys.hint(provider, index)}) ` +
            (daily
              ? `is out of ${model} for the day after ${spentHere} request(s); ` +
                `${rotation.availableCount(Date.now(), model)} key(s) left on it`
              : shared
                ? `rested with the whole pool: the ${PROVIDERS[provider].label} ` +
                  'rate limit is the account\'s'
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
      /**
       * A REFUSED PICTURE IS NOT A REFUSED MODEL. Retry without it.
       *
       * Every model is born sighted now (see seesMedia), which costs one
       * 400 for each model that turns out not to be - and this is where
       * that bill is paid instead of being passed to the user. The
       * endpoint says so plainly when it happens: nemotron-3-super
       * answers "Received multimodal data but multimodal processing is
       * not ..." and glm-5.3 "Invalid request". Both refuse the MESSAGE,
       * not the model, and the same question without the image works.
       *
       * So the model is written down as blind, the images are dropped,
       * and the turn carries on. Once per model for the life of the
       * process: the next attempt never attaches anything.
       *
       * Guarded on there being images to drop, or an ordinary 400 would
       * retry itself unchanged and fail the same way twice.
       */
      const refusedPicture =
        res.status === 400 &&
        /multimodal|image|vision|not support|invalid request/i.test(detail ?? '')
      const carryingPicture = (
        (body as { messages?: Array<{ content?: unknown }> }).messages ?? []
      ).some((m) => Array.isArray(m.content))
      if (refusedPicture && carryingPicture && !provedBlind(model)) {
        /* `provedBlind` is both the record and the loop guard: once it is
           true the next 400 falls through to the ordinary handling
           instead of retrying for ever. */
        rememberBlind(model)
        /*
         * Stripped from the body in place, because this loop is inside
         * `send` and the body was built by the caller: a bare `continue`
         * would post the identical request and be refused identically.
         * The text parts stay - the question survives, only the picture
         * goes - and a message left with one text part collapses back to
         * a plain string, which is the shape every provider prefers.
         */
        const dropped = body as { messages?: Array<{ content?: unknown }> }
        for (const m of dropped.messages ?? []) {
          if (!Array.isArray(m.content)) continue
          const text = (m.content as Array<{ type?: string; text?: string }>).filter(
            (part) => part?.type === 'text'
          )
          m.content = text.length === 1 ? (text[0].text ?? '') : text
        }
        console.log(
          `[wumpy] ${model} refused the picture; it is text-only. ` +
            'Asking again without it, and never attaching one again.'
        )
        continue
      }

      const unusableModel = res.status === 404 || res.status === 400
      /*
       * The provider's sentence, not its error object.
       *
       * This printed the raw body, so a gateway blip reached the user as
       * `returned 500: {"message":"Failed to generate completions","type":
       * "Internal Server Error","code":500}` - three restatements of the
       * status code and one actual fact, in JSON, under a red banner. The
       * message field is the only part worth reading; the rest is already
       * in the status. Falls back to the whole body when there is no
       * message to find, because an unparsed error beats a silent one.
       */
      const said = /"message":\s*"([^"]{0,200})/.exec(stripKey(detail ?? ''))?.[1]
      handlers.onError(
        `${PROVIDERS[provider].label} returned ${res.status}` +
          (said
            ? `: ${said}`
            : detail
              ? `: ${truncate(stripKey(detail), 300)}`
              : '') +
          /* A 5xx has already been retried twice by the time it gets here,
             so saying "try again" alone would be advice the app has taken
             on the user's behalf and lost. */
          (res.status >= 500 && !unusableModel
            ? '. That is their gateway rather than your key or your question — ' +
              'it was retried twice already, so give it a moment.'
            : ''),
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
    /** The last finish_reason seen, or '' if the stream never gave one. */
    let finish = ''

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

        const why = chunk.choices?.[0]?.finish_reason
        if (why) finish = why

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

    /**
     * An answer that stopped early is not a finished answer.
     *
     * Only the reasons that say so outright. A stream that ends without one
     * at all is left alone: it is the ordinary shape on some providers, and
     * a warning on every turn is a warning nobody reads.
     */
    if (finish === 'length' || finish === 'content_filter') stats.cutOff = finish

    /**
     * One line per turn, because "it is a bit slow" had nowhere to be
     * answered from. The log had the hotkey timed to the millisecond and
     * not one word about how long an answer took.
     */
    console.log(
      `[wumpy] turn done: ${stats.loadMs ?? '?'}ms to first token, ${elapsed}ms total, ` +
        `${stats.promptTokens ?? '?'} in / ${stats.completionTokens ?? '?'} out` +
        `${stats.tokensPerSecond ? ` at ${stats.tokensPerSecond.toFixed(1)}/s` : ''}` +
        `, finish=${finish || 'none'}`
    )
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
    /**
     * `pictures` is off by default and has to be asked for.
     *
     * The three original callers - titles, compaction, transcript polish -
     * send the whole conversation, and a conversation can hold screenshots.
     * Sending those up to summarise a chat would be paying for vision to
     * name a tab. The one caller that wants them is the borrowed eye, where
     * the picture IS the question.
     */
    opts: { numPredict?: number; pictures?: boolean }
  ): Promise<string | null> {
    const check = this.ready(model)
    if (!check.ok || !check.provider) return null
    const provider = check.provider

    try {
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
      /* Chosen before the wait, not after: pacing a key nobody had picked
         yet is what made a compaction block the answer it was making room
         for, which is the one moment the user is already waiting. */
      await pace(provider, index, 0, this.separate(provider))
      const res = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(provider, index),
        body: JSON.stringify({
          model,
          messages: wireMessagesFor(
            provider,
            messages.map((m) =>
              opts.pictures
                ? wireMessage(m, seesMedia(model))
                : { role: m.role as WireMessage['role'], content: m.content }
            )
          ),
          stream: false,
          temperature: 0.2,
          max_tokens: opts.numPredict ?? 400,
          /*
           * Thinking off, where the provider has a switch for it.
           *
           * chat() has always sent this and complete() never did, which was
           * invisible while the callers were titles and compaction - a
           * reasoning model thinks for a sentence and still produces one.
           * It is not invisible for the borrowed eye: measured on the VL
           * model, a 64-token ceiling came back with EMPTY content and the
           * whole budget spent in reasoning_content. A description that
           * silently comes back blank reads downstream as "no eye".
           */
          ...(() => {
            const kwargs = thinkingKwargsFor(provider, false)
            return kwargs ? { chat_template_kwargs: kwargs } : {}
          })()
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
