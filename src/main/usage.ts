import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { DayUsage, UsageEvent, UsageLine } from '@shared/usage'
import { record, summarise, todayKey } from '@shared/usage'

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
    const today = todayKey(new Date())
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as DayUsage
      if (raw?.date === today && raw.models) return raw
    } catch {
      // No file yet, or it is yesterday's. Either way, start clean.
    }
    return { date: today, models: {} }
  }

  /** Rolls over at midnight without needing a timer to notice. */
  private current(): DayUsage {
    const today = todayKey(new Date())
    if (this.day.date !== today) this.day = { date: today, models: {} }
    return this.day
  }

  add(event: UsageEvent): void {
    this.day = record(this.current(), event)
    this.dirty = true
    // Batched, because this fires on every turn and the totals are not worth
    // a synchronous write each time. Written soon enough to survive a crash
    // that happens while the user is reading the answer.
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
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.day, null, 2)}\n`, 'utf8')
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
    this.day = { date: todayKey(new Date()), models: {} }
    this.dirty = true
    this.flush()
  }
}
