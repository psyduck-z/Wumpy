import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import type { DayUsage, UsageEvent, UsageLine } from '@shared/usage'
import { record, summarise, todayKey } from '@shared/usage'
import { pacificDayKey } from '@shared/pool'

/**
 * Keeps the running total, one file, one day at a time.
 *
 * Only today is kept. A history would be a nicer feature and a worse default:
 * this is a record of what was asked and of which model, and it has no reason
 * to outlive the question it answers. Yesterday's totals do not help anyone
 * decide anything, and the quotas reset anyway.
 *
 * No prompt text is stored, only counts.
 */
export class UsageStore {
  private readonly file = join(app.getPath('userData'), 'usage.json')
  private day: DayUsage
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    this.day = this.read()
  }

  private read(): DayUsage {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as DayUsage
      if (raw?.models && raw.quotaDay === pacificDayKey()) return raw
      /* A file written before quotaDay existed: keep it if the local day
         still matches, which is the old rule and right for most of a day. */
      if (raw?.models && !raw.quotaDay && raw.date === todayKey(new Date())) {
        return { ...raw, quotaDay: pacificDayKey() }
      }
    } catch {
      // No file yet, or it is yesterday's. Either way, start clean.
    }
    return this.blank()
  }

  private blank(): DayUsage {
    return { date: todayKey(new Date()), quotaDay: pacificDayKey(), models: {} }
  }

  /**
   * Rolls over when the quota does, without needing a timer to notice.
   *
   * On the Pacific day, not the local one. The counters exist to measure an
   * allowance Google resets at midnight in California, so that is the moment
   * they are allowed to forget anything; the local date is carried alongside
   * purely so the report can say "today" and mean it.
   */
  private current(): DayUsage {
    if (this.day.quotaDay !== pacificDayKey()) this.day = this.blank()
    else if (this.day.date !== todayKey(new Date())) {
      /* Local midnight passed mid-quota-day: rename it, keep the counts. */
      this.day = { ...this.day, date: todayKey(new Date()) }
    }
    return this.day
  }

  add(event: UsageEvent): void {
    this.day = record(this.current(), event)
    this.dirty = true
    /*
     * Written now, not in four seconds.
     *
     * The batching was reasoned from the wrong frequency: this fires once per
     * completed TURN, not once per token, so it is a millisecond write a few
     * times a minute at most - against a turn that takes seconds. And the
     * thing it was risking is the figure the quota meter and the measured
     * daily cap are built on, in an app that is restarted with
     * `Stop-Process -Force` several times an hour. Every one of those
     * restarts could lose the last turn it counted.
     *
     * The timer stays as a safety net for anything that sets `dirty` without
     * coming through here.
     */
    this.flush()
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flush()
      }, 4000)
    }
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      writeAtomic(this.file, `${JSON.stringify(this.day, null, 2)}\n`)
    } catch {
      // Losing a usage total is not worth troubling anyone about.
    }
  }

  /**
   * The day so far, measured against the allowance this machine actually
   * has - which is one free tier per key, not one in total.
   */
  lines(keys = 1): UsageLine[] {
    return summarise(this.current(), keys)
  }

  today(): DayUsage {
    return this.current()
  }

  reset(): void {
    this.day = this.blank()
    this.dirty = true
    this.flush()
  }
}
