import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { log } from './log'
import { resourcePath } from './tray'

/**
 * The Linux half of clicking and typing on the desktop.
 *
 * Windows has WumpyHook.exe (src/hook). Linux has resources/linux/desktop.py,
 * built from src/linux by scripts/build-linux-helper.mjs, which answers the
 * same line protocol: hyprctl puts the pointer, wumpy-pointer presses it
 * (wlr-virtual-pointer, no root), wtype types, and AT-SPI supplies the names
 * that `press`, `focus` and `fill` look up. input.ts drives either the same.
 *
 * It used to be that Wumpy on Linux could see the screen and not touch it,
 * and its prompt said "There is no mouse control here", so it told the user
 * it had no hands. This is the hands.
 *
 * Started lazily, on the first command, so a session that never acts on the
 * screen never runs it - starting it turns accessibility on for the session,
 * which makes apps that start afterwards publish their trees.
 */
export class LinuxDesktop {
  private child: ChildProcess | null = null
  private starting: Promise<boolean> | null = null
  private ready = false
  /** What it said it can do: "pointer atspi", or which half is missing. */
  private abilities = ''
  private readonly pending = new Map<string, Array<(reply: string) => void>>()

  /** Whether the pieces are there at all. Cheap: used to decide what the prompt says. */
  static available(): boolean {
    return (
      process.platform === 'linux' &&
      process.env.XDG_SESSION_TYPE === 'wayland' &&
      Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE) &&
      existsSync(resourcePath('linux/desktop.py')) &&
      existsSync(resourcePath('linux/wumpy-pointer'))
    )
  }

  private start(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        this.starting = null
        resolve(ok)
      }
      try {
        /* stdin stays open: the helper ends at EOF, so it cannot outlive Wumpy. */
        this.child = spawn('python3', [resourcePath('linux/desktop.py'), `--owner=${process.pid}`], {
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (err) {
        log(`[do] linux helper did not start: ${String(err)}`)
        return settle(false)
      }
      let buffer = ''
      this.child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line) continue
          if (line.startsWith('READY')) {
            this.ready = true
            this.abilities = line.slice('READY linux'.length).trim()
            log(`[do] linux helper ready (${this.abilities})`)
            settle(true)
            continue
          }
          const verb = line.split(' ')[0]
          this.pending.get(verb)?.shift()?.(line)
        }
      })
      this.child.stderr?.on('data', (chunk: Buffer) => log(`[do] linux helper: ${chunk.toString('utf8').trim()}`))
      this.child.on('error', (err) => {
        log(`[do] linux helper error: ${err.message}`)
        settle(false)
      })
      this.child.on('exit', (code) => {
        this.child = null
        this.ready = false
        for (const [verb, queue] of this.pending) for (const f of queue.splice(0)) f(`${verb} FAILED helper-exited`)
        log(`[do] linux helper exited (${code})`)
        settle(false)
      })
      setTimeout(() => settle(this.ready), 8000)
    })
    return this.starting
  }

  /** One command, one reply line beginning with its verb - the same contract as LowLevelHook.send. */
  async send(command: string, timeoutMs = 4000): Promise<string> {
    const verb = command.split(' ')[0]
    if (!(await this.start())) return `${verb} FAILED helper-not-running`
    const stdin = this.child?.stdin
    if (!stdin?.writable) return `${verb} FAILED helper-not-running`
    return new Promise((resolve) => {
      const queue = this.pending.get(verb) ?? []
      let done = false
      const settle = (reply: string): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(reply)
      }
      const timer = setTimeout(() => {
        const q = this.pending.get(verb)
        if (q) this.pending.set(verb, q.filter((f) => f !== settle))
        settle(`${verb} FAILED no-reply-in-${timeoutMs}ms`)
      }, timeoutMs)
      queue.push(settle)
      this.pending.set(verb, queue)
      stdin.write(command + String.fromCharCode(10))
    })
  }

  stop(): void {
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
    this.ready = false
  }
}
