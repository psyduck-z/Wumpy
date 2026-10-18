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
import { GIVE_UP_AFTER_MS } from './cloud'

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
 * Grounded in what this machine has measured for a short answer rather than
 * chosen as a round number. Measured 18 Oct 2026, to the first word:
 *
 *   741ms     nemotron-3-super-120b
 *   855ms     gemma4:31b-cloud, with no key at all
 *   2,368ms   glm-5.3-flash
 *   4,128ms   nemotron-3.5-super-vl-120b
 *   103,204ms deepseek-v4.1-flash
 *   104,315ms glm-5.3
 *
 * That is not a gradient, it is two populations with two orders of magnitude
 * between them, and the threshold sits in the empty middle. Nothing has ever
 * been measured here between 5s and 100s.
 *
 * A probe asks for a handful of tokens, so this is close to pure latency -
 * a real turn generating four hundred takes proportionally longer and that
 * is not what is being judged here.
 */
export const SLOW_MS = 8_000

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
  return state !== 'nokey'
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

/** One line per model, in the order a person scans them. */
function row(r: ProbeResult): string {
  const ms = r.ms ? ` — ${r.ms.toLocaleString()}ms` : ''
  switch (r.state) {
    case 'ok':
      return `- \`${r.model}\`${ms}${spread(r)}`
    case 'slow':
      return `- \`${r.model}\`${ms}${spread(r)} — **slow**`
    case 'flaky':
      return `- \`${r.model}\` — **${r.why || 'did not answer every time'}**${ms ? `, ${r.ms.toLocaleString()}ms when it did` : ''}`
    case 'empty':
      return `- \`${r.model}\` — **answered nothing**${ms}. Usually an overloaded model; worth asking again later.`
    case 'missing':
      return `- \`${r.model}\` — **not there**${r.why ? `: ${r.why}` : ''}`
    case 'refused':
      return `- \`${r.model}\` — **key refused**${r.why ? `: ${r.why}` : ''}`
    case 'limited':
      return `- \`${r.model}\` — rate limited, so the model is fine${r.why ? ` (${r.why})` : ''}`
    case 'timeout':
      return `- \`${r.model}\` — **no answer in ${Math.round(PROBE_TIMEOUT_MS / 1000)}s**`
    case 'nokey':
      return `- \`${r.model}\` — no ${r.provider || 'provider'} key, so it was not asked`
    default:
      return `- \`${r.model}\` — ${r.why || 'failed'}`
  }
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
export function probeLines(results: readonly ProbeResult[], current = ''): string[] {
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

  const lines: string[] = [
    `**${working.length} of ${results.length} models answered${runs > 1 ? ' every time' : ''}.** ` +
      `${asked} request${asked === 1 ? '' : 's'} spent asking` +
      (runs > 1 ? `, ${runs} per model.` : '.') +
      /* Said out loud, because the whole difference between this and the
         old one-run check is the standing of the answer. */
      (runs > 1 ? '' : ' One run each, so this is a sample rather than a measurement.')
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
    lines.push('', '**Unreliable — answered sometimes**', ...flaky.map(row))
  }

  if (broken.length) {
    lines.push('', '**Not working right now**', ...broken.map(row))
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
    lines.push(
      '',
      `You are set to \`${current}\`, which is in the list above. ` +
        'Switch with `/model <id>`, or open the picker with `/model`.'
    )
  } else if (working.length) {
    lines.push('', 'Switch with `/model <id>`.')
  }

  return lines
}
