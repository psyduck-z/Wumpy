import { QUIET_FOR_MS, TEST_EVERY_MS, TEST_FOR_MS, dueKey, limitFrom, limitLine, type KeyLimit, type Sample } from '@shared/limits'

/**
 * Measures one key's limit at a time, when nobody is using Wumpy: the hands
 * for @shared/limits.
 *
 * Idle means idle - no answer, no agent, no ranking sweep, the panel away,
 * and ten quiet minutes - and the test stops dead the moment that changes,
 * keeping nothing from a half-run. At most one key a day each, and a key
 * whose test gave no reading is left for an hour rather than retried every
 * minute.
 */
export interface LimitDeps {
  provider(): string | null
  keys(): number
  /** The model to ask: a quick one, since only the status matters. */
  model(): string | null
  /** Since the user last did anything, and whether anything is going on now. */
  quietFor(): number
  busy(): boolean
  ping(model: string, index: number, signal: AbortSignal): Promise<number>
  /** Keeps everything else off the key under test, and lets it go. */
  reserve(model: string, index: number): boolean
  release(model: string, index: number): void
  saved(): Record<string, KeyLimit>
  save(id: string, limit: KeyLimit): void
  log(line: string): void
}

const LOOK_EVERY_MS = 60_000
const FAILED_WAIT_MS = 3_600_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class LimitTester {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private failedAt = new Map<string, number>()

  constructor(private readonly deps: LimitDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), LOOK_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private idle(): boolean {
    return !this.deps.busy() && this.deps.quietFor() >= QUIET_FOR_MS
  }

  private async tick(): Promise<void> {
    if (this.running || !this.idle()) return
    const provider = this.deps.provider()
    const model = this.deps.model()
    const keys = this.deps.keys()
    if (!provider || !model || keys < 1) return
    const index = dueKey(this.deps.saved(), provider, keys, Date.now())
    if (index === null) return
    const id = `${provider}:${index}`
    if (Date.now() - (this.failedAt.get(id) ?? 0) < FAILED_WAIT_MS) return
    if (!this.deps.reserve(model, index)) return
    this.running = true
    try {
      await this.test(provider, model, index, keys)
    } finally {
      this.deps.release(model, index)
      this.running = false
    }
  }

  private async test(provider: string, model: string, index: number, keys: number): Promise<void> {
    const id = `${provider}:${index}`
    const controller = new AbortController()
    const samples: Sample[] = []
    const asks: Promise<void>[] = []
    const started = Date.now()
    this.deps.log(`[limits] testing key ${index + 1} with ${model}: a request every ${TEST_EVERY_MS}ms until it refuses`)
    while (Date.now() - started < TEST_FOR_MS) {
      if (!this.idle()) {
        controller.abort()
        this.deps.log(`[limits] stopped testing key ${index + 1}: Wumpy is in use`)
        await Promise.allSettled(asks)
        return
      }
      const at = Date.now()
      asks.push(
        this.deps.ping(model, index, controller.signal).then((status) => {
          samples.push({ at, status })
        })
      )
      if (samples.some((s) => s.status === 429)) break
      await sleep(TEST_EVERY_MS)
    }
    await Promise.allSettled(asks)
    const limit = limitFrom(samples, keys, Date.now())
    if (!limit) {
      this.failedAt.set(id, Date.now())
      const codes = [...new Set(samples.map((s) => s.status))].join(', ')
      this.deps.log(`[limits] key ${index + 1} gave no reading (${samples.length} asked, statuses ${codes || 'none'})`)
      return
    }
    this.deps.save(id, limit)
    this.deps.log(`[limits] ${limitLine(index, limit)} (${samples.length} asked)`)
  }
}
