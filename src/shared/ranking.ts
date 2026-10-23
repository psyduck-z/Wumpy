/**
 * Keeping the ranking fresh without ever being in the user's way.
 *
 * `/model check` measures what each model really costs at Wumpy's own
 * preamble, and since the picker started sorting on those numbers the
 * ranking is only as good as the last time somebody ran it. Asked for: have
 * it run itself, about once an hour, on the OTHER key - "use one API key to
 * do the ranking, the other one to do the direct answering that the user
 * sees" - and, the important half:
 *
 *   "if the token, the requests are really in high demand of the user, then
 *    stop the request right now, pause it, and then use the second API key
 *    to help back it up"
 *
 * So this is a background job that is wrong by default. Every rule below
 * says when NOT to go, and the only way to reach "go" is for all of them to
 * be false. A measurement of the models is worth nothing next to the turn
 * somebody is waiting on, and a check that makes the thing it checks slower
 * is worse than no check.
 *
 * WHAT A SECOND KEY ACTUALLY BUYS depends on a setting only the user knows.
 * With `/key nvidia accounts separate` the keys are separate allowances with
 * separate pacing queues, and a background probe on key two genuinely costs
 * the user nothing. Shared - the default - means one allowance and one
 * queue, so a probe in flight can put one pacing gap in front of the next
 * question. That is why the quiet window exists at all, and why this says so
 * out loud rather than promising isolation it cannot deliver.
 *
 * Pure, so every rule can be driven from a check without a key, a network or
 * an hour to wait.
 */

/** What the user's traffic looks like right now. */
export interface Traffic {
  /** A turn the user is waiting on, this moment. */
  busy: boolean
  /** Since the last turn ended. Infinity when there has not been one. */
  sinceTurnMs: number
  /** Requests on this account in the last minute, the user's and ours. */
  lastMinute: number
  /** The provider's ceiling, or 0 when it has none worth pacing against. */
  perMinute: number
  /** Since the provider last said no. Infinity when it has not. */
  sinceLimitedMs: number
}

/** What the ranker has done so far. */
export interface RankerState {
  /** The setting. Off means off; nothing below is consulted. */
  on: boolean
  /** Keys for the provider being ranked. */
  keys: number
  /** Since the last background probe went out. */
  sinceProbeMs: number
  /** Since the last sweep finished, or Infinity before the first one. */
  sinceSweepMs: number
  /** Models still to measure in the sweep that is running. */
  left: number
}

/** A sweep an hour, which is what was asked for. */
export const EVERY_MS = 60 * 60 * 1000

/**
 * Quiet after a turn before the ranker moves again.
 *
 * Not for the turn that just ended - that one is over - but for the next
 * one. People ask follow-up questions, and a probe started two seconds after
 * an answer lands is a probe in flight when the follow-up is sent.
 */
export const QUIET_MS = 30_000

/**
 * Between one background probe and the next.
 *
 * The sweep is one model at a time with this much air in between, rather
 * than the whole catalogue at once. A full `/model check` is nine minutes of
 * requests, which as a background burst would be nine minutes during which
 * every question the user asks is behind something. One model at a time can
 * be stopped between models, and thirty seconds apart it is nine or ten
 * requests spread over twenty minutes of an hour.
 */
export const GAP_MS = 30_000

/**
 * After a 429, stay out of it.
 *
 * A refusal means the account is at its ceiling, and the ranking is the
 * least important thing asking. Ten minutes is long enough for a burst of
 * turns to finish and short enough that the sweep still completes inside
 * its hour.
 */
export const BACKOFF_MS = 10 * 60 * 1000

/**
 * The share of the per-minute ceiling at which the user is "in high demand".
 *
 * Nobody types forty questions a minute, but a sequence can: a command runs,
 * the output goes back, the model asks for another. At half the ceiling the
 * remaining headroom belongs to the user, and the second key is worth more
 * as somewhere for the rotation to go than as a measuring instrument.
 */
export const CROWDED_FRACTION = 0.5

/** How many requests a minute counts as the user needing the account. */
export function crowdedAt(perMinute: number): number {
  return perMinute > 0 ? Math.ceil(perMinute * CROWDED_FRACTION) : Infinity
}

/** Why the ranker is not running, in the order the rules are applied. */
export type Why =
  | 'off'
  /** One key is the key answering questions. There is nothing to rank with. */
  | 'onekey'
  | 'busy'
  | 'cooling'
  | 'crowded'
  | 'limited'
  | 'paced'
  /** Nothing to do: the sweep is finished and the hour is not up. */
  | 'waiting'

export type Verdict = { go: true; key: number } | { go: false; why: Why }

/**
 * Is there anything to measure: models left in this sweep, or an hour gone
 * since the last one finished.
 */
export function isDue(state: RankerState): boolean {
  return state.left > 0 || state.sinceSweepMs >= EVERY_MS
}

/**
 * Which key the ranking may use: the last one, never the first.
 *
 * The rotation starts at the front, so the back of the list is the one the
 * next question is least likely to want. With separate accounts this is a
 * different allowance entirely; with shared accounts it is at least a
 * different key, which is what the pool counts per key.
 */
export function rankingKey(keys: number): number {
  return Math.max(0, keys - 1)
}

/**
 * May a background probe go out right now, and on which key.
 *
 * The order matters: the cheapest and most certain refusals first, so that
 * "the user is waiting" is never outranked by an arithmetic rule about
 * minutes.
 */
export function mayRank(state: RankerState, traffic: Traffic): Verdict {
  if (!state.on) return { go: false, why: 'off' }
  /* With one key, "the other key" is the key answering questions. The
     feature is not degraded into competing with the user; it is off. */
  if (state.keys < 2) return { go: false, why: 'onekey' }
  if (traffic.busy) return { go: false, why: 'busy' }
  if (traffic.sinceTurnMs < QUIET_MS) return { go: false, why: 'cooling' }
  if (traffic.lastMinute >= crowdedAt(traffic.perMinute)) return { go: false, why: 'crowded' }
  if (traffic.sinceLimitedMs < BACKOFF_MS) return { go: false, why: 'limited' }
  /* A sweep with models left keeps going; a finished one waits for the
     hour, and then it is due again. `go` with nothing left means exactly
     that - start the next sweep - which is why the ranker refills its
     queue on the way in rather than this rule knowing about queues.

     Checked after the traffic rules, so a sweep that would have been
     stopped by the user still reports the user as the reason. */
  if (!isDue(state)) return { go: false, why: 'waiting' }
  if (state.sinceProbeMs < GAP_MS) return { go: false, why: 'paced' }
  return { go: true, key: rankingKey(state.keys) }
}

/** The same decision in a few words, for `/rank` and the settings sheet. */
export function whyNot(why: Why): string {
  switch (why) {
    case 'off':
      return 'off'
    case 'onekey':
      return 'needs a second key'
    case 'busy':
      return 'waiting for your turn to finish'
    case 'cooling':
      return 'just after a turn'
    case 'crowded':
      return 'you are using the account'
    case 'limited':
      return 'backing off after a refusal'
    case 'paced':
      return 'between models'
    case 'waiting':
      return 'measured; next sweep within the hour'
  }
}

/** How long ago, in words a person would use. */
export function ago(ms: number): string {
  if (!Number.isFinite(ms)) return 'never'
  /* Under a minute is "just now", and the test is on the milliseconds
     rather than on the rounded minutes: half a minute rounds to one, and
     "1 min ago" for something thirty seconds old is a small lie told by
     arithmetic. */
  if (ms < 60_000) return 'just now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/**
 * The whole report, as `/rank` prints it.
 *
 * Four questions in order: is it on, what is it doing, what is stopping it,
 * and what did it cost. The last one matters because this is the only part
 * of Wumpy that spends a request nobody asked for, and somebody is entitled
 * to see the bill without reading the source.
 */
export function rankLines(
  state: RankerState,
  traffic: Traffic,
  lastSweepMs: number,
  measured: number
): string[] {
  const verdict = mayRank(state, traffic)
  const head = state.on
    ? verdict.go
      ? `**Ranking the models now** — ${state.left} left in this sweep.`
      : `**Background ranking is on**, paused: ${whyNot(verdict.why)}.`
    : '**Background ranking is off.** `/rank on` turns it back on.'

  const lines = [head, '']
  if (state.keys < 2 && state.on) {
    lines.push(
      'It needs a second key and there ' +
        (state.keys === 1 ? 'is one' : 'are none') +
        ': the whole idea is that one key measures while the other answers. ' +
        'Add one with `/key`, and say `/key nvidia accounts separate` if they ' +
        'are different logins — then the measuring cannot slow a question down ' +
        'at all.'
    )
    return lines
  }

  lines.push(
    `| | |`,
    `| --- | --- |`,
    `| last full sweep | ${ago(lastSweepMs)} |`,
    `| models measured | ${measured} of ${measured + state.left} |`,
    `| measuring on | key ${rankingKey(state.keys) + 1} of ${state.keys} |`,
    `| your requests this minute | ${traffic.lastMinute}` +
      (traffic.perMinute > 0 ? ` of about ${traffic.perMinute}` : '') +
      ` (pauses at ${traffic.perMinute > 0 ? crowdedAt(traffic.perMinute) : '—'}) |`,
    '',
    '_One model at a time, about once an hour, on the key the next question ' +
      'is least likely to want. It stops mid-request the moment you send ' +
      'something and throws that measurement away._',
    '',
    /* WHAT IT DOES NOT MEASURE, said here because this is where somebody
       would assume otherwise. "Re-ranking the models" sounds like it
       re-ranks them, and the picker has a tab called Smartest whose
       numbers this never touches: a probe asks for one short answer and
       cannot climb a 42-rung ladder. The speed is from today, the score
       is from the day somebody ran the bench. */
    '_It measures speed only. The ladder score behind `/model smarts` is ' +
      'run by hand and nothing here can move it._'
  )
  return lines
}

/** One line for the settings sheet: on or off, and when it last managed it. */
export function rankSummary(state: RankerState, traffic: Traffic, lastSweepMs: number): string {
  const verdict = mayRank(state, traffic)
  if (!state.on) return 'off'
  if (verdict.go) {
    /* Due with an empty queue is the start of a sweep, not the end of
       one: "measuring now (0 to go)" is how a correct verdict reads
       wrong. */
    return state.left > 0 ? `on, measuring now (${state.left} to go)` : 'on, starting a sweep'
  }
  if (verdict.why === 'onekey') return 'on, but it needs a second key'
  const last = `last ${ago(lastSweepMs)}`
  return state.left > 0
    ? `on, paused — ${whyNot(verdict.why)} (${state.left} to go)`
    : `on, ${last}`
}
