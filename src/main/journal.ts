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
 * Small on purpose - see startOfDay and MAX_ENTRIES, both in @shared/journal
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
      /* Pruned on the way in as well as on the way out, so a launch the
         morning after keeps nothing: yesterday's lines are dropped here,
         before anything can read them, rather than waiting for the first
         thing that happens to today's list. */
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
   * False when there was no such line - cleared, or belonging to yesterday -
   * so the caller can write the finished line fresh rather than drop the
   * event. See @shared/journal amended for why this is the only rewriting
   * anything here does.
   *
   * Pruned BEFORE looking, which is the whole reason that second case is
   * real. A sweep can be an hour between its first measurement and its last,
   * so on any night the machine is on there is a sweep that opened at 23:50
   * and finished after midnight. Amending the old line in place would have
   * put the finished sweep in a list that is about to drop it, and `/log`
   * would show a sweep that never ended. Finding nothing instead sends the
   * caller down its other path, which stamps the line today.
   */
  amend(kind: EventKind, from: string, to: string): boolean {
    const dropped = this.pruneNow()
    const next = amended(this.entries, kind, from, to)
    if (next) this.entries = next
    /* Announced on a miss as well, when the miss was yesterday going: the
       list a `/log` is showing changed, whether or not the sweep's line was
       in it. */
    if (next || dropped) this.flush()
    return next !== null
  }

  /** Oldest first, as stored. The report does its own ordering. */
  all(): readonly Entry[] {
    /* Written back, but not announced. Somebody is asking for the list right
       now, so the day turning over is a reason for the file to stop holding
       yesterday and no reason to tell the panel to ask again - it is about
       to be handed the pruned answer. */
    if (this.pruneNow()) this.write()
    return this.entries
  }

  /** Drops what is not from today, and says whether anything went. */
  private pruneNow(): boolean {
    const kept = prune(this.entries)
    const dropped = kept.length !== this.entries.length
    this.entries = kept
    return dropped
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
