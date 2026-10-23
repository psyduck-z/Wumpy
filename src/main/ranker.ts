import { CLOUD_MODELS } from '@shared/cloud'
import type { ProbeResult } from '@shared/probe'
import {
  DURABLE,
  EVERY_MS,
  GAP_MS,
  mayRank,
  type RankerState,
  type Traffic,
  type Verdict
} from '@shared/ranking'

/**
 * Keeps the model ranking fresh, one model at a time, out of the way.
 *
 * `/model check` measures what each model costs at Wumpy's real preamble and
 * the picker sorts on those numbers, so the ranking is only ever as good as
 * the last time somebody ran it by hand. This runs it by itself.
 *
 * THE RULES ARE IN @shared/ranking AND THEY ARE ALL REFUSALS. This file is
 * the hands: a timer, a cursor through the catalogue, and the one piece of
 * state the rules cannot be pure about - the request in flight, and the
 * controller that cancels it the instant a turn starts.
 *
 * Nothing it measures is urgent. A sweep that takes most of an hour because
 * the user was busy is a sweep that did its job; a sweep that finishes
 * quickly by making one question slower is a bug.
 */
export interface RankerDeps {
  /** One model, on a given key, cancellable. */
  probe(id: string, preamble: string, key: number, signal: AbortSignal): Promise<ProbeResult | null>
  /** The instructions a real turn would carry, so the times mean something. */
  preamble(): string
  /** Keys for this provider, and whether the feature is on. */
  state(): { on: boolean; keys: number }
  /** What the user's traffic looks like, now. */
  traffic(): Traffic
  /**
   * One measurement, for the ledger and for the picker.
   *
   * Both, because a request this made is a request the user's account
   * spent: `/usage` would otherwise show a count that does not add up, and
   * the whole point of the pausing rules is that somebody can see what the
   * background work is costing them.
   */
  record(result: ProbeResult): void
  /**
   * A sweep has started measuring: this many models to go.
   *
   * Reported at the first measurement rather than when the queue was
   * filled, because the queue is filled the moment the app starts and the
   * sweep may not get a quiet moment for an hour. "Log when the auto rerank
   * happened" means this time, not either of those.
   */
  began?(sweep: { asked: number }): void
  /**
   * A sweep is over: this many models measured, out of this many asked, in
   * this long.
   *
   * For the timeline behind `/log`. "Re-rank all the models" was one of the
   * two things the user named wanting to look up afterwards, and until this
   * existed a sweep left nothing behind but nine lines in wumpy.log and
   * nine changed numbers in settings.json. Optional, because the ranker
   * works perfectly well with nobody listening.
   */
  swept?(sweep: { models: number; asked: number; tookMs: number }): void
  /**
   * It cannot run, for a reason that will not clear on its own - or it can
   * again, which is `null`.
   *
   * Only the durable reasons, and only when the answer changes. Every other
   * refusal in @shared/ranking is a few minutes of weather and reporting
   * those would be a log of the feature working. See DURABLE.
   */
  stoodDown?(why: 'off' | 'onekey' | null): void
}

/**
 * How often the rules are consulted.
 *
 * Half the gap between probes, so the first moment the coast is clear is
 * never more than fifteen seconds stale. The tick itself is a handful of
 * comparisons on numbers already in memory - measured against an idle Wumpy
 * at 0.05% of one core, it does not move the figure.
 */
const TICK_MS = 15_000

export class Ranker {
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: AbortController | null = null
  /** Models not yet measured in the sweep that is running. */
  private left: string[] = []
  private lastProbeAt = 0
  private lastSweepAt = 0
  /** Set while a probe is being cancelled, so its result is discarded. */
  private cancelled = false
  private running = false
  /** When the sweep that is running took its first measurement. */
  private sweepStartedAt = 0
  /** Measured in this sweep, and asked for. A model can fail or be dropped. */
  private measured = 0
  private asked = 0
  /** The durable reason last reported, so only changes are. */
  private standing: 'off' | 'onekey' | null = null

  constructor(private readonly deps: RankerDeps) {}

  start(): void {
    if (this.timer) return
    /* The catalogue is due the moment the app starts, but the first tick is
       a tick away: a sweep beginning during startup would compete with the
       panel loading and the keys being read. */
    this.begin()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  /**
   * A fresh queue of models to measure, and a fresh count of what it did.
   *
   * The clock is NOT started here. A sweep can sit in the queue for hours
   * waiting for the user to stop typing - that is the feature working - and
   * reporting "ranked nine models in five hours" would describe the
   * waiting, not the work. It starts at the first measurement.
   */
  private begin(): void {
    this.left = CLOUD_MODELS.map((m) => m.id)
    this.asked = this.left.length
    this.measured = 0
    this.sweepStartedAt = 0
  }

  /**
   * Notices when the ranking has stopped being able to run, and when it can
   * again.
   *
   * Changes only, and only the two reasons that are a decision rather than
   * weather - otherwise this would report 'cooling' and 'paced' every
   * fifteen seconds, which is the feature working. The one that matters is
   * 'onekey': switching to a provider with a single key stands the whole
   * thing down, and nothing anywhere said so until this line existed.
   */
  private watch(verdict: Verdict): void {
    const why = !verdict.go && DURABLE.includes(verdict.why) ? verdict.why : null
    /* Narrowed by DURABLE, which is the two of them; the cast is the type
       system not following a runtime list. */
    const next = why as 'off' | 'onekey' | null
    if (next === this.standing) return
    this.standing = next
    this.deps.stoodDown?.(next)
  }

  /** The queue is empty: the sweep is over, whether or not it all worked. */
  private finish(): void {
    this.lastSweepAt = Date.now()
    this.deps.swept?.({
      models: this.measured,
      asked: this.asked,
      tookMs: this.sweepStartedAt ? Date.now() - this.sweepStartedAt : 0
    })
    this.sweepStartedAt = 0
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.cancel()
  }

  /**
   * A turn has started: stop, now.
   *
   * Not "after this model", not "at the next tick". The request in flight is
   * aborted and its result thrown away, because a measurement taken while
   * the user was waiting is both worthless and the reason they waited.
   */
  cancel(): void {
    if (!this.inflight) return
    this.cancelled = true
    this.inflight.abort()
    this.inflight = null
    /* In the log, because a background job that leaves no trace is one
       nobody can tell apart from a broken one - and this app's first
       debugging step is reading wumpy.log. */
    console.log('[wumpy] ranking stopped mid-measurement: a turn started')
  }

  /** `/rank now`: start a sweep without waiting for the hour. */
  sweepNow(): void {
    this.begin()
    this.lastProbeAt = 0
    void this.tick()
  }

  /** What `/rank` and the settings sheet report. */
  view(): RankerState & { lastSweepMs: number } {
    const { on, keys } = this.deps.state()
    return {
      on,
      keys,
      sinceProbeMs: this.lastProbeAt ? Date.now() - this.lastProbeAt : Infinity,
      sinceSweepMs: this.lastSweepAt ? Date.now() - this.lastSweepAt : Infinity,
      left: this.left.length,
      lastSweepMs: this.lastSweepAt ? Date.now() - this.lastSweepAt : Infinity
    }
  }

  private async tick(): Promise<void> {
    /* One at a time. A slow model holds the lane for two minutes and the
       timer keeps firing underneath it. */
    if (this.running) return

    const view = this.view()
    /* The hour, which is the only rule that adds work rather than refusing
       it: a finished sweep becomes an unfinished one once it is due. */
    if (!view.left && view.sinceSweepMs >= EVERY_MS) this.begin()

    const verdict = mayRank(this.view(), this.deps.traffic())
    this.watch(verdict)
    if (!verdict.go) return

    const id = this.left[0]
    if (!id) return

    this.running = true
    this.cancelled = false
    const controller = new AbortController()
    this.inflight = controller
    const startedAt = Date.now()
    try {
      const result = await this.deps.probe(id, this.deps.preamble(), verdict.key, controller.signal)
      /* Cancelled means a turn started. Whatever came back describes that
         interruption and not the model, so none of it is recorded - not the
         verdict, not the time, and not the fact that it was tried. The
         model stays at the front of the queue for the next quiet moment. */
      if (this.cancelled) return

      this.lastProbeAt = Date.now()
      /* The sweep's clock starts at its first completed measurement, not at
         the moment the queue was filled. See begin(). The timeline is told
         here for the same reason, and with the same timestamp: this is when
         the re-ranking actually happened. */
      if (!this.sweepStartedAt) {
        this.sweepStartedAt = startedAt
        this.deps.began?.({ asked: this.asked })
      }
      this.left = this.left.filter((m) => m !== id)
      if (result) {
        this.measured++
        this.deps.record(result)
        console.log(
          `[wumpy] ranked ${result.model} on key ${verdict.key + 1}: ` +
            `${result.state} in ${result.ms}ms, ${this.left.length} left this sweep`
        )
      }
      if (!this.left.length) this.finish()
    } catch {
      /* A probe that throws is a probe that learned nothing. It is dropped
         from this sweep rather than retried in a loop: the next hour will
         ask again, and a model that cannot be reached twice in a row is
         exactly what a user wants the ranking to have noticed anyway. */
      this.lastProbeAt = Date.now()
      this.left = this.left.filter((m) => m !== id)
      if (!this.left.length) this.finish()
    } finally {
      /* Paced from when the request RETURNED, not when it started: a model
         that took two minutes has already been two minutes of traffic. */
      if (Date.now() - startedAt > GAP_MS) this.lastProbeAt = Date.now()
      this.inflight = null
      this.running = false
    }
  }
}

