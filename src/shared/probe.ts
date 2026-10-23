/**
 * Which models actually answer, asked rather than assumed.
 *
 * The picker offers thirteen entries and a row in a list proves nothing. The
 * id can be withdrawn, the key can be refused, the day's allowance can be
 * gone, the request shape can be wrong for that provider - and all four look
 * identical from the picker: a name you choose, and then a turn you lose.
 *
 * `scripts/verify-models.mjs` has answered this question since the catalogue
 * existed, but only for whoever is holding the repo: it reads keys out of
 * `.env`, streams, and prints to a terminal. The person who needs the answer
 * is the one in the panel deciding what to switch to, and they have no .env
 * and no terminal. This is that check, inside the app, against the keys the
 * app actually has.
 *
 * WHAT COUNTS AS WORKING IS THE WHOLE DESIGN HERE, and it is not "HTTP 200".
 * The script learned that the expensive way: nemotron-3-ultra returned 200
 * with an empty stream and was reported ok, and asked again a minute later
 * the same model said 503 "Service temporarily overloaded". An answer with
 * no words in it loses the turn exactly as completely as a 404 does. So an
 * empty reply is its own verdict, and it is not a passing one.
 *
 * The verdicts are split by WHOSE PROBLEM THEY ARE, because that is what the
 * person is deciding between:
 *
 *   ok / slow     the model works; slow is still a choice, just an informed one
 *   empty         it answered nothing: the model is unwell right now
 *   missing       the id is gone or wrong - the catalogue needs editing
 *   refused       the key is bad - /key fixes it
 *   limited       quota, not health: this model is fine and will be back
 *   timeout       no answer inside the window; says nothing about tomorrow
 *   nokey         never asked, nothing spent
 *   error         the network, or something unclassified
 *
 * Pure, so every verdict and every line of the report can be driven from a
 * check without a key, a network or a clock.
 */
import {
  CLOUD_MODELS,
  GIVE_UP_AFTER_MS,
  UNUSABLY_SLOW_MS,
  seesMedia,
  type Fresh,
  type Latencies
} from './cloud'
import {
  FAST_ENOUGH_MS,
  SLOWNESS_COST,
  balanceScore,
  rankedModels,
  type Ordering
} from './order'

/** What a probe concluded about one model. */
export type ProbeState =
  | 'ok'
  | 'slow'
  /**
   * It worked on some runs and not others, which one run cannot see.
   *
   * The most useful verdict here and the reason asking twice is worth the
   * requests. nemotron-3-ultra answered one probe and 503'd the next; a
   * single run would have called it working or called it dead, and both
   * would have been wrong in a way that costs a turn later. A model that
   * fails half the time is a different thing from one that fails, and the
   * user is entitled to decide about it knowing that.
   */
  | 'flaky'
  | 'empty'
  | 'missing'
  | 'refused'
  | 'limited'
  | 'timeout'
  | 'nokey'
  /**
   * The machine could not reach the provider at all.
   *
   * Kept apart from `error` because it is not a fact about the model and
   * must not read as one. With the network down every model answers the
   * same way, and the report became ten rows of "Could not reach the
   * provider" under a headline saying 0 of 10 answered - which is true,
   * and says the catalogue is broken when the wifi is.
   */
  | 'offline'
  | 'error'

export interface ProbeResult {
  /** The model id, which is what `/model <id>` takes. */
  model: string
  /** The catalogue's label, for a report a person reads. */
  label: string
  /** 'nvidia', 'ollama', … or '' for an id that routes nowhere. */
  provider: string
  state: ProbeState
  /** Round trip in ms, or 0 when nothing was sent. */
  ms: number
  /** The first few words it said, so "working" can be checked rather than trusted. */
  said: string
  /** Why, when the state needs explaining. Never carries key material. */
  why: string
  /** How many times it was asked. 1 is a sample; 2 or more is a measurement. */
  runs?: number
  /** Every run's time, slowest last, so a spread is visible rather than averaged away. */
  times?: number[]
  /** The distinct verdicts seen, when the runs did not agree. */
  seen?: ProbeState[]
  /**
   * Whether it read a picture with a known answer.
   *
   * Undefined when it was not asked - a model that could not answer at
   * all has nothing to prove about its eyesight, and one the catalogue
   * records as blind is not worth a request to confirm.
   *
   * The question is the hardest single rung rather than the easiest: a
   * four-digit number inside one of two coloured boxes, which is the
   * shape of every real question about a screen. A model that passes
   * red-versus-blue and cannot do this is marked as having eyes and will
   * fail the only job it gets.
   */
  eyes?: boolean
}

/**
 * How many times to ask each model, when nobody says.
 *
 * Two, which is this codebase's own standard for the difference between a
 * sample and a measurement - `Measured.runs` exists because ten rungs at
 * one run apiece put nemotron-3-ultra at 10/10 and the same ten at two
 * runs put it at 9/10.
 *
 * It was one until there were two accounts to spread the cost over. The
 * honest trade is stated where the command is run: two runs is twice the
 * requests and twice the wait, and the wait is the part that bites, since
 * the slowest models here take about a hundred seconds each.
 */
export const DEFAULT_RUNS = 2
export const MAX_RUNS = 5

/**
 * Past this, a working model is worth calling slow.
 *
 * Grounded in what this machine has measured rather than chosen as a round
 * number - and re-grounded on 19 Oct, when the probe started carrying the
 * real preamble instead of four words. The old figures were the provider's
 * queue with prompt processing left out, and they were not the times
 * anyone experienced. Both sets, for the same six models:
 *
 *                              four words     14.6k preamble
 *   gemma4:31b-cloud               855ms            1,781ms
 *   glm-5.3-flash                2,368ms            4,577ms
 *   nemotron-3-super               741ms            6,264ms
 *   nemotron-3.5-super-vl        4,128ms           10,923ms
 *   deepseek-v4.1-flash        103,204ms          112,211ms
 *   glm-5.3                    104,315ms          timed out
 *
 * Note nemotron-3-super: second quickest on the toy prompt and fourth on a
 * real one. Prompt processing is most of the cost for the quick models and
 * almost none of it for the slow ones, so the toy figures did not even
 * preserve the ORDER - which is why a recommendation built on them was
 * worse than no recommendation at all.
 *
 * 12s rather than 8s, and the extra four seconds come from the user rather
 * than from the data: asked about the VL model at around ten seconds, the
 * verdict was "it's not that bad". A threshold that called their own
 * working choice slow would be measuring something other than annoyance.
 */
export const SLOW_MS = 12_000

/**
 * How long a probe waits before it stops being evidence about the model.
 *
 * EXACTLY AS PATIENT AS A REAL TURN, which is the only threshold that makes
 * the verdict mean anything: "timed out" then says "a turn you asked would
 * have been given up on too", rather than "my own stopwatch was shorter than
 * the app's".
 *
 * This was 45s for one run of the check, and the first real probe caught it
 * out: deepseek-v4.1-flash - the default model - answered in 103,204ms, and
 * glm-5.3 in 104,315ms. At 45s both would have been reported dead while they
 * were working, which is a worse failure than the one this file exists to
 * prevent, because it would have sent someone off their best model.
 */
export const PROBE_TIMEOUT_MS = GIVE_UP_AFTER_MS

/**
 * The verdict for a reply that arrived, from the status and what it said.
 *
 * Status first and content second, in that order, because a provider that
 * puts an error in a 200 body is commoner than one that returns an empty
 * 500. `content` is what the model actually said, already trimmed.
 */
export function verdictFor(status: number, content: string, ms: number): ProbeState {
  if (status === 401 || status === 403) return 'refused'
  if (status === 429) return 'limited'
  if (status === 404 || status === 400) return 'missing'
  if (status < 200 || status >= 300) return 'error'
  /* A 200 that said nothing. See the header: this is the verdict the whole
     file exists for, and it must never collapse into 'ok'. */
  if (!content) return 'empty'
  return ms >= SLOW_MS ? 'slow' : 'ok'
}

/** Did this probe spend a request? Used to say what the check cost. */
export function spent(state: ProbeState): boolean {
  /* Neither costs a request: one was never sent, and the other never
     arrived. Counting them would overstate what the check cost on the
     one run where it cost nothing at all. */
  return state !== 'nokey' && state !== 'offline'
}

/**
 * Would picking this model right now get an answer?
 *
 * `flaky` is deliberately NOT usable. It answered at least once, so there
 * is a case for counting it - and the case is wrong: the question this
 * report answers is "what should I switch to", and the honest answer about
 * a model that fails half the time is not "yes".
 */
export function usable(state: ProbeState): boolean {
  return state === 'ok' || state === 'slow'
}

/* ----------------------------------------------------------- many runs */

/** The middle time, which a single slow outlier cannot drag. */
function median(times: readonly number[]): number {
  if (!times.length) return 0
  const sorted = [...times].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Several runs of one model, as one verdict.
 *
 * THE DISAGREEMENT IS THE POINT, so it survives rather than being averaged
 * into a number that hides it. Three outcomes:
 *
 *   every run worked      -> ok or slow, on the MEDIAN time, not the best:
 *                            the quickest of two runs is a sales pitch
 *   every run failed      -> that failure, with how many times it was seen
 *   they disagreed        -> flaky, which no single run could have found
 *
 * A model that never answered keeps its own verdict rather than becoming
 * flaky, because "refused twice" and "worked once, refused once" need
 * different things done about them.
 *
 * Returns the single run unchanged when there is only one, so a one-run
 * check reads exactly as it did before this existed.
 */
export function combineRuns(runs: readonly ProbeResult[]): ProbeResult {
  if (!runs.length) throw new Error('combineRuns needs at least one run')
  if (runs.length === 1) return { ...runs[0], runs: 1, times: [runs[0].ms] }

  const last = runs[runs.length - 1]
  const states = runs.map((r) => r.state)
  const distinct = [...new Set(states)]
  const times = runs.map((r) => r.ms).filter((ms) => ms > 0)
  const worked = runs.filter((r) => usable(r.state))

  /* Nothing was asked, so there is nothing to disagree about. */
  if (distinct.length === 1 && distinct[0] === 'nokey') {
    return { ...last, runs: runs.length, times: [] }
  }

  if (worked.length && worked.length < runs.length) {
    const bad = runs.find((r) => !usable(r.state))
    return {
      ...last,
      state: 'flaky',
      ms: median(worked.map((r) => r.ms)),
      runs: runs.length,
      times,
      seen: distinct,
      why:
        `answered ${worked.length} of ${runs.length} times` +
        (bad ? `; otherwise ${bad.state}${bad.why ? ` (${bad.why})` : ''}` : '')
    }
  }

  if (worked.length === runs.length) {
    const mid = median(times)
    return {
      ...last,
      state: mid >= SLOW_MS ? 'slow' : 'ok',
      ms: mid,
      runs: runs.length,
      times,
      why: ''
    }
  }

  /* Every run failed. If they failed differently, say so rather than
     reporting the last one as though it were the whole story. */
  return {
    ...last,
    ms: median(times),
    runs: runs.length,
    times,
    ...(distinct.length > 1 ? { seen: distinct } : {})
  }
}

/* ------------------------------------------------------------ the report */

/**
 * The spread, when there was more than one run and they differed.
 *
 * Shown rather than hidden behind the median, because a model that
 * answered in 900ms and then 104,000ms is not a 52-second model - it is
 * two different experiences and the user is choosing between them.
 */
function spread(r: ProbeResult): string {
  const times = r.times ?? []
  if (times.length < 2) return ''
  const low = Math.min(...times)
  const high = Math.max(...times)
  /* Within a fifth of each other is one number told twice. */
  if (high - low < low / 5) return ''
  return ` (${low.toLocaleString()}–${high.toLocaleString()}ms over ${times.length})`
}

/**
 * What the picture test found, in two words or none.
 *
 * Absent when it was not asked, which is most of the time: a model that
 * could not answer has nothing to prove, and one already recorded blind
 * is not worth the request.
 */
function eyesOf(r: ProbeResult): string {
  if (r.eyes === undefined) return ''
  return r.eyes ? ' · reads images' : ' · cannot read images'
}

/** One line per model, in the order a person scans them. */
function row(r: ProbeResult): string {
  const ms = r.ms ? ` — ${r.ms.toLocaleString()}ms` : ''
  switch (r.state) {
    case 'ok':
      return `- \`${r.model}\`${ms}${spread(r)}${eyesOf(r)}`
    case 'slow':
      return `- \`${r.model}\`${ms}${spread(r)}${eyesOf(r)} — **slow**`
    case 'flaky':
      return `- \`${r.model}\` — **${r.why || 'did not answer every time'}**${ms ? `, ${r.ms.toLocaleString()}ms when it did` : ''}`
    case 'empty':
      return `- \`${r.model}\` — **answered nothing**${ms} · usually overloaded, try later`
    case 'missing':
      return `- \`${r.model}\` — **not there**${r.why ? `: ${r.why}` : ''}`
    case 'refused':
      return `- \`${r.model}\` — **key refused**${r.why ? `: ${r.why}` : ''}`
    case 'limited':
      return `- \`${r.model}\` — rate limited, not broken${r.why ? ` (${r.why})` : ''}`
    case 'timeout':
      return `- \`${r.model}\` — **no answer in ${Math.round(PROBE_TIMEOUT_MS / 1000)}s**`
    case 'nokey':
      return `- \`${r.model}\` — no ${r.provider || 'provider'} key`
    case 'offline':
      return `- \`${r.model}\` — not reached`
    default:
      return `- \`${r.model}\` — ${r.why || 'failed'}`
  }
}

/* ------------------------------------------------- which one to use */

/*
 * THE TRADE BETWEEN SMART AND QUICK NOW LIVES IN ONE PLACE.
 *
 * Both constants and the arithmetic they feed moved to @shared/order,
 * because the picker grew a tab that makes exactly this judgement and two
 * formulas doing it on one screen is a disagreement waiting to be
 * screenshotted. They are re-exported rather than re-explained: the
 * reasoning for 0.08 a tenfold, and for not charging anything under two
 * seconds, is written out beside them there.
 */
export { SLOWNESS_COST, FAST_ENOUGH_MS }

/**
 * Past this, no ladder score redeems it, and the log penalty is too kind.
 *
 * 0.08 per tenfold is right across the range people actually choose in and
 * wrong at the extreme: on the real figures deepseek at 112 seconds scored
 * within 0.008 of the VL model at 11 seconds, because ten times slower
 * costs three rungs and deepseek is three rungs better. The arithmetic
 * working exactly as designed and arriving somewhere absurd - nobody waits
 * two minutes for a thing that lives in the system tray.
 *
 * So there is a floor under the RECOMMENDATION, and it sits in an empty
 * part of the measurements: nothing here has ever landed between 11
 * seconds and 112. A model past it is still listed in the report with its
 * real time, because it works and someone may want it. It is just never
 * the suggestion.
 *
 * THE SAME FLOOR THE PICKER USES, and now by construction rather than by
 * coincidence: this was its own `30_000` beside cloud.UNUSABLY_SLOW_MS,
 * two literals for one rule, and the day one of them moved the report
 * would have recommended a model the list had already given up on.
 */
export const TOO_SLOW_TO_SUGGEST_MS = UNUSABLY_SLOW_MS

/** Ladder share for a model, or null when it has never been measured here. */
function smartness(model: string): number | null {
  const m = CLOUD_MODELS.find((c) => c.id === model)?.measured
  return m && m.of > 0 ? m.clean / m.of : null
}

export interface Pick {
  model: string
  /** Ladder share and the time just measured, for the sentence. */
  share: number
  ms: number
  score: number
  sees: boolean
}

/**
 * The best balance of smart and quick, out of what actually answered.
 *
 * Scored on the ladder figure from the catalogue and the time measured on
 * THIS run - not the catalogue's own latency, which is what went stale and
 * had the picker promising 1.3s for a model that takes a hundred seconds.
 * The score is a published number; the speed is what just happened.
 *
 * Only models that answered every run are eligible. A flaky one cannot be
 * recommended whatever it scores: "use this, it works about half the time"
 * is not a recommendation.
 */
export function recommend(results: readonly ProbeResult[]): Pick[] {
  return results
    .filter((r) => usable(r.state) && r.ms > 0 && r.ms <= TOO_SLOW_TO_SUGGEST_MS)
    .map((r) => {
      const share = smartness(r.model)
      if (share === null) return null
      return {
        model: r.model,
        share,
        ms: r.ms,
        /* The picker's balanced tab, scored on the time this run just
           measured rather than on the catalogue's. Same function, so the
           report cannot recommend one model while the list it sends the
           user to puts another first. */
        score: balanceScore(share, r.ms),
        /*
         * Asked the same way the WIRE asks it.
         *
         * This read `sees === true`, which was right while absent meant
         * blind and became a disagreement the day the default flipped:
         * nemotron-3-ultra has no `sees` entry, so wireMessage sends it
         * pictures while the recommendation called it blind and offered
         * an eye beside it that it does not need. One question, one
         * answer.
         */
        sees: seesMedia(r.model)
      }
    })
    .filter((p): p is Pick => p !== null)
    .sort((a, b) => b.score - a.score)
}

/** The recommendation, as the last thing the report says. */
export function recommendLines(results: readonly ProbeResult[], current = ''): string[] {
  const ranked = recommend(results)
  if (!ranked.length) return []
  const best = ranked[0]
  const seconds = best.ms >= 10_000 ? `${Math.round(best.ms / 1000)}s` : `${(best.ms / 1000).toFixed(1)}s`

  /*
   * A LABEL AND THE FACTS, not a sentence explaining itself.
   *
   * This read "**Use `x`.** Best balance of the two: 93% of the ladder at
   * 4.6s." - which says in sixteen words what two words and two numbers
   * say, and buries the one thing being looked for. Asked for plainly:
   * "instead of the best recommended model is X, say recommended: X".
   *
   * The numbers stay because they are the argument, and the argument is
   * one glance long: a score and a time.
   */
  const lines = [
    '',
    best.model === current
      ? `**Recommended:** \`${best.model}\` — ${Math.round(best.share * 100)}%, ${seconds} · already on it`
      : `**Recommended:** \`${best.model}\` — ${Math.round(best.share * 100)}%, ${seconds}` +
        '  ·  `/model ' + best.model + '`'
  ]

  /*
   * Vision is the axis the score cannot see.
   *
   * The ladder measures reasoning and the probe measures latency, and
   * neither notices that one model can read a picture and the others
   * cannot. For someone who works from screenshots that is often the
   * deciding property, so when the winner is blind and a seeing model
   * answered too, the alternative is named rather than buried.
   */
  if (!best.sees) {
    const seeing = ranked.find((p) => p.sees)
    if (seeing) {
      const its = seeing.ms >= 10_000 ? `${Math.round(seeing.ms / 1000)}s` : `${(seeing.ms / 1000).toFixed(1)}s`
      lines.push(
        `**For screenshots:** \`${seeing.model}\` — ` +
          `${Math.round(seeing.share * 100)}%, ${its} (the pick above is blind)`
      )
    }
  }
  return lines
}

/**
 * The times this run measured, in the shape the picker ranks by.
 *
 * Asked for in one sentence: "when it does this it should change the
 * ranking in /model". It did not, and the gap was wide enough to see on a
 * single screen - the 22 Oct check recommended deepseek at 6.2s while the
 * picker three keystrokes away still had it eighth on a 112.2s figure from
 * the day before, and had the VL model second on 10.9s after measuring it
 * at 40.4s. See cloud.Fresh.
 *
 * What is and is not recorded, which is the whole care in this function:
 *
 *   nokey, offline   never reached the provider, so they are not evidence
 *                    about the model. Recording a zero would rank a model
 *                    bottom for the crime of the wifi being off.
 *   limited          a 429 is the account's allowance, not the model's
 *                    speed, and the round trip to a refusal is not a time
 *                    anything should be ranked on.
 *   a hand-typed id  nothing in the catalogue to re-rank.
 *   everything else  recorded, including the failures: `ok` false is the
 *                    useful half of the news.
 */
export function freshLatencies(results: readonly ProbeResult[], on: string): Record<string, Fresh> {
  const out: Record<string, Fresh> = {}
  for (const r of results) {
    if (r.state === 'nokey' || r.state === 'offline' || r.state === 'limited') continue
    if (!CLOUD_MODELS.some((m) => m.id === r.model)) continue
    const ok = usable(r.state)
    /* A pass with no time on it is a bookkeeping slip, not a measurement,
       and would put the model top of the order at zero milliseconds. */
    if (ok && r.ms <= 0) continue
    out[r.model] = { ms: r.ms, runs: Math.max(1, r.runs ?? 1), on, ok }
  }
  return out
}

/**
 * What the new times did to the list, said out loud.
 *
 * A check that silently rewrites the order is a check the user has to go
 * and verify by opening the picker. One line, and only when something
 * actually moved - "nothing changed" is worth knowing too, but not worth a
 * line every time, since that is the common case on a healthy day.
 */
export function rerankLines(fresh: Latencies, ordering?: Ordering): string[] {
  const ids = Object.keys(fresh)
  if (!ids.length) return []

  /* The order the user is actually looking at, not the default one.
     Someone on the smartest tab has asked for a list these times barely
     move, and telling them their list was re-ranked when it was not is
     the kind of small untruth that makes the rest of the report
     unbelievable. */
  const before = new Map(
    rankedModels(CLOUD_MODELS, {}, ordering).map(({ model, rank }) => [model.id, rank])
  )
  const after = rankedModels(CLOUD_MODELS, fresh, ordering)
  const moved = after.filter(({ model, rank }) => rank !== null && before.get(model.id) !== rank)
  if (!moved.length) return []

  const first = after.find((r) => r.rank === 1)
  if (!first) return []
  const was = before.get(first.model.id)
  const rows = `${moved.length} row${moved.length === 1 ? '' : 's'} moved`
  return [
    '',
    was === 1
      ? `\`/model\` re-ranked on these times — ${rows}, **${first.model.label}** still first.`
      : `\`/model\` re-ranked on these times — **${first.model.label}** is now first` +
        (was ? ` (was #${was})` : '') +
        `, ${rows}.`
  ]
}

/**
 * The whole report, as markdown the panel already knows how to print.
 *
 * Working models first and named with their time, because the question
 * behind this is usually "what should I switch to" rather than "what is
 * broken". The broken ones follow, grouped so one dead key does not read as
 * five dead models.
 *
 * `/model <id>` is spelled out at the end on purpose: a list of ids with no
 * way to act on them is a diagnostic, and this is meant to be a decision.
 */
export function probeLines(
  results: readonly ProbeResult[],
  current = '',
  fresh: Latencies = {},
  /** Which tab of the picker the user has open. See rerankLines. */
  ordering?: Ordering
): string[] {
  if (!results.length) return ['Nothing to check: the catalogue is empty.']

  const working = results.filter((r) => usable(r.state))
  const flaky = results.filter((r) => r.state === 'flaky')
  const broken = results.filter(
    (r) => !usable(r.state) && r.state !== 'nokey' && r.state !== 'flaky'
  )
  const unasked = results.filter((r) => r.state === 'nokey')
  /* Runs, not models: two runs of six models is twelve requests, and the
     line is there to say what the check cost. */
  const asked = results
    .filter((r) => spent(r.state))
    .reduce((n, r) => n + Math.max(1, r.runs ?? 1), 0)
  const runs = Math.max(...results.map((r) => r.runs ?? 1), 1)

  /*
   * NOTHING WAS REACHED, SO NOTHING WAS LEARNED.
   *
   * Said once, first, and on its own. With the connection down every
   * model fails identically, and the ordinary report then says "0/10
   * answered" over ten rows of the same sentence - which reads as a
   * catalogue full of broken models rather than as a machine that is
   * offline. The one useful fact is the one it was burying.
   *
   * Checked against every model rather than some: one unreachable
   * provider among several is a real finding about that provider, and
   * belongs in the list with the others.
   */
  const reachable = results.filter((r) => r.state !== 'nokey')
  if (reachable.length && reachable.every((r) => r.state === 'offline')) {
    return [
      '**No connection.** None of the models could be reached, so nothing was tested.',
      'Nothing was spent. Try again once you are back online.'
    ]
  }

  /* A headline, not a paragraph: counts first, caveat only when there is
     one worth making. */
  const lines: string[] = [
    `**${working.length}/${results.length} answered${runs > 1 ? ' every time' : ''}** · ` +
      `${asked} request${asked === 1 ? '' : 's'}` +
      (runs > 1 ? `, ${runs} runs each` : ' · one run each, so a sample not a measurement')
  ]

  if (working.length) {
    /* Quickest first: the number is the reason this list is ordered at all. */
    const sorted = [...working].sort((a, b) => a.ms - b.ms)
    lines.push('', '**Working**', ...sorted.map(row))
  }

  /*
   * Between the two groups, because that is where it belongs: not
   * something to switch to, not something to write off. This group only
   * ever has anything in it when the check ran more than once, which is
   * the argument for running it more than once.
   */
  if (flaky.length) {
    lines.push('', '**Sometimes**', ...flaky.map(row))
  }

  if (broken.length) {
    lines.push('', '**Not working**', ...broken.map(row))
  }

  if (unasked.length) {
    lines.push('', '**Not asked**', ...unasked.map(row))
  }

  /*
   * Only when it is actually in trouble. Telling someone their model works
   * every time they run this is noise; telling them the one they are
   * answering with is the one that just failed is the point.
   */
  const mine = results.find((r) => r.model === current)
  if (mine && !usable(mine.state)) {
    lines.push('', `**Your model is in that list.** \`${current}\` — switch below.`)
  }

  /* The point of the whole exercise, last so it reads as the conclusion
     rather than as a header. It replaces the bare "switch with /model
     <id>", which told the reader how to act and not what to do.
     
     Not always, though: a model that is not in the catalogue has no ladder
     score to weigh, so a run of hand-typed ids produces no pick at all -
     and a report that then ends without saying how to change anything is
     worse than the bare line it replaced. */
  const advice = recommendLines(results, current)
  if (advice.length) lines.push(...advice)
  else if (working.length) lines.push('', 'Switch with `/model <id>`.')

  /* After the recommendation, because it is the consequence of it: the
     suggestion says what to use and this says the list now agrees. */
  lines.push(...rerankLines(fresh, ordering))

  return lines
}
