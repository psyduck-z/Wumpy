import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resourcePath } from './tray'

/**
 * Drives the WumpyHook helper process.
 *
 * Windows reserves Win+C for the shell, so `globalShortcut` (RegisterHotKey)
 * can never claim it. The helper installs a WH_KEYBOARD_LL hook, which sits
 * ahead of the shell and can swallow the keystroke outright. See src/hook.
 *
 * The helper is optional: if it is missing or refuses to start, Wumpy keeps
 * working on whatever accelerator `globalShortcut` did manage to register.
 */
export class LowLevelHook {
  private child: ChildProcess | null = null
  private restarts = 0
  private stopping = false
  private ready = false

  constructor(
    private readonly key: string,
    private readonly onTrigger: () => void
  ) {}

  /** Resolves true once the helper reports that its hook is installed. */
  start(): Promise<boolean> {
    const exe = resourcePath('hook/WumpyHook.exe')
    if (process.platform !== 'win32' || !existsSync(exe)) return Promise.resolve(false)

    return new Promise((resolve) => {
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      try {
        // stdin stays open on purpose: the helper exits when it hits EOF, which
        // guarantees it cannot outlive this process even on a hard crash.
        this.child = spawn(exe, [this.key, `--grant-foreground=${process.pid}`], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (err) {
        console.error('[wumpy] could not spawn keyboard hook:', err)
        return settle(false)
      }

      let buffer = ''
      this.child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const message = line.trim()
          if (!message) continue
          if (message === 'TOGGLE') {
            this.onTrigger()
          } else if (message.startsWith('READY')) {
            this.ready = true
            this.restarts = 0
            console.log(`[wumpy] low-level hook active (${message})`)
            settle(true)
          } else if (message.startsWith('FATAL')) {
            console.error(`[wumpy] hook helper: ${message}`)
            settle(false)
          }
        }
      })

      this.child.stderr?.on('data', (chunk: Buffer) => {
        console.error(`[wumpy] hook helper: ${chunk.toString('utf8').trim()}`)
      })

      this.child.on('error', (err) => {
        console.error('[wumpy] hook helper error:', err.message)
        settle(false)
      })

      this.child.on('exit', (code) => {
        this.child = null
        this.ready = false
        if (this.stopping) return

        // Three attempts is enough to ride out a transient failure without
        // spinning forever against something genuinely broken.
        if (this.restarts < 3) {
          this.restarts += 1
          console.warn(`[wumpy] hook helper exited (${code}); restart ${this.restarts}/3`)
          setTimeout(() => void this.start(), 500 * this.restarts)
        } else {
          console.error('[wumpy] hook helper keeps exiting; falling back to globalShortcut')
        }
        settle(false)
      })
    })
  }

  isActive(): boolean {
    return this.ready && this.child !== null
  }

  stop(): void {
    this.stopping = true
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
    this.ready = false
  }
}
