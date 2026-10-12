import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PoolDay } from '@shared/pool'
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
            outOf: typeof s?.outOf === 'object' && s.outOf ? s.outOf : {}
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
    this.data = { ...this.data, [provider]: pool }
    this.dirty = true
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
