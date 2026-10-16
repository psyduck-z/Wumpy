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

export type ProviderId = 'google' | 'groq' | 'mistral' | 'nvidia' | 'ollama'

/**
 * Every provider, once, so adding one is a single edit.
 *
 * This list was written out by hand in six places - two in the key store, two
 * in the IPC guards, one in the command parser, one in the renderer's types -
 * and adding the fourth provider meant finding all six. Any that was missed
 * would not fail to compile: it would accept the key, encrypt it, and then
 * drop it on the next read as an unrecognised provider name.
 */
import { foldAttachments, type Attached } from './attach'

export const PROVIDER_IDS = ['google', 'groq', 'mistral', 'nvidia', 'ollama'] as const

/** Whether a string off the wire or out of a settings file names a provider. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export interface Provider {
  id: ProviderId
  label: string
  base: string
  /** Where the user gets a key, shown when one is missing. */
  keyUrl: string
  /**
   * No key, because the endpoint is the user's own machine.
   *
   * Ollama listens on localhost and authorises by whoever signed in at the
   * daemon, so there is nothing for /key to hold and nothing to rotate. Every
   * other gate in here assumes a missing key means "not set up yet", which
   * for this one would be permanently true.
   */
  keyless?: boolean
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
  /**
   * Tokens allowed per minute, or 0 where the ceiling is counted in requests.
   *
   * Groq's free tier is 8,000 a minute and that is the limit that actually
   * bites: at Wumpy's preamble size a single turn is most of three thousand,
   * so three of them fill the minute. Pacing on requests alone produced a
   * steady stream of 429s - measured, a 6,578-token call blocked the next
   * three outright. Google counts requests instead, so this is 0 there and
   * minGapMs does the work.
   */
  tokensPerMinute: number
  /**
   * True where reasoning cannot be switched off, so the output cap must leave
   * room for it whether the tier asked for thinking or not.
   *
   * Google, Groq and Mistral all take a field that means "do less of this"
   * and honour it. NVIDIA's endpoint does not: the top-level reasoning_effort
   * is reported ignored rather than refused, the real switch is
   * chat_template_kwargs.enable_thinking, and on GLM-5.3 and GLM-5.3 Flash
   * even that is reported not to work - live requests with
   * enable_thinking: false still came back with reasoning_content.
   *
   * A tier that asks for 384 tokens on a model that reasons anyway gets
   * nothing: that exact failure was measured on Google before reasoning_effort
   * was found, 188 tokens of thinking and eight of truncated prose. So on a
   * provider that will not stop, the allowance is unconditional.
   */
  alwaysReasons: boolean
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
    minGapMs: 7000,
    tokensPerMinute: 0,
    alwaysReasons: false
  },
  /**
   * The free tier that lasts, on the models it actually covers.
   *
   * A billion tokens a month against Groq's 200,000 a day, and measured here
   * at 10,337 questions a day on Codestral - which is not a number anyone
   * types. But the plan is per model, and it does not include the premier
   * line: Medium, Small, Large and Magistral all answer 429 with
   * x-ratelimit-limit-req-minute of 0, and mistral-large-* is not in /models
   * on a free key at all. What it does cover is Codestral at 125 requests a
   * minute and the Ministral sizes, and both of the ones benchmarked scored
   * 8/8 on block, compile, on-task and path - the same as the best of Google
   * and Groq.
   *
   * The cost is the same one Google's free tier carries: the Experiment tier
   * trains on what it is sent. So it gets the same treatment - fine for a
   * script in Downloads, and the reason background work stays local.
   */
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    base: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    foldSystem: false,
    /**
     * The only provider where prefix caching has ever actually appeared.
     *
     * Groq's documentation promised it and it never showed: eight calls on a
     * shared 2,118-token prefix reported 0 cached, and a deliberate 6,578-
     * token repeat came back with prompt_tokens_details absent entirely.
     * Google needs a whole 4,096-token block and Wumpy's preamble is half of
     * one. Here, on the same benchmark and the same preamble, five of eight
     * calls came back 2101in/2048cached, and the run averaged 1,024 cached
     * tokens a call - billed 1,277 against 2,301 uncached, a 45% saving on
     * input for doing nothing.
     *
     * 2048 is what was observed rather than a documented block size; it could
     * be two blocks of 1024. Either way it is below the preamble, which is
     * what makes it the first provider where keeping the prefix byte-identical
     * is worth anything. It was intermittent - three of eight missed - so it
     * is a discount, not a budget.
     */
    cacheBlockTokens: 2048,
    // One request a second, with a little margin.
    minGapMs: 1200,
    // 500k a minute, which at Wumpy's size is 170 calls - not the binding limit.
    tokensPerMinute: 500_000,
    alwaysReasons: false
  },
  /**
   * A hundred models on one key, including the best-scoring free one there is.
   *
   * NVIDIA hosts other people's open weights and lets a free developer account
   * call them: GLM-5.3 at 44.8 on the Artificial Analysis index, Kimi K3 at
   * 43.6, DeepSeek V4 Pro, and NVIDIA's own Nemotron 3 Ultra. For comparison
   * the gpt-oss-120b Wumpy has been using on Groq is 24 on the same index, and
   * Sonnet 5.5 is 56. Nothing else free is in that band.
   *
   * Two things to know before relying on it. The limit is about 40 requests a
   * minute with no published daily token ceiling, which sounds generous, but
   * NVIDIA's own staff have described it inconsistently - one reply says the
   * old 1,000-credit grant is gone and the trial is not time-limited, while
   * users in 2026 still report running out of credits. So it is treated here
   * as development capacity, not a tier to depend on. And reasoning cannot be
   * reliably switched off, which is what alwaysReasons is for.
   *
   * Unmeasured. Committed because the shape is known; the four write-a-file
   * tasks have never been run against it.
   */
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    base: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    foldSystem: false,
    // Observed, same as Mistral: 2051in/2048cached on the benchmark preamble.
    // Which makes two of four providers where the prefix is worth keeping
    // identical, after a session of assuming none were.
    cacheBlockTokens: 2048,
    // 40 requests a minute, so 1.5s, plus a margin.
    minGapMs: 1700,
    tokensPerMinute: 0,
    alwaysReasons: true
  },
  /**
   * The user's own Ollama, which is how a cloud model on their account is
   * reached without a key of Wumpy's.
   *
   * Wumpy used to have an OllamaClient and lost it when it went cloud-only;
   * this is the same daemon through its OpenAI-compatible endpoint, so it
   * costs a provider row rather than a second client. What it serves is
   * whatever the user has: a `-cloud` name runs on Ollama's servers against
   * their account, a plain tag runs on this laptop.
   *
   * Measured on gemma4:31b-cloud at Wumpy's real 14,212-token preamble: 967ms
   * median of three, and 14,304 of 14,322 input tokens came back cached -
   * 99.9%, the highest of any provider tested. No rate-limit header of any
   * kind, so the ceiling is Ollama's account policy and is found by hitting
   * it.
   */
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    base: 'http://127.0.0.1:11434/v1',
    keyUrl: 'https://ollama.com/settings/keys',
    keyless: true,
    foldSystem: false,
    /* Observed cached=14304 on a 14322-token prefix, so the block is small
       enough not to matter. Zero means "do not plan around a block size". */
    cacheBlockTokens: 0,
    /* A local daemon with no published limit. The pacing that exists for
       hosted free tiers is not what is binding here. */
    minGapMs: 0,
    tokensPerMinute: 0,
    alwaysReasons: false
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    foldSystem: false,
    /**
     * Zero because none was observed, not because none is documented.
     *
     * Groq's docs say prompt caching is automatic on the gpt-oss models,
     * costs nothing and is exempt from the rate limit. Measured, it does not
     * appear: eight calls sharing a 2,118-token prefix reported 0 cached,
     * and a deliberate back-to-back test with a 6,578-token identical prefix
     * came back with prompt_tokens_details absent entirely. Until it is seen
     * working it cannot be planned around.
     */
    cacheBlockTokens: 0,
    // 30 requests a minute, but 8,000 tokens a minute is what bites first.
    minGapMs: 2100,
    tokensPerMinute: 8000,
    alwaysReasons: false
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
  /**
   * Writes ```powershell where Wumpy asks for ```wumpy-run.
   *
   * Gemini does this on the first call, before any quota is touched, and it
   * is not a small thing: the fence tag is how a command becomes a button,
   * so a perfectly good command renders as dead text and the model scores
   * zero on a ladder it is easily clever enough for.
   *
   * Flagged per model rather than fixed for everyone, because promoting a
   * plain powershell fence to a runnable one would also put a button under
   * an illustrative snippet from a model that was only answering a
   * question about syntax.
   */
  looseFences?: boolean
  /** What it scored here, when it has been measured. See Measured. */
  measured?: Measured
}

/**
 * What a model scored on this machine, as a number rather than a sentence.
 *
 * It was in the blurb - "9/10 on the ladder and 907ms" - which reads fine
 * and cannot be sorted, compared or kept honest. Four models said 9/10 and
 * the list was in the order someone typed them.
 *
 * `of` and `runs` are here because a score without them is not a score. Ten
 * rungs at one run apiece put nemotron-3-ultra at 10/10; the same ten at two
 * runs put it at 9/10, because L23 passes about half the time. A number that
 * does not say how hard it was measured invites exactly that mistake.
 */
export interface Measured {
  /** Ladder rungs answered cleanly on every run. */
  clean: number
  /** Rungs attempted. The full ladder is 41; a sample is fewer. */
  of: number
  /** Runs per rung. One is a sample, two is a measurement. */
  runs: number
  /** Median ms to a complete short answer at Wumpy's real preamble. */
  medianMs: number
  /** When, so a stale number is visibly stale rather than quietly wrong. */
  on: string
}

export const CLOUD_MODELS: CloudModel[] = [
  /*
   * GOOGLE IS OUT, for now. Asked for in those words: "remove gemini and
   * google for now".
   *
   * Nothing here says Gemini stopped working - the provider row, the system
   * folding, the loose-fence promotion, the measured allowances and the
   * `gemini-` routing rule are all still in place, so `/model gemini-3.1-
   * flash-lite` typed by hand reaches it exactly as before and putting these
   * entries back is one commit. What is gone is the offer.
   *
   * Measured the evening before, ten rungs at two runs each:
   *
   *   nemotron-3-super-120b   9/10     907ms   counted per minute
   *   gemini-3.1-flash-lite   8/10   2,278ms   counted per day
   *   gemini-3.8-flash        5/10  11,023ms   ~25 requests a day
   *   gemini-3.1-pro          -        429     limit: 0 on all four meters
   *
   * The one real loss is eyes: seesMedia is Google-only, so with no Gemini
   * selected nothing in the picker can read a picture. A look comes back as
   * the control list instead, which drives the desktop by name perfectly
   * well and cannot answer "what does this look like". That is the trade,
   * and it is the user's to make.
   */
  /* --- NVIDIA, measured 15 October 2026 ----------------------------------
   *
   * The list was Google-only because the others had been measured and found
   * wanting. These were measured again, on ten rungs of bench-ceiling at two
   * runs each, and three of them beat every Gemini in the picker on both
   * correctness and speed - on a budget counted per MINUTE rather than per
   * day, which is the part that matters when every desktop step is a turn.
   *
   * None of them can see. `seesMedia` is Google-only, so a screenshot is
   * dropped on the way out and a look comes back as the control list
   * instead. That is enough to drive the desktop by name and not enough to
   * answer "what does this look like".
   */
  {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    provider: 'nvidia',
    label: 'Nemotron 3 Super 120B',
    blurb: '32/41 on the full ladder, 0.9s, no daily cap.',
    measured: { clean: 32, of: 41, runs: 1, medianMs: 907, on: '2026-10-16' }
  },
  {
    id: 'deepseek-ai/deepseek-v4.1-flash',
    provider: 'nvidia',
    label: 'DeepSeek V4.1 Flash',
    blurb: '39/41 on the full ladder — the best measured here. 1.3s, no daily cap.',
    measured: { clean: 39, of: 41, runs: 1, medianMs: 1256, on: '2026-10-16' }
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    provider: 'nvidia',
    label: 'Nemotron 3 Ultra 550B',
    blurb: 'Biggest here, 9/10 and 2.5s. No measured advantage over Super.'
  },
  {
    id: 'z-ai/glm-5.3-flash',
    provider: 'nvidia',
    label: 'GLM 5.3 Flash',
    blurb: 'Scores with the best at 9/10, but 15s a turn.'
  },
  {
    id: 'z-ai/glm-5.3',
    provider: 'nvidia',
    label: 'GLM 5.3',
    // The index said it was the best free model there is. Measured here it
    // is second to last, and 88 seconds is not a turn anyone sits through.
    blurb: '5/10 and 88 SECONDS a turn. Listed so the measurement is visible.'
  },

  /* --- the user's own Ollama account ------------------------------------- */
  {
    id: 'gemma4:31b-cloud',
    provider: 'ollama',
    label: 'Gemma 4 31B (Ollama cloud)',
    blurb: '35/41 on the full ladder, 1.0s. Your Ollama account — no key, no Wumpy quota.',
    measured: { clean: 35, of: 41, runs: 1, medianMs: 967, on: '2026-10-16' }
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
/** A catalogue entry with its place in the measured order. */
export interface Ranked {
  model: CloudModel
  /** 1 is best. Null when the model has never been measured here. */
  rank: number | null
}

/**
 * The catalogue in measured order, best first.
 *
 * Score decides, then speed breaks the tie - which is the right way round
 * for this app and worth saying why. A wrong answer costs the user the turn
 * and then another turn correcting it; a slow right answer costs seconds.
 * But four models scored within a rung of each other, so speed is doing most
 * of the separating in practice, and at a desktop step every turn is a step.
 *
 * Unmeasured entries keep their catalogue position and get no rank, rather
 * than being sorted to the bottom as though they had scored zero.
 */
export function rankedModels(models: readonly CloudModel[] = CLOUD_MODELS): Ranked[] {
  const share = (m: CloudModel): number =>
    m.measured && m.measured.of > 0 ? m.measured.clean / m.measured.of : -1

  const order = models
    .filter((m) => m.measured)
    .slice()
    .sort((a, b) => share(b) - share(a) || (a.measured!.medianMs - b.measured!.medianMs))

  const place = new Map(order.map((m, i) => [m.id, i + 1]))
  return models.map((model) => ({ model, rank: place.get(model.id) ?? null }))
}

/** What the badge beside a model's name says, and how loudly. */
export interface ModelTag {
  text: string
  tone: 'top' | 'good' | 'fair' | 'weak'
  /** The whole measurement, for the tooltip. */
  title: string
}

/**
 * The badge for one model.
 *
 * Rank and raw score together: the rank answers "which is the good one"
 * at a glance and the score keeps it honest, because #1 of a bad field is
 * still #1. The bands are drawn where the measurements actually fall rather
 * than at round numbers.
 */
export function modelTag(model: CloudModel, rank: number | null): ModelTag | null {
  const m = model.measured
  if (!m || !rank) return null
  const share = m.of > 0 ? m.clean / m.of : 0
  const tone = rank === 1 ? 'top' : share >= 0.8 ? 'good' : share >= 0.6 ? 'fair' : 'weak'
  const seconds = m.medianMs >= 10_000 ? `${Math.round(m.medianMs / 1000)}s` : `${(m.medianMs / 1000).toFixed(1)}s`
  return {
    text: `#${rank} · ${m.clean}/${m.of}`,
    tone,
    title:
      `${m.clean} of ${m.of} ladder rungs clean at ${m.runs} run${m.runs === 1 ? '' : 's'} each, ` +
      `${seconds} median to a short answer. Measured ${m.on}.`
  }
}

export function providerFor(model: string): ProviderId | null {
  const name = (model ?? '').trim()
  if (!name) return null

  const known = CLOUD_MODELS.find((m) => m.id === name)
  if (known) return known.provider

  if (name.startsWith('gemini-') || name.startsWith('models/gemini-')) return 'google'

  /**
   * An Ollama CLOUD model, which is `name:tag-cloud` by their convention.
   *
   * Only the -cloud suffix, deliberately. A plain `phi4-mini:3.8b` is a model
   * on this laptop, and Wumpy has had no local client since it went
   * cloud-only - so routing those here would turn "not a hosted model" into a
   * connection attempt that fails later and less clearly.
   */
  if (!name.includes('/') && /:.*-cloud$/.test(name)) return 'ollama'

  /**
   * The vendor-prefixed forms are decided before the bare ones, because the
   * two overlap in a way that silently routes to the wrong endpoint:
   * `mistralai/mixtral-8x7b-instruct` is a model NVIDIA hosts, and it starts
   * with the letters "mistral", so a bare-name test run first sends it to
   * api.mistral.ai, which has never heard of it.
   */
  if (/^(nvidia|z-ai|deepseek-ai|minimaxai|meta|microsoft|google|mistralai)\//i.test(name)) {
    return 'nvidia'
  }
  if (
    !name.includes('/') &&
    /^(mistral|codestral|ministral|open-mistral|magistral|devstral|pixtral|voxtral)/i.test(name)
  ) {
    return 'mistral'
  }
  /**
   * Where Groq and NVIDIA both serve the same vendor, Groq wins the guess.
   *
   * They host overlapping open weights under the same vendor-prefixed names:
   * `moonshotai/kimi-k3` is on both, and both have something under `qwen/`.
   * Nothing in the string says which endpoint the user meant, so the
   * catalogue above is the only real answer and this is a tie-break. Groq
   * because it was here first and because a key for it already exists on this
   * machine - a wrong guess is a 404 with the provider named in it, not a
   * silent failure, and the model can be picked from /model instead.
   */
  if (name.startsWith('openai/') || name.startsWith('groq/') || name.startsWith('moonshotai/')) {
    return 'groq'
  }
  if (name.startsWith('qwen/')) return 'groq'
  return null
}

/**
 * Another model from the same provider to try when this one is out.
 *
 * Google's free allowance is "RequestsPerDayPerProjectPerModel" - the quota
 * id says so - which means each model has its own, and running out of one
 * says nothing about the next. Measured: gemini-3.5-flash refused with 14.5
 * hours to go while flash-lite and 3.8-flash both answered on the same key
 * in the same minute.
 *
 * So a spent model should step sideways before it steps down. Falling back
 * to a 3.8B local model when a perfectly good hosted one is sitting there
 * unused throws away the whole reason for being on the API backend.
 *
 * Ordered by how much is left rather than how good they are: the caps are
 * roughly twenty requests a day on the newer models and larger on the older
 * ones, so this walks towards the ones more likely to answer. Excludes the
 * model given, and anything already known to be spent.
 */
export function siblingModel(model: string, spent: ReadonlySet<string>): string | null {
  const provider = providerFor(model)
  if (!provider) return null
  /**
   * Probed against the live API, one request each, rather than taken from a
   * listing. The /models endpoint lists plenty that will not generate:
   * gemini-3.5-flash-lite and gemini-flash-lite-latest both answer 400 and
   * gemini-2.5-flash answers 404, while appearing in it perfectly happily.
   * All three were in this list, so a model running out would step sideways
   * onto one of them and fail - visible in /usage as two rows with one turn,
   * no tokens and one failure.
   *
   * Ordered by capability, since this only runs when the preferred model is
   * already spent: 3.5 scored 8/8 on the write-a-file tasks, the numbered
   * Flash models descend from there, and Lite is last because it is the
   * weakest and the most likely to still have requests left.
   */
  const order =
    provider === 'google'
      ? [
          'gemini-3.5-flash',
          'gemini-3.6-flash',
          'gemini-3.7-flash',
          'gemini-3.8-flash',
          'gemini-flash-latest',
          'gemini-3.1-flash-lite'
        ]
      : provider === 'mistral'
        ? [
            // Measured against a real free key rather than ordered by size.
            // The premier models answer 429 with limit/min 0 on a free plan,
            // so a rotation that steps onto one is a rotation that fails -
            // the same mistake as the three Gemini models that were in this
            // list while answering 400 and 404. Medium is last: a paid key
            // reaches it and it is the best of them when one does.
            'codestral-latest',
            'ministral-14b-latest',
            'mistral-code-latest',
            'ministral-8b-latest',
            'mistral-medium-latest'
          ]
        : provider === 'nvidia'
          ? [
              // Ordered by index score, since a sideways step only happens
              // when the preferred one is already unusable, and NVIDIA's limit
              // is per-minute rather than per-model - so there is no "more
              // likely to have requests left" to weigh against capability.
              // Every one of these has been called once; v4-pro used to be
              // here and answers 410.
              'z-ai/glm-5.3',
              /*
               * Kimi is not here any more, and the name was wrong as well.
               *
               * The list said kimi-k3, which is not in NVIDIA's catalogue at
               * all - it is kimi-k2.6 now. And measured on a real free key,
               * k2.6 answers 404 "Not found for account", so it is gated
               * rather than merely renamed. Either way it was a model Wumpy
               * offered and could not reach: a wasted request and a wasted
               * turn, which is what this list exists to prevent.
               */
              'nvidia/nemotron-3-ultra-550b-a55b',
              'deepseek-ai/deepseek-v4.1-flash',
              'nvidia/nemotron-3-super-120b-a12b',
              'z-ai/glm-5.3-flash'
            ]
          : ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']
  /**
   * Only ever a model the app actually ships.
   *
   * These lists outlived the catalogue: with everything but Gemini removed
   * from CLOUD_MODELS, a Mistral or NVIDIA model that ran out would still
   * step sideways onto a sibling nobody can select and that may have no
   * key behind it. The catalogue is the authority on what exists; this
   * list only decides the ORDER to try them in.
   */
  const shipped = new Set(CLOUD_MODELS.map((m) => m.id))
  return order.find((m) => m !== model && !spent.has(m) && shipped.has(m)) ?? null
}

export function isCloudModel(model: string): boolean {
  return providerFor(model) !== null
}

/* --------------------------------------------------------------- the folding */

/**
 * One piece of a multi-part message.
 *
 * A message is a plain string right up until it carries an image, at which
 * point the OpenAI-compatible shape is a list of parts. Both forms stay
 * allowed rather than normalising everything to a list, because the string
 * form is what every provider has always accepted and what almost every
 * message still is.
 */
export type WirePart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | WirePart[]
}

/** The text of a message, whichever shape it arrived in. */
export function wireText(content: string | WirePart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join(String.fromCharCode(10))
}

/**
 * Whether this model can look at a picture or a clip.
 *
 * Every model Wumpy offers is a Gemini and all of them can, video included:
 * measured, a three-second mp4 sent as a data URL came back correctly
 * through the same endpoint and the same part shape as an image. The other
 * three providers are still wired up - their keys keep working if you have
 * one - and the models on them are text only, so an image sent to one is a
 * 400 that costs the whole turn rather than a request that works less well.
 *
 * This is asked before the paste is accepted, not after: refusing to attach
 * and saying why is a missing feature, while attaching and quietly dropping
 * it on the way out is a wrong answer to a question nobody knows was not
 * asked.
 */
export function seesMedia(model: string): boolean {
  return Boolean(model) && providerFor(model) === 'google'
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
  // A system message is always plain text; wireText keeps that true even if
  // one ever is not, rather than putting "[object Object]" in the preamble.
  const systems = messages.filter((m) => m.role === 'system').map((m) => wireText(m.content).trim())
  const rest = messages.filter((m) => m.role !== 'system')
  if (systems.length <= 1) return messages.slice()
  return [{ role: 'system', content: systems.filter(Boolean).join('\n\n') }, ...rest]
}

/**
 * Turns one message into the shape the wire wants.
 *
 * Plain text stays plain text, which is what nearly every message is and
 * what every provider has always taken. A message carrying images becomes a
 * list of parts, text first - the order matters: an image handed over before
 * the question reads as the subject of it, which is exactly right for "what
 * is this", and a question asked before its picture reads as a question
 * about nothing.
 *
 * A video goes the same way as an image, in an image_url part with a
 * data:video/mp4 URL. That looks wrong and is not: measured against the
 * live API, a clip sent that way was read correctly, while the documented
 * input_audio part answered 400 "Invalid audio format mp4". The endpoint
 * takes the type from the data URL, not from the part's name.
 *
 * Attachments on a model that cannot see are DROPPED rather than sent,
 * because the alternative is a 400 that costs the whole turn. The composer
 * refuses to attach them in the first place; this is the second line.
 */
export function wireMessage(
  m: {
    role: string
    content: string
    images?: Array<{ dataUrl: string } & Partial<Attached>>
  },
  vision: boolean
): WireMessage {
  const role = m.role as WireMessage['role']
  if (!m.images?.length || role !== 'user') return { role, content: m.content }

  /*
   * A text file is characters, so it goes into the text part and reaches
   * every model - including one that cannot see, where the old code dropped
   * the whole attachment. A file whose bytes are no use to anyone becomes a
   * line saying so. @shared/attach decides which is which.
   */
  const folded = foldAttachments(
    m.content,
    m.images.map((a) => ({ ...a, kind: a.kind ?? 'image', bytes: a.bytes ?? 0 }))
  )

  /* Attachments whose BYTES go up are still dropped on a model that cannot
     read them, because the alternative is a 400 that costs the whole turn. */
  const sendable = vision ? folded.bytes : []
  if (!sendable.length) return { role, content: folded.text }

  const parts: WirePart[] = []
  if (folded.text) parts.push({ type: 'text', text: folded.text })
  for (const file of sendable) {
    const url = (file as { dataUrl?: string }).dataUrl
    if (url) parts.push({ type: 'image_url', image_url: { url } })
  }
  return { role, content: parts }
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

export function classifyLimit(
  status: number,
  body: string,
  model: string,
  /** The per-minute request allowance the provider reported, if it did. */
  limitPerMinute?: string | null
): LimitVerdict {
  if (status !== 429 && status !== 503) {
    return { kind: 'other', waitMs: 0, message: '' }
  }

  /**
   * A limit of zero is not a throttle, it is a locked door.
   *
   * Mistral answers 429 "Rate limit exceeded" for a model that is not on
   * your plan at all, which is the same status and almost the same words as
   * being told to slow down - and the header is the only thing that tells
   * them apart: x-ratelimit-limit-req-minute is 0 rather than 125.
   *
   * It matters because /model offers these. On a free key,
   * mistral-medium-latest, mistral-small-latest and the magistral models all
   * report 0, so picking one used to look like a passing hiccup and waiting
   * never helped.
   */
  if (limitPerMinute !== undefined && limitPerMinute !== null && Number(limitPerMinute) === 0) {
    return {
      kind: 'exhausted',
      waitMs: 0,
      message: `${model} is not available on this API plan. Pick another with /model.`
    }
  }

  const asked = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body ?? '')
  const askedMs = asked ? Math.round(Number(asked[1]) * 1000) + 500 : 0

  /**
   * Google names the limit it hit, and the name is the truth.
   *
   * retryDelay was the wrong thing to read and it misled twice: a model
   * asking for eighteen hours answered normally forty minutes later, which
   * is what the two previous attempts at this were trying to work around.
   *
   * The error carries a quotaId instead, and it says which limit:
   *
   *   GenerateRequestsPerDayPerProjectPerModel-FreeTier
   *   GenerateRequestsPerMinutePerProjectPerModel-FreeTier
   *
   * Per day is a day and waiting will not help. Per minute clears in a
   * minute. No guessing from a duration, and no threshold to get wrong.
   *
   * Note the "PerModel": the allowance is per model, not per key, so another
   * Gemini still answers when this one is out.
   */
  const quota = /"quotaId"\s*:\s*"([^"]+)"/.exec(body ?? '')?.[1] ?? ''
  if (/PerDay/i.test(quota)) {
    return {
      kind: 'exhausted',
      waitMs: 0,
      message:
        `${model} has used up its free requests for today` +
        (askedMs ? ` — about ${Math.round(askedMs / 3_600_000)}h left.` : '.')
    }
  }
  if (/PerMinute/i.test(quota)) {
    return {
      kind: 'throttle',
      waitMs: Math.min(GIVE_UP_AFTER_MS, askedMs || 20_000),
      message: `${model} is going too fast; waiting a moment.`
    }
  }

  if (status === 503) {
    return {
      kind: 'busy',
      waitMs: Math.min(GIVE_UP_AFTER_MS, askedMs || 8000),
      message: `${model} is busy right now.`
    }
  }

  if (askedMs >= EXHAUSTED_AFTER_MS) {
    /**
     * Reported as a long limit, not as a fact about the day.
     *
     * The wording here has been wrong twice. First everything over two minutes
     * was called an exhausted day; then only four hours or more was. Both were
     * too confident: gemini-3.8-flash asked for 65304 seconds - eighteen hours
     * - and answered normally forty minutes later, and gemini-3.5-flash did
     * the same thing earlier the same evening.
     *
     * So Google's retryDelay does not reliably mean what it says, and nothing
     * here can tell a spent day from a long throttle. The kind is kept because
     * the usage counter wants to distinguish them, but the sentence shown to
     * the user no longer claims to know, and says what to do either way.
     */
    const hours = Math.round(askedMs / 3_600_000)
    return {
      kind: 'exhausted',
      waitMs: 0,
      message:
        `${model} is rate limited — it asked to wait about ${hours}h, which usually means ` +
        'the free quota for today is gone, though it often clears much sooner.'
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
  if (provider === 'nvidia' && !key.startsWith('nvapi-')) {
    return { ok: false, why: 'An NVIDIA key starts with nvapi-.' }
  }
  return { ok: true, why: '' }
}

/**
 * What each tier uses when there is nothing local to use.
 *
 * Ollama is not always there. It can be stopped, mid-update, or never
 * installed, and before this every tier simply resolved to null and Wumpy sat
 * there telling the user to `ollama pull` something. With a key already saved
 * that is a silly thing to say: there is a model available, it is just not on
 * this machine.
 *
 * So a tier with no local option and a usable key falls through to here rather
 * than to nothing. It is a fallback and not a preference - anything installed
 * locally still wins, because local is free, private and works on a plane.
 *
 * Flash Lite for the quick tiers and 3.5 Flash for the ones that act, which is
 * the split the measurements support: 3.5 Flash scored 8/8 on the write-a-file
 * tasks, and the quick tiers are answering one-liners that do not need it.
 * Never 3.8 Flash, whose free tier is about 25 requests a day.
 */
/*
 * Re-pointed when Google left the picker. The split is the same idea and
 * the same evidence: the quick tiers get the fastest thing measured, and
 * the ones that act get the one that scored highest without being slow.
 * Super is both at once, so the split is narrower than it was - DeepSeek
 * matches it at 9/10 and is the one to differ on if a tier needs variety.
 */
export const FALLBACK_CLOUD_MODEL: Record<string, string> = {
  flash: 'nvidia/nemotron-3-super-120b-a12b',
  fast: 'nvidia/nemotron-3-super-120b-a12b',
  thinker: 'deepseek-ai/deepseek-v4.1-flash',
  deep: 'deepseek-ai/deepseek-v4.1-flash'
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
export function reasoningEffortFor(
  provider: ProviderId,
  thinking: boolean,
  model = ''
): 'none' | 'low' | null {
  if (thinking) return null
  if (provider === 'google') return 'none'
  /**
   * On Mistral it depends on the model, which is why this takes one.
   *
   * Most of the line does not take the field at all and an unknown parameter
   * there is a 400, not something quietly ignored - so the default stays
   * "send nothing". Medium 3.5 is the exception: Mistral's changelog
   * introduces it with "adjustable reasoning via the reasoning_effort
   * parameter", and it is the model this app points at first, so refusing to
   * send the field would throw away the largest saving found all session.
   *
   * Matched on the family rather than the exact id because the alias moves:
   * mistral-medium-latest, mistral-medium-3-5 and a future dated snapshot are
   * all the same model.
   */
  if (provider === 'mistral') {
    return /^mistral-medium(-latest|-3[-.]5|-3[-.][6-9]|-[4-9])/i.test(model) ? 'low' : null
  }
  /**
   * NVIDIA ignores this field rather than refusing it, so sending it would be
   * a comforting no-op. The switch that works there is
   * chat_template_kwargs.enable_thinking - see thinkingKwargsFor - and on the
   * GLM models not even that is reported to work, which is what the
   * provider's alwaysReasons flag exists to cover.
   */
  if (provider === 'nvidia') return null
  return 'low'
}

/**
 * The non-standard reasoning switch, for the endpoint that has no standard one.
 *
 * NVIDIA's OpenAI-compatible layer puts this inside chat_template_kwargs,
 * where it reaches the model's chat template rather than the server. Nemotron
 * is documented to take enable_thinking and NVIDIA's own samples send it;
 * DeepSeek V4 honours it; GLM-5.3 is reported to keep reasoning regardless.
 *
 * Sent anyway on all of them, because on the two that honour it the saving is
 * the same one measured on Google, and on the ones that do not an extra key
 * in chat_template_kwargs is ignored by the template that has no use for it.
 * Returns null where there is nothing to send, so the field is omitted rather
 * than sent empty - an empty object is still an unknown parameter to a
 * provider that does not take one.
 */
export function thinkingKwargsFor(
  provider: ProviderId,
  thinking: boolean
): Record<string, boolean> | null {
  if (provider !== 'nvidia') return null
  if (thinking) return null
  // force_nonempty_content because a model that reasons and then says nothing
  // visible has produced an empty answer as far as Wumpy is concerned, and an
  // empty answer is indistinguishable from a failure in the panel.
  return { enable_thinking: false, force_nonempty_content: true }
}

/**
 * The output cap to send, given the tier's and whether reasoning is on.
 *
 * The provider is optional and defaults to leaving the old behaviour alone,
 * because one of them reasons whether or not it was asked to. On that one the
 * allowance is unconditional: a 384-token cap on a model that spends its first
 * 200 tokens thinking returns a sentence cut off mid-word, which is the exact
 * failure measured on Google before reasoning_effort was found.
 */
export function maxTokensFor(numPredict: number, thinking: boolean, provider?: ProviderId): number {
  const asked = numPredict > 0 ? numPredict : 1024
  const reasons = thinking || (provider ? PROVIDERS[provider].alwaysReasons : false)
  return reasons ? asked + THINKING_ALLOWANCE : asked
}

/* --------------------------------------------------------------- the key itself */

/** Never log or display a key in full, including in an error. */
export function maskKey(raw: string): string {
  const key = (raw ?? '').trim()
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
