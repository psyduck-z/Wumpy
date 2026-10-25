import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { amended, entry, isRepeat, keep, prune, type Entry, type EventKind } from '@shared/journal'

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

  /**
   * @param changed Told after every line, so a `/log` already on screen can
   *   keep up with one. Asked for: "when my logs is displayed, also make it
   *   auto update... especially while I'm still looking at the logs" - and
   *   the thing most worth seeing arrive is the one that happens while
   *   nobody is typing, which is the hourly ranking.
   */
  constructor(private readonly changed?: () => void) {
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

  /**
   * Finishes a line that was written while the thing was still happening.
   *
   * One caller: a ranking sweep, which writes `measuring 9 models…` at its
   * first measurement and becomes `9 models in 8 min` at its last. The time
   * stays the time it started, which is the time somebody is looking for.
   *
   * False when there was no such line - cleared, or aged out of a sweep
   * that ran across midnight - so the caller can write the finished line
   * fresh rather than drop the event. See @shared/journal amended for why
   * this is the only rewriting anything here does.
   */
  amend(kind: EventKind, from: string, to: string): boolean {
    const next = amended(this.entries, kind, from, to)
    if (!next) return false
    this.entries = next
    this.flush()
    return true
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

  /**
   * Written, and then said out loud.
   *
   * Announced from the one place every change goes through, rather than
   * from the three that call it: a line that reached the disk and not the
   * panel is the bug this arrangement cannot have.
   */
  private flush(): void {
    this.write()
    this.changed?.()
  }

  private write(): void {
    try {
      /* Not indented, unlike the other stores. Those are small and worth
         reading by hand; this one is a thousand lines of three fields, and
         the indentation would be half the file. `/log` is how it is read. */
      writeAtomic(this.file, `${JSON.stringify({ entries: this.entries })}\n`)
    } catch {
      // Losing a line of history is not worth troubling anyone about.
    }
  }
}
