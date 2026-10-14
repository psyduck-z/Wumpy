import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isRejected, restsChanged, type PoolDay } from '@shared/pool'
import { PROVIDER_IDS, type ProviderId } from '@shared/cloud'

/**
 * Which keys are spent, kept across restarts.
 *
 * The rotation used to live only in memory, with a comment saying a restart
 * was "a reasonable moment to find out whether a key has recovered". It is
 * not: a key that is out of gemini-3.8-flash until midnight Pacific is still
 * out five seconds later, and rediscovering that costs one 429 per key. While
 * Wumpy is being worked on it restarts several times an hour, so the pool was
 * being re-probed from scratch all day - and a 429 is a request, which is
 * quota spent on learning something that was already written down.
 *
 * NO KEY MATERIAL IS IN THIS FILE. It holds positions in the list, request
 * counts and timestamps, which is why it can be plain JSON next to the
 * settings while the keys themselves stay in safeStorage.
 */
export class PoolStore {
  private readonly file = join(app.getPath('userData'), 'pool.json')
  private data: Partial<Record<ProviderId, PoolDay>> = {}
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor() {
    this.data = this.read()
    /*
     * Said out loud, because "the rest was remembered" and "the rest was
     * lost" looked identical in the log - and the difference between them is
     * three wasted requests on the first turn after a restart.
     */
    for (const id of PROVIDER_IDS) {
      const day = this.data[id]
      if (!day) continue
      const now = Date.now()
      const resting = day.spend.filter((s) => s.restUntil > now && !isRejected(s)).length
      const out = day.spend.filter((s) => Object.keys(s.outOf).length > 0).length
      /* Named, and by position, because this is the one state nothing else
         will ever report: it does not change, so it never shows up as an
         event. It sat unsaid for weeks. */
      const dead = day.spend.map((s, i) => (isRejected(s) ? i + 1 : 0)).filter(Boolean)
      console.log(
        `[wumpy] key pool restored for ${id}: ${day.spend.length} keys, ` +
          `${resting} resting, ${out} out of a model (day ${day.day})` +
          (dead.length ? `; key ${dead.join(', ')} REFUSED - /key ${id} check retries them free` : '')
      )
    }
  }

  private read(): Partial<Record<ProviderId, PoolDay>> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      const out: Partial<Record<ProviderId, PoolDay>> = {}
      // Only providers we recognise, and only entries shaped like a ledger:
      // this file is hand-editable, and a malformed one must not become a
      // rest that never expires.
      for (const id of PROVIDER_IDS) {
        const day = raw[id] as PoolDay | undefined
        if (!day || typeof day.day !== 'string' || !Array.isArray(day.spend)) continue
        out[id] = {
          day: day.day,
          keys: Number(day.keys) || day.spend.length,
          spend: day.spend.map((s) => ({
            models: typeof s?.models === 'object' && s.models ? s.models : {},
            restUntil: Number(s?.restUntil) || 0,
            why: typeof s?.why === 'string' ? s.why : '',
            /* Strictly true, so a hand-edited file cannot retire a key with
               a stray string. The way back is `/key <provider> check`. */
            rejected: s?.rejected === true,
            outOf: typeof s?.outOf === 'object' && s.outOf ? s.outOf : {},
            /* Absent in ledgers written before the rotation spread the load
               by time as well as by count. Zero reads as "not for a long
               time", which is the safe direction. */
            lastAt: Number(s?.lastAt) || 0
          }))
        }
      }
      return out
    } catch {
      // Missing or corrupt. Either way there is nothing known about the pool.
      return {}
    }
  }

  get(provider: ProviderId): PoolDay | null {
    return this.data[provider] ?? null
  }

  /**
   * Remembers the ledger, soon rather than now.
   *
   * Called on every request, so a synchronous write each time would put a
   * disk flush in front of the model. Four seconds is close enough: the worst
   * a crash loses is the last few requests' counts, and the rests - the part
   * that costs quota to rediscover - are written long before anyone restarts
   * on purpose.
   */
  save(provider: ProviderId, pool: PoolDay): void {
    /*
     * A rest is written at once; the counts can wait.
     *
     * The debounce was fine for the part that only costs accuracy, and wrong
     * for the part that costs quota. From the log: key 1 rejected (401) at
     * 10:50:40, three restarts, and the same key rejected again at 12:21 -
     * the rest that should have stopped that was still sitting in a
     * four-second timer when `Stop-Process -Force` arrived. Nothing in this
     * app gets a graceful shutdown, so nothing may depend on one.
     *
     * This fires a handful of times a day, on a file of two kilobytes.
     */
    const urgent = restsChanged(this.data[provider] ?? null, pool)
    this.data = { ...this.data, [provider]: pool }
    this.dirty = true
    if (urgent) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, 4000)
    }
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    } catch {
      // Losing the ledger costs a handful of 429s, not correctness.
    }
  }
}
