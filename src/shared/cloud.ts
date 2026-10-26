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
import { MEDIA_NOT_SENT, foldAttachments, type Attached } from './attach'
/* The meter's own estimate, so the room left for an answer is measured the
   same way as the room it is being taken out of. */
import { estimateTokens } from './pressure'
/* Type only, and it has to stay that way: @shared/order imports this file
   for the catalogue and the usable-speed floor, so a value imported back
   from it would be a cycle. The one thing needed here is the NAME of an
   order, for a sentence in a tooltip. */
import type { Ordering } from './order'

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
   * A SECOND KEY IS A SECOND ALLOWANCE, which is true of exactly one
   * provider here and is assumed everywhere the meter multiplies.
   *
   * Google's free tier is metered PerProjectPerModel and an API key belongs
   * to a Cloud project, so twenty keys really are twenty allowances - that
   * is the entire reason the rotation exists and the reason a cap is
   * multiplied by the number of keys before being shown.
   *
   * Nowhere else does a key work like that. An NVIDIA key is a credential
   * against an account, and the limit belongs to the account: NVIDIA's own
   * forum describes the ceiling as depending on "the amount of current
   * overall traffic using the same access", and a second key issued from
   * the same login buys nothing. Only a second ACCOUNT does. Groq and
   * Mistral meter per account in the same way.
   *
   * So this is off by default and the multiplication asks before applying
   * itself. It was latent rather than wrong while NVIDIA had no known cap -
   * zero multiplied is still zero - but the first `exhaustedAt` recorded
   * from a real 429 would have been multiplied by the number of keys, and
   * the meter would have read half-full on an allowance already spent.
   */
  quotaPerKey?: boolean
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
    /* The only one. A key is a Cloud project and the meters are keyed
       PerProjectPerModel, so keys really do multiply. See quotaPerKey. */
    quotaPerKey: true,
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
  /**
   * One line in the picker, in a fixed shape: score, speed, eyesight.
   *
   *   38/41 · 4.6s · reads images. The best balance measured here.
   *
   * Three facts separated by dots and then at most one sentence, because
   * the picker is read by someone comparing six rows at a glance and
   * prose does not compare. They drifted out of that shape and out of
   * date together: one promised 0.9s for a model measured at 6.3s, one
   * called itself "the only one here that can read a picture" after three
   * others were found to read them, and one said "15s a turn" about a
   * model that answers in 4.6.
   *
   * The numbers are the ones in `measured` and `vision`, so a blurb that
   * contradicts them is a bug visible from the same screen.
   */
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
  /**
   * It can read a picture, so a screenshot is worth sending.
   *
   * Only set where it has been proven by asking: a 64x64 image, red on the
   * left and blue on the right, and a question only the pixels answer. A
   * model that is listed as vision-language and answers from the words
   * around the image would be worse than one that cannot see at all, since
   * the bytes would be paid for and the answer invented.
   */
  sees?: boolean
  /** What it scored here, when it has been measured. See Measured. */
  measured?: Measured
  /**
   * How well it reads a picture, which is not the same as whether it can.
   *
   * `sees` is one bit and was doing two jobs. It decides whether to send
   * the bytes at all, which is all it should decide - and it was also,
   * through `eyeFor`, choosing which model gets borrowed to describe a
   * screen. That choice was made on the LADDER score, which measures
   * reasoning and says nothing about eyesight: the moment deepseek was
   * correctly marked as sighted it became the app's eye on 39/41, and a
   * screenshot would have taken the ninety seconds it needs per image
   * instead of the VL model's 370ms.
   *
   * So eyesight is measured separately, by scripts/bench-vision.mjs: six
   * rungs from "which side is red" up to "read the small number in the
   * red box", images generated and numbers randomised per run.
   */
  vision?: { clean: number; of: number; medianMs: number; on: string }
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
  /**
   * Rungs attempted. A sample is fewer than the whole ladder.
   *
   * The ladder grows, so this is not a constant and every score carries
   * the length it was measured against. L42 was added on 18 Oct, after a
   * model told the user it could not type while holding the instructions
   * saying it can - and the whole catalogue was re-run on the 21st so
   * the column compares like with like.
   *
   * Two are still `of: 41` and cannot cheaply be brought over: deepseek
   * at 112 seconds a turn and glm-5.3 at ninety-or-nothing would each
   * take something like two and a half hours of wall clock to climb. A
   * share out of 41 against one out of 42 is close enough to rank with
   * and not close enough to call equal, which is exactly why the
   * denominator is stored rather than assumed.
   */
  of: number
  /** Runs per rung. One is a sample, two is a measurement. */
  runs: number
  /**
   * Median ms to a complete short answer at Wumpy's real preamble.
   *
   * Every figure here was re-measured on 19 Oct, because the old ones
   * were not this. They had drifted into being times from a FOUR-WORD
   * prompt, which leaves out prompt processing - most of the cost for a
   * quick model and almost none of it for a slow one, so the old numbers
   * did not even preserve the order. nemotron-3-super read 907ms and is
   * 6,264; glm-5.3-flash read 14,882 and is 4,577, which is the same two
   * models swapping places.
   *
   * The ladder scores beside them are older and are NOT re-measured here:
   * clean/of/runs still describe the capability run on the date each was
   * taken. Only the latency moved.
   */
  medianMs: number
  /** When, so a stale number is visibly stale rather than quietly wrong. */
  on: string
}

/**
 * A latency `/model check` measured here, which beats the one in the file.
 *
 * THE CHECK WAS MEASURING THE THING THE RANKING TURNS ON AND THROWING IT
 * AWAY. `Measured.medianMs` is a figure taken on one afternoon and shipped;
 * the probe takes the same figure, against the same preamble, on the user's
 * own keys, today - and then printed it in a report and forgot it, while
 * the picker went on ordering by the shipped number.
 *
 * That is not a cosmetic gap. The run on 22 Oct put the VL model at 40.4s
 * against the 10.9s in the catalogue and deepseek at 6.2s against 112.2s:
 * both cross UNUSABLY_SLOW_MS, in opposite directions, so the picker's #2
 * was unusable that afternoon and the row it buried at #8 was the one the
 * same report recommended. Two readings of the same machine disagreeing on
 * the same screen.
 *
 * ONLY THE LATENCY. The probe asks for one short answer; it does not climb
 * the capability ladder, so `clean`/`of` keep coming from the catalogue and
 * nothing here can invent a score. That is the same split `recommend()` has
 * always used: the score is published, the speed is what just happened.
 */
export interface Fresh {
  /** Median ms over the probe's runs, at Wumpy's real preamble. */
  ms: number
  /** How many times it was asked. One is a sample, two is a measurement. */
  runs: number
  /** The day it was asked, so an old check reads as old. */
  on: string
  /**
   * Did it answer every run?
   *
   * False for empty, missing, refused, timeout, flaky and error alike -
   * the ranking only needs to know that choosing it would not have
   * worked, and the report beside it says which way it failed. A model
   * that did not answer cannot outrank one that did, which is the rule
   * UNUSABLY_SLOW_MS already applies to a model that answers too late.
   */
  ok: boolean
}

/** What the last check found, by model id. Absent means never checked. */
export type Latencies = Readonly<Record<string, Fresh>>

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
   * Eyes were the one real loss, and they are back without Google: see the
   * VL entry below, which is the only model here that can read a picture.
   * Everything else in this list is text-only, so a look on those comes back
   * as the control list - enough to drive the desktop by name, not enough to
   * answer "what does this look like".
   */
  /* --- NVIDIA, measured 15 October 2026 ----------------------------------
   *
   * The list was Google-only because the others had been measured and found
   * wanting. These were measured again, on ten rungs of bench-ceiling at two
   * runs each, and three of them beat every Gemini in the picker on both
   * correctness and speed - on a budget counted per MINUTE rather than per
   * day, which is the part that matters when every desktop step is a turn.
   *
   * Only the VL one can see. On the rest a screenshot is dropped on the way
   * out and a look comes back as the control list instead - enough to drive
   * the desktop by name and not enough to answer "what does this look
   * like".
   */
  /*
   * NEMOTRON 3 SUPER IS GONE, and the check is what found it.
   *
   * 32/41 on 16 Oct, 6,264ms on the morning of the 21st, and 404 that
   * same evening: "Function 'ac74040f-...': Not found". Ultra answered
   * 200 on the same key a second later, so it was not the key, the
   * network or capacity - NVIDIA withdrew the deployment between one
   * measurement and the next, which is precisely what a listing of 81
   * ids where seventeen 404 should have led anyone to expect.
   *
   * Same treatment as Google's entries and DeepSeek v4-pro before it:
   * the routing stays, so the name typed by hand still reaches NVIDIA
   * and gets NVIDIA's own 404, and the ROW goes. A row that 404s is
   * worse than no row, because someone picks it and loses the turn.
   */
  {
    id: 'deepseek-ai/deepseek-v4.1-flash',
    provider: 'nvidia',
    /**
     * It reads images too, and slowly enough that it barely matters.
     *
     * Asked the red/blue question twice on 19 Oct: one answered "Blue"
     * correctly, the other was still going at the 90-second ceiling. So
     * the capability is real and the flag is honest, but a screenshot
     * here costs a minute and a half of waiting on top of the 112s this
     * model already takes to answer anything.
     *
     * Set anyway. The alternative is the borrowed eye, which spends a
     * whole extra request to hand this model a worse description than the
     * picture it can read itself - and anyone who has deliberately chosen
     * a two-minute model has already decided what they are trading.
     */
    sees: true,
    vision: { clean: 0, of: 1, medianMs: 90_006, on: '2026-10-19' },
    /**
     * THE LATENCY HERE IS SETTLED NOW, AND IT IS NOT 1.3s.
     *
     * 1,256ms on 16 Oct, one run of the full ladder, median to a COMPLETE
     * short answer at Wumpy's real preamble. 103,204ms to the FIRST WORD on
     * 18 Oct, from scripts/verify-models.mjs, on a four-word prompt.
     *
     * The two are not the same measurement, and the mismatch is the point
     * rather than an excuse: the second is the easier question - a shorter
     * prompt, and stopping at the first token instead of the last - and it
     * came back eighty times slower on the model this app answers with by
     * default. Nothing about prompt size explains that; it is queueing at
     * the provider.
     *
     * Asked a second time the same day, because one sample is not a
     * measurement and this file says so: 114,646ms. Two runs, both about
     * a hundred seconds, on the easier question. That is the figure now.
     * The 1,256ms stands as what one ladder run saw on 16 Oct and no
     * longer as what anyone should expect.
     *
     * So the measurement is left as recorded rather than overwritten by a
     * second sample that disagrees with it, and the blurb - which is what
     * the picker shows - stops stating a speed it cannot stand behind. What
     * settles it is runs: 2 on the ladder, not another anecdote.
     *
     * The ladder score is not in dispute. 39/41 is the best measured here
     * and nothing about today's run touches it.
     */
    label: 'DeepSeek V4.1 Flash',
    blurb: '39/41 on the shorter ladder · 112s a turn · reads images, slowly.',
    /* 103,204ms is the kinder of two probes on 18 Oct and a FLOOR for this
       field, not a like-for-like: the probe asks four words and stops at
       the first token, where this column means a complete short answer at
       the real preamble. Understating it is the safe direction, and it is
       within a tenth of the truth where 1,256ms was out by eighty times.
       The ladder score is from 16 Oct and stands. */
    measured: { clean: 39, of: 41, runs: 2, medianMs: 112_211, on: '2026-10-19' }
  },
  /*
   * NEMOTRON 3 ULTRA IS NOT OFFERED, because it does not answer.
   *
   * It was here on a ten-rung sample - 9/10, 2.5s, biggest model on the
   * list - and three attempts to confirm that on the full ladder have now
   * failed in three different ways:
   *
   *   16 Oct   every one of 41 rungs came back 504 from the gateway
   *   17 Oct   the stream opened and closed having said nothing at all
   *   17 Oct   asked again a minute later: 503 "Service temporarily
   *            overloaded", with and without the thinking switch
   *
   * The empty stream is the one that decided it. A 504 is visibly a
   * failure; an empty answer is a turn the user spent and got a blank
   * panel for, which is the exact thing the offered list exists to
   * prevent - the same reason kimi and gpt-oss came out of it.
   *
   * Routing is untouched, like Google's: `/model nvidia/nemotron-3-ultra-
   * 550b-a55b` typed by hand still reaches NVIDIA and gets whatever NVIDIA
   * says that day, and putting the entry back is one commit. What is gone
   * is the offer.
   */
  {
    id: 'z-ai/glm-5.3-flash',
    provider: 'nvidia',
    label: 'GLM 5.3 Flash',
    /**
     * It can see, and was marked blind by omission until 19 Oct.
     *
     * 5 of 6 rungs on the vision ladder at 1,599ms: colour and position,
     * counting, large text, 8-pixel text, and small text read out of the
     * correctly-coloured box. It dropped one half of V5 by answering
     * "**34" - a truncation at the token ceiling rather than a misread,
     * since the same question at a smaller text size passed both ways.
     *
     * Which matters more here than anywhere: this is the model the
     * recommendation picks, and every screenshot sent to it was being
     * replaced by a description borrowed from a second model.
     */
    sees: true,
    vision: { clean: 5, of: 6, medianMs: 1_599, on: '2026-10-19' },
    blurb: '37/42 · 4.6s · 5/6 eyesight.',
    measured: { clean: 37, of: 42, runs: 2, medianMs: 4_577, on: '2026-10-21' }
  },
  /*
   * THE ONE THAT CAN SEE, and the reason this entry exists at all.
   *
   * "an annoying thing is that the model does not support images, sooo,
   * yea. its pretty smart at least." Removing Google took the eyes out of
   * the picker, which was named at the time as the trade; this puts them
   * back without putting Google back.
   *
   * Proven rather than assumed. NVIDIA's catalogue lists several vision
   * models and being listed is not evidence, so it was asked: a 64x64
   * image, red on the left and blue on the right, and "which colour fills
   * the left half?". It answered correctly in 2.3 seconds. Two of the older
   * ones were tried the same way and are not here.
   *
   * Two full ladders rather than one, because the first run hit a 500 and a
   * 502 from the gateway - infrastructure, not the model, so those rungs are
   * not counted as failures. Clean on BOTH runs: 36. Run two alone was 38.
   *
   * And it is the fastest thing in this list: 859ms median at Wumpy's real
   * 14,212-token preamble, of which 13,008 came back cached.
   */
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    provider: 'nvidia',
    label: 'Nemotron 3.5 Super VL 120B',
    sees: true,
    vision: { clean: 6, of: 6, medianMs: 370, on: '2026-10-19' },
    /* The 859ms stands as a ladder median on 16 Oct. Two probes on 18 Oct
       came back at 4,128ms and 9,252ms to the first word, on a far shorter
       prompt, so "the fastest measured" is no longer a claim this can
       carry. The ladder score is untouched. */
    blurb: '38/42 · 10.9s · 6/6 eyesight — the sharpest here.',
    measured: { clean: 38, of: 42, runs: 2, medianMs: 10_923, on: '2026-10-21' }
  },
  {
    id: 'z-ai/glm-5.3',
    provider: 'nvidia',
    label: 'GLM 5.3',
    /* Refused outright, measured 19 Oct: "Invalid request" for any
       message carrying an image part. Explicit, because absent now means
       sighted and this one is not. */
    sees: false,
    /*
     * The index said it was the best free model there is. The full ladder
     * puts it below its own Flash sibling - 33 against 38 - and 88 seconds
     * is not a turn anyone sits through. Listed so the measurement is
     * visible rather than folklore.
     *
     * Worse than slow, as of 18 Oct: two probes with a four-word prompt
     * returned 104,315ms and then nothing at all, aborted at the 180s
     * ceiling. Not a latency any more, an unreliability - which is the
     * distinction `/model check` now draws, and the reason it asks twice.
     */
    blurb: '33/41 · 90s when it answers, and often nothing · text only.',
    measured: { clean: 33, of: 41, runs: 1, medianMs: 120_000, on: '2026-10-19' }
  },

  /*
   * --- found on 21 Oct, by asking the endpoint what it has ----------------
   *
   * `/v1/models` lists 81 ids. Twenty-eight plausible chat models were
   * tried with the real preamble, and SEVENTEEN answered 404 - the
   * listing is largely stale, so appearing in it proves nothing and this
   * file only carries what has been called.
   *
   * These four answered. None has been up the capability ladder yet, so
   * they have a speed and no score: `measured` is deliberately absent
   * rather than guessed, which leaves them unranked in the picker and
   * out of the recommendation until someone runs the ladder.
   */
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    provider: 'nvidia',
    label: 'Nemotron 3 Ultra 550B',
    /*
     * BACK, AND THE REASON IT LEFT NO LONGER HAPPENS.
     *
     * Removed on 17 Oct after three attempts failed three ways: 41 rungs
     * of 504s, then a stream that opened and said nothing, then 503
     * "Service temporarily overloaded". The note left behind said the
     * routing was untouched and putting the entry back was one commit.
     *
     * This is that commit. Asked again on 21 Oct with the full preamble:
     * "ready" in 1,006ms, the quickest thing measured here. The empty
     * stream was the gateway having a bad week, which is exactly what
     * the 5xx retry added on 18 Oct now absorbs.
     */
    /*
     * Laddered 21 Oct, two runs a rung: 38 of 42 clean, breaking only on
     * L6, L23 and L38 with L32 intermittent. The highest count anything
     * here has posted, at the quickest time anything here has posted.
     *
     * Not directly comparable to deepseek's 39/41, which was taken
     * before L42 existed - 0.905 against 0.951 as a share. What is
     * comparable is the second column: one second against a hundred and
     * twelve.
     */
    measured: { clean: 38, of: 42, runs: 2, medianMs: 1_006, on: '2026-10-21' },
    blurb: '38/42 · 1.0s · the best balance measured here.'
  },
  {
    id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    provider: 'nvidia',
    label: 'Nemotron 3.5 Lightning 30B',
    /*
     * Laddered 21 Oct: 22 of 42, and the shape of the failures is worse
     * than the count. Seventeen rungs broken, most of them answered "no
     * command proposed" - L24, L25, L27, L28, L29, L30 - which is the
     * model replying from memory instead of checking the machine.
     *
     * That is the one behaviour this whole app exists to prevent, and it
     * is why a fast small model is not automatically a good one. Kept in
     * the list with the number showing rather than dropped: it answers,
     * it answers quickly, and the ranking buries it on its own.
     */
    measured: { clean: 22, of: 42, runs: 2, medianMs: 1_288, on: '2026-10-21' },
    blurb: '22/42 · 1.3s · fast, but answers from memory instead of checking.'
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    provider: 'nvidia',
    label: 'Nemotron 3 Nano Omni 30B',
    /* The "omni" naming suggests more than text, and it has not been
       asked yet - bench-vision.mjs settles that in six rungs. Until it
       is, `sees` is absent, which now means it gets sent pictures and
       the endpoint's own refusal decides. */
    /*
     * IT CAN SEE, AND IT IS RATIONED.
     *
     * Vision, 21 Oct: it read a four-digit number out of the correctly
     * coloured box, and large and small text besides - the hard rungs,
     * passed. Every rung it failed failed with "ResourceExhausted:
     * Worker local total request limit reached (16/16)", which is
     * NVIDIA's capacity rather than the model's eyesight, so the 3/6 it
     * scored understates it and no `vision` figure is recorded until it
     * can be measured cleanly.
     *
     * The rationing is the thing worth knowing. Two ladder attempts were
     * abandoned after it spent twenty minutes in a (busy, waiting 20s)
     * loop around rung 20. A model that cannot be benchmarked because
     * the provider keeps refusing it is a model that will refuse the
     * user too, and that belongs in the blurb rather than in a log.
     */
    /*
     * Laddered 21 Oct, two runs a rung: 17 of 42, eighteen rungs broken.
     * Mostly "no command proposed" - L2, L7, L8, L13 - which is the
     * model answering out of its own head instead of checking the
     * machine, the same failure that sank Lightning and the one thing
     * this app exists to prevent.
     *
     * THE RATIONING COST TIME, NOT SCORE, and that distinction was worth
     * checking before writing a number down. The run paused 39 times for
     * twenty seconds apiece - thirteen minutes of waiting - and not one
     * of the eighteen failures mentions capacity. The bench's retry
     * absorbed every ResourceExhausted and scored the rung on what the
     * model eventually said, which is exactly what it is for: a
     * benchmark must not be the reason the thing it measures looks
     * worse than it is.
     */
    measured: { clean: 17, of: 42, runs: 2, medianMs: 1_363, on: '2026-10-21' },
    blurb: '17/42 · 1.4s · reads images, but answers from memory · rate limited.'
  },
  {
    id: 'stepfun-ai/step-5-preview',
    provider: 'nvidia',
    /* "Step 5 Preview" names neither the maker nor the size, which every
       other row carries at least one of - and "Step 5" alone means
       nothing to someone scanning a list. StepFun is the lab; 600B total
       with about 27B active is the shape. Preview moves to the blurb,
       where the instability belongs with the other caveats. */
    label: 'StepFun Step 5 600B',
    /* Leaks its reasoning into the answer: the probe came back "The user
       just said \"Say: rea...". The app strips reasoning where the
       provider marks it as such, and this one does not mark it, so the
       thinking arrives as content. Listed with the warning rather than
       hidden. */
    /*
     * Laddered 21 Oct, two runs a rung: 36 of 42, broken only on L6 and
     * L38 with four rungs intermittent. Third on score and second on
     * speed, from a model added that morning on the strength of one
     * reply.
     *
     * The thinking-out-loud is the catch and is not cosmetic: it emits
     * reasoning as CONTENT rather than marking it, so the app cannot
     * separate it the way it does for every other model here. Nobody has
     * asked whether /nothink suppresses it - NVIDIA's switch is the
     * chat-template one, which some models honour and some ignore.
     */
    measured: { clean: 36, of: 42, runs: 2, medianMs: 2_182, on: '2026-10-21' },
    blurb: 'Preview · 36/42 · 2.2s · 1M context, reads video · thinks out loud.'
  },

  /* --- the user's own Ollama account ------------------------------------- */
  {
    id: 'gemma4:31b-cloud',
    provider: 'ollama',
    label: 'Gemma 4 31B (Ollama cloud)',
    /**
     * IT CAN SEE, AND THIS ENTRY SAID IT COULD NOT BY SAYING NOTHING.
     *
     * `sees` is absent-means-no, so the VL model was treated as the only
     * eye in the catalogue and every screenshot bound for Gemma was
     * replaced with the control list - or with a description borrowed from
     * another model, which costs a second request to produce something
     * worse than the picture this one would have read.
     *
     * Asked rather than assumed, by the method this file already uses: a
     * 64x64 image, red on one side and blue on the other, and "which
     * colour fills the LEFT half?". Measured 19 Oct through the Ollama
     * endpoint the app actually calls: "Red" in 658ms, and - because that
     * question has only two answers and a coin would get half of them -
     * the mirrored image too, which came back "Blue". It is reading the
     * pixels.
     *
     * Worth having for a second reason: it is on the user's own Ollama
     * account, so a screenshot sent here costs nothing from any Wumpy
     * quota at all.
     */
    sees: true,
    /* 1,119ms when the test image was sent uncompressed and 600 when
       it was deflated - the payload, not the model. Recorded as the
       deflated figure, which is what the app now sends. */
    vision: { clean: 6, of: 6, medianMs: 600, on: '2026-10-21' },
    blurb: '35/42 · 1.8s · 6/6 eyesight. Your Ollama account — no Wumpy quota.',
    measured: { clean: 35, of: 42, runs: 2, medianMs: 1_781, on: '2026-10-21' }
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
/**
 * Time past which a right answer has stopped being worth waiting for.
 *
 * The ordering below used to be score first and speed only as a tie-break,
 * on the reasoning that "a wrong answer costs the user the turn and then
 * another turn correcting it; a slow right answer costs seconds". Sound,
 * and its premise failed on 18 Oct: deepseek-v4.1-flash took 103 and 115
 * seconds to the first word, and glm-5.3 took 104 and then never answered
 * at all. That is not seconds, and nobody sits through it - they press
 * stop, which costs the turn exactly the way a wrong answer does.
 *
 * So there is a floor now, and it is drawn well clear of anything in
 * normal territory: the slowest entry below it is 15s, the quickest above
 * it is 88s. Nothing has ever been measured here in between.
 *
 * WHICH ORDER IT IS A FLOOR UNDER is now a question with an answer. It
 * governs the balanced tab of the picker and the recommendation at the end
 * of `/model check`, and it is deliberately not applied to the smartest
 * and fastest tabs: those two answer a narrower question than "what should
 * I use", and are allowed to answer it. Every rule about the sorting lives
 * in @shared/order, which is also where this constant's one-line
 * consequence - a slow model cannot be the recommendation - is written out
 * as arithmetic.
 */
export const UNUSABLY_SLOW_MS = 30_000

/**
 * The speed to show for a model, and whether anyone checked it lately.
 *
 * One answer to "how fast is this", so the badge, the row and the ranking
 * cannot quote three different numbers at each other.
 */
export function speedOf(
  model: CloudModel,
  fresh: Latencies = {}
): { ms: number; runs: number; on: string; live: boolean; ok: boolean } | null {
  const live = fresh[model.id]
  if (live) return { ms: live.ms, runs: live.runs, on: live.on, live: true, ok: live.ok }
  const m = model.measured
  if (!m) return null
  return { ms: m.medianMs, runs: m.runs, on: m.on, live: false, ok: m.medianMs < UNUSABLY_SLOW_MS }
}

/** Seconds, at the precision the size deserves: 1.3s, but 40s. */
export function secs(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * How far a fresh reading has to move before the row mentions it.
 *
 * A third either way, in log terms, because the blurbs are written to one
 * decimal place and a model that reads 4.6s one day and 5.1s the next has
 * not changed - saying so on every row would be noise with the shape of
 * news. A third is comfortably outside the run-to-run spread the probe
 * itself reports (the 22 Oct check spread 685-1,488ms on one model) and
 * comfortably inside the gaps that matter.
 */
const WORTH_SAYING = 0.125 // log10(4/3) ≈ 0.125

/**
 * What the last check found, as a clause for the picker row - or null when
 * it agrees with the blurb and there is nothing to add.
 *
 * The blurb is prose somebody wrote and it carries a time in it. Rewriting
 * that sentence from a measurement is how a hand-written caveat gets eaten
 * by a regex, so the fresh number arrives BESIDE it and the reader can see
 * both. When they agree, only one is shown.
 */
export function freshNote(model: CloudModel, fresh: Latencies = {}): string | null {
  const live = fresh[model.id]
  if (!live) return null
  if (!live.ok) return 'did not answer when last checked'
  const was = model.measured?.medianMs
  const crossed =
    was !== undefined && was < UNUSABLY_SLOW_MS !== live.ms < UNUSABLY_SLOW_MS
  const moved = was === undefined || Math.abs(Math.log10(live.ms / Math.max(1, was))) > WORTH_SAYING
  return crossed || moved ? `${secs(live.ms)} when last checked` : null
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
export function modelTag(
  model: CloudModel,
  rank: number | null,
  fresh: Latencies = {},
  /**
   * Which order the `#` is a place in.
   *
   * The tooltip used to end "which is what the order above uses", which was
   * true of the only order there was. On the smartest tab it is the
   * opposite: the list is sorted on the ladder and the fresh time is
   * exactly what is being set aside. One screen quoting two readings of the
   * same machine at each other is the failure this file keeps a diary of,
   * so the sentence names which one it is.
   *
   * Optional, and absent reads as the default order rather than as a
   * fourth case: every caller that does not care is showing a list sorted
   * the way it always was.
   */
  ordering?: Ordering
): ModelTag | null {
  const m = model.measured
  if (!m || !rank) return null
  const share = m.of > 0 ? m.clean / m.of : 0
  const live = fresh[model.id]
  /*
   * A model that just failed its check is not a good one today, whatever
   * it scored in October. The band is about what the user is about to get,
   * and the ladder cannot see that the endpoint has stopped answering.
   */
  const tone =
    live && !live.ok ? 'weak' : rank === 1 ? 'top' : share >= 0.8 ? 'good' : share >= 0.6 ? 'fair' : 'weak'
  const ladder =
    `${m.clean} of ${m.of} ladder rungs clean at ${m.runs} run${m.runs === 1 ? '' : 's'} each, ` +
    `${secs(m.medianMs)} median to a short answer. Measured ${m.on}.`
  return {
    text: `#${rank} · ${m.clean}/${m.of}`,
    tone,
    title: live
      ? `${ladder} Checked again ${live.on}: ` +
        (live.ok
          ? `${secs(live.ms)} over ${live.runs} run${live.runs === 1 ? '' : 's'}, which ` +
            (ordering === 'smarts'
              ? 'this list is deliberately not sorted on.'
              : 'is what the order above uses.')
          : 'it did not answer, so it is ranked below everything that did.')
      : ladder
  }
}

/**
 * Does each of this provider's keys carry an allowance of its own?
 *
 * Two ways it can be true, and they are different kinds of fact.
 *
 * `quotaPerKey` is a property of the PROVIDER and is known here: a Google
 * key is a Cloud project and the meters are keyed PerProjectPerModel, so
 * keys multiply whatever the user does.
 *
 * `mode` is a property of the USER'S SETUP and cannot be known here: two
 * NVIDIA keys are two doors into one account's ceiling, or one door each
 * into two accounts' ceilings, and the keys are identical either way. The
 * endpoint will not say, the key will not say, and the only one who knows
 * is the person who made them. So they tell us, and until they do the
 * answer is the cautious one.
 */
export function keysAreSeparate(
  provider: ProviderId | null,
  mode?: 'shared' | 'separate'
): boolean {
  if (!provider) return false
  return PROVIDERS[provider].quotaPerKey === true || mode === 'separate'
}

/**
 * How many separate allowances a given number of keys actually buys.
 *
 * Getting it wrong is not a cosmetic error: it is the difference between a
 * meter that says "310 requests left" and one that says 310 when there
 * are 15.
 *
 * At least one, always. Zero keys is not a zero allowance, it is no
 * provider configured, and a zero here would divide a meter by nothing.
 */
export function budgetsFor(
  provider: ProviderId | null,
  keys: number,
  mode?: 'shared' | 'separate'
): number {
  const counted = Math.max(1, Math.floor(keys))
  return keysAreSeparate(provider, mode) ? counted : 1
}

export function providerFor(model: string): ProviderId | null {
  const name = (model ?? '').trim()
  if (!name) return null

  const known = CLOUD_MODELS.find((m) => m.id === name)
  if (known) return known.provider

  if (name.startsWith('gemini-') || name.startsWith('models/gemini-')) return 'google'

  /**
   * ANY `name:tag` IS OLLAMA, local or cloud.
   *
   * This was `-cloud` only, on the reasoning that "a plain phi4-mini:3.8b
   * is a model on this laptop, and Wumpy has had no local client since it
   * went cloud-only - so routing those here would turn 'not a hosted
   * model' into a connection attempt that fails later and less clearly".
   *
   * That was wrong about the mechanism and is now wrong about the need.
   * There is nothing extra to build: Ollama's OpenAI-compatible endpoint
   * serves LOCAL and cloud models at the same URL, which is already the
   * `ollama` provider - gemma4:31b-cloud has been reaching local hardware
   * through it all along.
   *
   * And the suffix test was too narrow even for the case it was written
   * for. Measured on this machine 21 Oct: the daemon offers
   * `qwen3.6:35b-a3b`, a 35B local model whose own capability list
   * includes vision, and `minimax-m3.1-flash:cloud` - note the colon.
   * `/:.*-cloud$/` matches neither, so BOTH of the user's own models were
   * unaddressable, and the newer cloud naming would have been missed
   * anyway.
   *
   * Safe because the shapes do not overlap: every NVIDIA id has a slash,
   * and the bare Mistral names have no colon. A colon with no slash is
   * Ollama's convention and nobody else's.
   *
   * The failure the old comment feared is better now too: a daemon that
   * is not running is a refused connection, which `/model check` reports
   * as `offline` rather than as a broken model.
   */
  if (!name.includes('/') && /:/.test(name)) return 'ollama'

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
 * It was "is it a Gemini", which was true of every model offered and stopped
 * being true twice over: Google came out of the picker, and then an NVIDIA
 * vision-language model went in. Reported, reasonably: "an annoying thing is
 * that the model does not support images".
 *
 * So the catalogue answers, and `sees` is a property of the model rather
 * than of its provider - which is what it always was. Google keeps answering
 * by provider underneath, because every Gemini can see, video included
 * (measured: a three-second mp4 as a data URL came back correctly through
 * the same part shape as an image), and because a `gemini-` name typed in by
 * hand is not in the catalogue any more and must still work.
 *
 * This is asked before the paste is accepted, not after: refusing to attach
 * and saying why is a missing feature, while attaching and quietly dropping
 * it on the way out is a wrong answer to a question nobody knows was not
 * asked.
 */
/**
 * Models proved blind by the endpoint itself, learned at runtime.
 *
 * Filled by `rememberBlind` when a provider refuses an image outright, so
 * the optimistic default below costs one turn per model ever rather than
 * one turn per attempt. Module state rather than a file: it is cheap to
 * rediscover, and a model that was patched to accept images should not be
 * written off until the next release.
 */
const PROVED_BLIND = new Set<string>()

/** The endpoint said no to a picture. Do not send it one again. */
export function rememberBlind(model: string): void {
  if (model) PROVED_BLIND.add(model)
}

export function provedBlind(model: string): boolean {
  return PROVED_BLIND.has(model)
}

/** For checks, which must not inherit what an earlier case learned. */
export function forgetBlind(): void {
  PROVED_BLIND.clear()
}

/**
 * EVERY MODEL IS BORN SIGHTED, which is the opposite of how this started.
 *
 * `sees` was absent-means-no, and on 19 Oct a sweep of the whole
 * catalogue found that half the entries marked blind that way could see
 * perfectly well - gemma4 at 6/6, glm-5.3-flash at 5/6, deepseek reading
 * them slowly. Each had been quietly denied every picture, with the bytes
 * dropped on the way out and a description borrowed from another model
 * standing in for an image they could have read themselves.
 *
 * The cautious default was wrong in the expensive direction, and it was
 * wrong SILENTLY: a dropped attachment produces a plausible answer, not
 * an error, so nobody finds out.
 *
 * So the default is flipped and the cost of being wrong is paid for
 * properly instead of avoided. Sending an image to a model that cannot
 * take one is a 400 - which is what the old default existed to prevent -
 * and the turn survives it now: the client catches that refusal, records
 * the model here, and immediately retries without the picture. One turn
 * is slightly slower, once, for a model nobody has measured. Against a
 * capability silently missing for the life of the entry, that is a good
 * trade.
 *
 * `sees: false` in the catalogue still means proved blind and skips even
 * the first attempt.
 */
export function seesMedia(model: string): boolean {
  if (!model) return false
  if (provedBlind(model)) return false
  const known = CLOUD_MODELS.find((m) => m.id === model)
  if (known?.sees !== undefined) return known.sees
  return true
}

/**
 * A model that looks at the picture on behalf of one that cannot.
 *
 * Asked for directly: "is there a way it can see images without sacrificing
 * much". The two obvious answers both cost something. Switching to the
 * vision model loses three ladder rungs on every turn, including the ones
 * with no picture in them. Staying text-only loses the picture.
 *
 * This is the third: the answering model stays what it is, and when a
 * picture actually matters ONE extra call goes to the vision model, whose
 * answer comes back as text. What that costs is one call - 859ms measured,
 * on a provider with no daily cap - and it is paid only on the turns that
 * have a picture in them. What it buys is that the bytes stop being thrown
 * away.
 *
 * The honest cost is in the other direction: a description is second-hand
 * and lossy, and the model acting on it did not see the screen. So it is
 * labelled as second-hand everywhere it appears, and the control list -
 * which is first-hand, exact, and what the acting steps use - still goes
 * with it.
 *
 * Null when the model can already see, because then there is nothing to
 * borrow and the picture itself is better than any description of it.
 */
export function eyeFor(model: string): CloudModel | null {
  if (!model || seesMedia(model)) return null
  /**
   * The best EYE, which is not the best model.
   *
   * This ranked by the capability ladder, on the reasonable-sounding
   * ground that the best model should do the describing. It is the wrong
   * ladder: an eye is handed a picture and asked what is in it, and does
   * none of the reasoning the score measures. The error showed the moment
   * the catalogue got honest - deepseek was correctly marked as sighted
   * on 19 Oct, immediately outranked everything at 39/41, and would have
   * become the app's eye at ninety seconds an image, replacing one that
   * does it in 370ms.
   *
   * So: eyesight first, and speed second, both from the vision ladder.
   * An entry with `sees` and no vision score sorts last rather than
   * first - it has not been measured, and the measured ones have.
   */
  const score = (m: CloudModel): number =>
    m.vision && m.vision.of > 0 ? m.vision.clean / m.vision.of : -1
  /**
   * PREFERRING THE FREE EYE WAS TRIED ON 21 OCT AND IS NOT IN.
   *
   * The argument for it is good: the borrowed eye is an EXTRA request on
   * top of the turn it is helping with, and gemma4 is the user's own
   * Ollama account - nothing from the per-minute ceiling that the pacer,
   * the rotation and half the quota machinery exist to respect. It and
   * the VL model are both 6/6 on the vision ladder, at 600ms and 370ms,
   * so sorting on speed spends an NVIDIA request to save 230ms on the
   * one request that need not have cost anything.
   *
   * What killed it: a keyless provider is a DAEMON, and a daemon can be
   * off. `ready()` calls keyless providers ready the moment they are
   * named, because there is no key to check - so the eye would have been
   * offered with nothing configured at all, and when Ollama was not
   * running it would have returned nothing, quietly. The description
   * would simply be absent and the user would never learn why.
   *
   * That is the exact failure this file keeps being edited to remove,
   * and 230 milliseconds does not buy it. The checks said so first: two
   * of them assert that an eye on a provider which cannot answer is not
   * an eye, and they were right.
   *
   * It becomes correct the moment there is a liveness check for the
   * daemon rather than an assumption, which is a different change.
   */
  const seers = CLOUD_MODELS.filter((m) => m.sees).sort(
    (a, b) =>
      score(b) - score(a) ||
      (a.vision?.medianMs ?? Number.MAX_SAFE_INTEGER) -
        (b.vision?.medianMs ?? Number.MAX_SAFE_INTEGER)
  )
  return seers[0] ?? null
}

/**
 * The same, but only when it could actually answer right now.
 *
 * An eye on a provider with no key is not an eye, and offering one would
 * mean accepting a dropped image for a call that cannot be made. Shared so
 * the composer's decision to accept a paste and the main process's decision
 * to make the call cannot disagree - which is the bug the `keyless` flag
 * had to be invented for.
 */
export function eyeReady(model: string, configured: readonly ProviderId[]): CloudModel | null {
  const eye = eyeFor(model)
  if (!eye) return null
  return PROVIDERS[eye.provider].keyless || configured.includes(eye.provider) ? eye : null
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
     read them, because the alternative is a 400 that costs the whole turn.
     Said out loud rather than done quietly: a model handed "what is this"
     with the picture removed and no mention of it describes something
     plausible, which is worse than the refusal this avoided. */
  const sendable = vision ? folded.bytes : []
  if (!sendable.length) {
    const dropped = folded.bytes.length
      ? [folded.text, MEDIA_NOT_SENT].filter(Boolean).join(String.fromCharCode(10))
      : folded.text
    return { role, content: dropped }
  }

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

/**
 * The provider having a bad minute, which waiting a moment does fix.
 *
 * 503 was the only one of these treated as transient, and the other three
 * fell through to "returned 500: {json}" with no retry - the user was
 * handed a status code and an error object and the turn was over. That is
 * the wrong response to infrastructure, and this file already said so
 * somewhere else: the VL model's two ladder runs are in the catalogue
 * precisely because "the first run hit a 500 and a 502 from the gateway -
 * infrastructure, not the model, so those rungs are not counted as
 * failures". The bench excused them and the app did not.
 *
 * Seen here as `NVIDIA NIM returned 500: {"message":"Failed to generate
 * completions","type":"Internal Server Error","code":500}` on an ordinary
 * question, with every key healthy and nothing rate limited.
 *
 * Retried rather than reported, because a gateway blip is the one failure
 * where asking again is both cheap and likely to work. Deliberately NOT
 * including 500-class errors from the 4xx range: a malformed request will
 * be malformed again, and 400 and 404 still mean "try a different model".
 */
export const GATEWAY_TROUBLE = new Set([500, 502, 503, 504])

export function classifyLimit(
  status: number,
  body: string,
  model: string,
  /** The per-minute request allowance the provider reported, if it did. */
  limitPerMinute?: string | null
): LimitVerdict {
  if (status !== 429 && !GATEWAY_TROUBLE.has(status)) {
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

  if (GATEWAY_TROUBLE.has(status)) {
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
  /* Both pointed at nemotron-3-super until it was withdrawn on 21 Oct,
     which would have made the FALLBACK - the thing reached when the
     first choice already failed - a 404. Ultra is quicker than it was
     (1,006ms against 6,264) and six rungs better. */
  flash: 'nvidia/nemotron-3-ultra-550b-a55b',
  fast: 'nvidia/nemotron-3-ultra-550b-a55b',
  thinker: 'deepseek-ai/deepseek-v4.1-flash',
  deep: 'deepseek-ai/deepseek-v4.1-flash'
}

/* ------------------------------------------------------------- the thinking */

/**
 * THERE IS NO THINKING ALLOWANCE ANY MORE, and nothing to add it to.
 *
 * It was 1,024 tokens of headroom on top of a hand-picked output cap,
 * because reasoning is spent out of max_tokens before a single visible word
 * is produced - measured on gemini-3.5-flash, where asking for one sentence
 * with max_tokens 200 spent 188 on thinking and emitted eight words:
 * "A tray application is a computer program that".
 *
 * That was the right fix for a cap of 384. With the cap gone - see
 * `maxTokensFor`, which now sends the room that is left rather than a number
 * - reasoning and the answer come out of the same window, which is what they
 * were always doing, and there is nothing to make an allowance against.
 */

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
  /**
   * OLLAMA TAKES 'none' AND IGNORES EVERYTHING ELSE.
   *
   * This fell through to 'low', which is not a smaller amount of
   * thinking here - it is no effect at all. Measured 21 Oct on
   * qwen3.6:35b-a3b, a 35B reasoning model running on this machine,
   * asked to say one word:
   *
   *   nothing sent          19,907ms   138 tokens   542 chars of thought
   *   think: false          19,907ms   138 tokens   542 chars   (ignored)
   *   chat_template_kwargs  18,844ms   138 tokens   542 chars   (ignored)
   *   reasoning_effort low  25,520ms   161 tokens   640 chars   (ignored)
   *   reasoning_effort none    772ms     2 tokens   none
   *
   * Twenty-five times quicker for the same answer, and the two switches
   * that work on the hosted providers - Ollama's own `think` flag and
   * NVIDIA's chat_template_kwargs - both do nothing here. Which is the
   * whole argument for `/nothink` taking a different route per provider
   * rather than one flag sent everywhere and hoped over.
   */
  if (provider === 'ollama') return 'none'
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
 * THE ANSWER GETS THE ROOM THAT IS LEFT. It is not given a budget.
 *
 * Asked for in one line, under a screenshot of an answer that stopped
 * mid-sentence: "don't add a response limit - it can take as much time as it
 * wants unless an issue is detected."
 *
 * It had one, and the number was picked by hand: 4,000 tokens, plus 1,024 of
 * headroom when reasoning was on, from a note reasoning about a 13 tok/s
 * local model talking for four minutes. Both of those facts are three
 * generations of model old, and the cap had stopped meaning "this is enough
 * for an answer" and started meaning "this is where your answer gets cut".
 *
 * So nothing here chooses a length. What is sent is the window, less what
 * the request itself takes - the only ceiling that is a fact rather than a
 * preference, and the one the provider would impose anyway. An answer can
 * now only be cut off by running out of context, which is a real condition
 * with a real fix (`/compact`, or a new chat), and which the panel already
 * says plainly when it happens.
 *
 * Sent rather than omitted, because omitting it is not "no limit": these
 * endpoints are OpenAI-shaped, and an absent max_tokens means the server's
 * own default, which on some of them is 1,024 and would make answers
 * shorter. The floor is for the case where the prompt has eaten the window:
 * compaction should have run long before, and half an answer still beats
 * asking for zero tokens.
 */
export const LEAST_ROOM = 1024

export function maxTokensFor(prompt: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return LEAST_ROOM
  const taken = Number.isFinite(prompt) ? Math.max(0, prompt) : 0
  return Math.max(LEAST_ROOM, Math.floor(limit - taken))
}

/**
 * What the request is about to cost, near enough to size the answer by.
 *
 * The same four-characters-to-a-token estimate as the meter, over the
 * messages as they will actually go out - which is the only count available
 * before the provider replies with its own.
 */
export function requestTokens(messages: readonly WireMessage[]): number {
  let chars = 0
  let images = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
      continue
    }
    for (const part of m.content) {
      if (part.type === 'text') chars += part.text?.length ?? 0
      else images++
    }
  }
  return estimateTokens(chars, images)
}

/* --------------------------------------------------------------- the key itself */

/** Never log or display a key in full, including in an error. */
export function maskKey(raw: string): string {
  const key = (raw ?? '').trim()
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
