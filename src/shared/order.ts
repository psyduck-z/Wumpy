/**
 * Three ways to rank the same catalogue, and which one is the advice.
 *
 * Asked for in these words: "add different categories, for example the
 * smartness, so it ranks which ones are smartest... one of them is on
 * smartness, one is on speed, and one of them is balanced. So balance is
 * basically the recommended one."
 *
 * The picker has always had exactly one order and it was a compromise
 * nobody chose: score first, speed as a tie-break, with a floor under
 * anything too slow to sit through. That is a reasonable default and a bad
 * only option, because the two numbers behind it answer different
 * questions. "Which of these is cleverest" and "which of these answers
 * before I lose the thread" have different winners here - 39/41 at a
 * hundred and twelve seconds against 38/42 at one - and the list was
 * quietly averaging them without saying so.
 *
 * So the average becomes one tab of three, and it says it is the
 * recommendation rather than pretending to be the only reading.
 *
 * THE TWO NUMBERS ARE NOT MEASURED THE SAME WAY and every caption here
 * says so. The ladder score is run by hand, costs hours, and sits in the
 * catalogue with the date on it. The latency is re-measured by `/model
 * check` and again by the hourly ranker, on this machine, today. A tab
 * that sorted on "smartness" while implying it was as fresh as the clock
 * would be the same kind of lie this file's own history is full of.
 *
 * Pure, and the arithmetic is shared with the recommendation at the end of
 * `/model check` rather than written twice - see balanceScore. Two
 * functions ranking models by different formulas on the same screen is the
 * bug this module exists to not have.
 */
import type { CloudModel, Latencies } from './cloud'
import { CLOUD_MODELS, UNUSABLY_SLOW_MS, secs } from './cloud'

/** Which question the list is answering. */
export type Ordering = 'balanced' | 'smarts' | 'speed'

/**
 * The one somebody gets without choosing.
 *
 * Balanced, because it is the only one of the three that cannot be badly
 * wrong: the smartest list will hand a first-timer a model that takes two
 * minutes, and the fastest list will hand them one that gets twenty of
 * forty-two rungs wrong.
 */
export const DEFAULT_ORDERING: Ordering = 'balanced'

export function isOrdering(value: unknown): value is Ordering {
  return value === 'balanced' || value === 'smarts' || value === 'speed'
}

/**
 * How much a tenfold slowdown is allowed to cost, in ladder share.
 *
 * The two numbers being traded are not on the same scale and it matters:
 * the ladder shares sit between 0.40 and 0.95, a band of half a rung's
 * worth per model, while the latencies run from 1,006ms to 120,000ms - a
 * factor of 120. Added together raw, speed decides everything and the
 * score is decoration.
 *
 * So speed is charged on a log scale and at a deliberately gentle rate.
 * 0.08 per tenfold means a model ten times slower has to be about three
 * ladder rungs better to make up for it, and a hundred times slower about
 * six. That is "smartness slightly ahead", which is what was asked for:
 * fast enough wins ties, and nothing else.
 *
 * Lived in probe.ts, where it scored the recommendation at the end of
 * `/model check`, and it is here now because the picker's balanced tab is
 * the same judgement made twice on one screen. probe.ts imports it back.
 */
export const SLOWNESS_COST = 0.08

/**
 * Under this, speed stops being a differentiator at all.
 *
 * 2s, because with the real preamble nothing is quicker than 1s and the
 * four quickest are inside a second of each other. A floor below the
 * fastest thing measured charges every model a penalty and compares them
 * on a scale that starts off the end of the data.
 */
export const FAST_ENOUGH_MS = 2_000

/**
 * One model's standing on the balanced tab: ladder share, less the cost of
 * being slow.
 *
 * Measured against the real catalogue this lands where a person would.
 * Nemotron Ultra at 38/42 and one second beats DeepSeek at 39/41 and a
 * hundred and twelve, because two orders of magnitude is not worth one
 * rung - and Lightning at 22/42 and 1.3s loses to the VL model at 38/42
 * and eleven seconds, because a fifth of a second saved is not worth
 * sixteen rungs. Both of those are the judgement this whole feature
 * exists to make, and they fall out of one line of arithmetic.
 */
export function balanceScore(share: number, ms: number): number {
  const slower = Math.max(1, ms) / FAST_ENOUGH_MS
  return share - (slower <= 1 ? 0 : SLOWNESS_COST * Math.log10(slower))
}

/** Ladder share, or -1 for a model nobody has put through it. */
export function shareOf(model: CloudModel): number {
  const m = model.measured
  return m && m.of > 0 ? m.clean / m.of : -1
}

/**
 * The time to rank on: what the last check measured here, else the
 * catalogue's.
 *
 * The fresh reading REPLACES the shipped one rather than averaging with
 * it. See cloud.Fresh: they are two measurements of the same quantity and
 * one of them is from this machine today.
 */
export function msFor(model: CloudModel, fresh: Latencies = {}): number {
  return fresh[model.id]?.ms ?? model.measured?.medianMs ?? Infinity
}

/**
 * Did it answer at all, last time anyone looked?
 *
 * Slow is not dead. A model that takes two minutes is sorted on by every
 * tab here; a model that answered nothing when last checked is sorted
 * UNDER all of them, on every tab, because "the smartest model in the
 * list" is not advice if choosing it produces no answer.
 */
export function alive(model: CloudModel, fresh: Latencies = {}): boolean {
  const live = fresh[model.id]
  return live ? live.ok : true
}

/** Alive, and quick enough that somebody would wait for it. */
export function answersInTime(model: CloudModel, fresh: Latencies = {}): boolean {
  return alive(model, fresh) && msFor(model, fresh) < UNUSABLY_SLOW_MS
}

/**
 * The comparator for one tab, best first.
 *
 * Each is a short chain and the chains are deliberately different shapes:
 *
 *   balanced  usable first, then the blended score. The floor comes before
 *             the arithmetic because 0.08 a tenfold is right across the
 *             range people choose in and too kind at the extreme - on the
 *             real figures DeepSeek at 112 seconds scores within 0.01 of
 *             the VL model at 11, which is the formula working exactly as
 *             designed and arriving somewhere absurd. Nobody waits two
 *             minutes for a thing that lives in the system tray.
 *
 *   smarts    the ladder share, and nothing else. No speed floor at all,
 *             which is the entire point of the tab: it is the only place
 *             the highest score in the catalogue is allowed to be first.
 *             Speed breaks exact ties - two models share 38/42 - so the
 *             order is stable rather than whichever was typed in first.
 *
 *   speed     the clock, and nothing else. Score breaks ties. A model that
 *             gets seventeen rungs of forty-two is genuinely the third
 *             quickest thing here and this tab says so; the badge beside
 *             it says 17/42 in the same row.
 */
export function compareFor(
  ordering: Ordering,
  fresh: Latencies = {}
): (a: CloudModel, b: CloudModel) => number {
  const share = (m: CloudModel): number => shareOf(m)
  const ms = (m: CloudModel): number => msFor(m, fresh)
  const up = (m: CloudModel): number => (alive(m, fresh) ? 1 : 0)

  if (ordering === 'smarts') {
    return (a, b) => up(b) - up(a) || share(b) - share(a) || ms(a) - ms(b)
  }
  if (ordering === 'speed') {
    return (a, b) => up(b) - up(a) || ms(a) - ms(b) || share(b) - share(a)
  }
  /*
   * THREE STEPS, NOT TWO, and the third one is a trap this check caught.
   *
   * It was "answers in time, or does not", with the blend deciding inside
   * each group - and a model that answered NOTHING is recorded with the
   * time it took to fail, which for an empty reply or a refused key is
   * zero. Zero milliseconds is infinitely fast, so the highest-scoring
   * model in the catalogue came back from a failed check with the best
   * blended score in the list. It stayed at the bottom only because the
   * group above it existed, which is a guard holding by accident.
   *
   * So "it answered" is its own step, under everything that works and
   * below the slow ones that at least arrive, and the arithmetic never
   * gets to see a zero it would read as quick.
   */
  const tier = (m: CloudModel): number =>
    alive(m, fresh) ? (answersInTime(m, fresh) ? 2 : 1) : 0
  const points = (m: CloudModel): number => balanceScore(share(m), ms(m))
  return (a, b) => tier(b) - tier(a) || points(b) - points(a) || ms(a) - ms(b)
}

/** A catalogue entry with its place in the order being shown. */
export interface Ranked {
  model: CloudModel
  /** 1 is best. Null when the model has never been measured here. */
  rank: number | null
}

/**
 * The catalogue in the order one tab wants it, as ranks.
 *
 * Returned in catalogue order with a number attached rather than sorted,
 * because the caller decides whether to show the list ranked - `/usage`
 * wants one model's place, the picker wants all of them in order.
 *
 * Unmeasured entries keep their catalogue position and get no rank, rather
 * than being sorted to the bottom as though they had scored zero.
 *
 * `fresh` is what `/model check` and the hourly ranker last found, and it
 * replaces the catalogue's latency wherever it exists. The ladder score
 * has no such override and cannot get one: a probe asks for one short
 * answer and never climbs the ladder, so nothing measured in the
 * background can promote a model's smartness. That split is why the tabs
 * have different captions.
 */
export function rankedModels(
  models: readonly CloudModel[] = CLOUD_MODELS,
  fresh: Latencies = {},
  ordering: Ordering = DEFAULT_ORDERING
): Ranked[] {
  const order = models
    .filter((m) => m.measured)
    .slice()
    .sort(compareFor(ordering, fresh))

  const place = new Map(order.map((m, i) => [m.id, i + 1]))
  return models.map((model) => ({ model, rank: place.get(model.id) ?? null }))
}

/** One tab. */
export interface OrderingSpec {
  id: Ordering
  /** On the tab itself. */
  label: string
  /** Beside the recommended one, and nowhere else. */
  tag?: string
  /** What this order means, under the tabs, while it is showing. */
  note: string
  /** The same thing in three words, for `/settings`. */
  summary: string
}

/**
 * The tabs, in the order they are shown.
 *
 * Balanced first and marked, because a row of three equal choices is a
 * question asked of somebody who came here to pick a model. The other two
 * are for a person who already knows which half of the trade they want.
 */
export const ORDERINGS: readonly OrderingSpec[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    tag: 'recommended',
    note:
      'Score first, slowness charged gently: ten times slower has to be about three ' +
      'ladder rungs better to make up for it. Nothing that takes over ' +
      `${Math.round(UNUSABLY_SLOW_MS / 1000)}s is ranked above something that answers.`,
    summary: 'balanced'
  },
  {
    id: 'smarts',
    label: 'Smartest',
    note:
      'The capability ladder alone — 42 rungs, run by hand here, with the date in each ' +
      'badge. The clock is ignored, and the hourly check never touches this number.',
    summary: 'smartest first'
  },
  {
    id: 'speed',
    label: 'Fastest',
    /* Plain prose, like the other two: the picker prints these as text,
       not as markdown, so a backticked /model check would arrive with its
       backticks showing. The sheet gets `summary` instead. */
    note:
      'Median time to a short answer at Wumpy’s real instructions, re-measured by ' +
      '/model check and every 30 minutes in the background. Quick is not the same as ' +
      'right — the score is in every badge.',
    summary: 'fastest first'
  }
]

export function orderingSpec(ordering: Ordering): OrderingSpec {
  return ORDERINGS.find((o) => o.id === ordering) ?? ORDERINGS[0]
}

/**
 * The caption under the tabs, with what this order actually did to this
 * catalogue when that is worth a warning.
 *
 * Only one case gets a clause of its own, and it is the one somebody is
 * about to be caught by: the smartest model here is also the slowest thing
 * in the list by two orders of magnitude, and the tab that says "smartest"
 * puts it first with a #1 badge. The static sentence says the clock is
 * ignored; this says what ignoring it cost today, by name.
 */
export function orderNote(
  ordering: Ordering,
  models: readonly CloudModel[] = CLOUD_MODELS,
  fresh: Latencies = {}
): string {
  const spec = orderingSpec(ordering)
  if (ordering !== 'smarts') return spec.note

  const first = rankedModels(models, fresh, 'smarts').find((r) => r.rank === 1)
  if (!first) return spec.note
  const ms = msFor(first.model, fresh)
  if (ms < UNUSABLY_SLOW_MS) return spec.note
  return `${spec.note} Today that puts ${first.model.label} first, at ${secs(ms)} a turn.`
}

/** The words `/model` accepts for a tab, so `/model smarts` opens on it. */
export function readOrdering(word: string): Ordering | null {
  const w = word.trim().toLowerCase()
  if (/^(balanced?|recommended|default|best)$/.test(w)) return 'balanced'
  if (/^(smarts?|smartest|clever|clevere?st|capable|score)$/.test(w)) return 'smarts'
  if (/^(speed|fast|fastest|quick|quickest)$/.test(w)) return 'speed'
  return null
}
