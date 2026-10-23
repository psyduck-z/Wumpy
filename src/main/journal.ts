import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { entry, isRepeat, keep, prune, type Entry, type EventKind } from '@shared/journal'

/**
 * The timeline behind `/log`, on the disk.
 *
 * In the main process rather than the renderer, which is the whole reason it
 * can answer the question that was asked. The things worth looking up happen
 * where no page is watching: the hourly ranking runs with the panel in the
 * tray, the tray menu changes the approval mode with no window open at all,
 * and a provider's refusal is known here and nowhere else. A renderer-side
 * list would have been empty for exactly those, and emptied again by every
 * reload.
 *
 * Small on purpose - see MAX_ENTRIES and MAX_AGE_MS, both in @shared/journal
 * with the reasoning. Written atomically because this app is stopped with
 * `Stop-Process -Force` several times an hour and a torn JSON file reads back
 * as no history at all.
 */
export class JournalStore {
  private readonly file = join(app.getPath('userData'), 'journal.json')
  private entries: Entry[]

  constructor() {
    this.entries = this.read()
  }

  private read(): Entry[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: Entry[] }
      if (!Array.isArray(raw?.entries)) return []
      /* Pruned on the way in as well as on the way out, so a machine that
         was off for a fortnight does not keep a fortnight-old list alive by
         never adding to it. */
      return prune(
        raw.entries.filter(
          (e) => e && typeof e.kind === 'string' && typeof e.what === 'string'
        )
      )
    } catch {
      /* No file yet, or an unreadable one. A missing history is not worth an
         error: nothing in the app depends on it. */
      return []
    }
  }

  /**
   * Records one thing, now.
   *
   * Flushed on the spot rather than batched. It is a few kilobytes a few
   * times a minute at the very most, against the thing it is recording -
   * and a history that loses the last entry to a forced restart would be
   * missing the line somebody is about to come looking for.
   */
  add(kind: EventKind, what: string, at = Date.now()): void {
    const next = entry(kind, what, at)
    if (!next.what) return
    /* Asked before `keep`, which would also refuse it, so that a burst of
       refusals from one turn does not rewrite the file a dozen times to
       store nothing. See QUIET_REPEATS. */
    if (isRepeat(this.entries, next)) return
    this.entries = keep(this.entries, next)
    this.flush()
  }

  /** Oldest first, as stored. The report does its own ordering. */
  all(): readonly Entry[] {
    this.entries = prune(this.entries)
    return this.entries
  }

  clear(): void {
    this.entries = []
    this.flush()
  }

  private flush(): void {
    try {
      writeAtomic(this.file, `${JSON.stringify({ entries: this.entries }, null, 2)}\n`)
    } catch {
      // Losing a line of history is not worth troubling anyone about.
    }
  }
}
