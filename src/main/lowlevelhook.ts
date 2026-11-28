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
  /** When the helper last died, so that old failures stop counting. */
  private lastExitAt = 0
  private stopping = false
  private ready = false

  constructor(
    private readonly key: string,
    private readonly onTrigger: () => void,
    /** Shift must be held too. Wumpy no longer asks for it: Win+Y, the same shortcut as on Linux. */
    private readonly shift = false
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
        const args = [this.key, `--grant-foreground=${process.pid}`, ...(this.shift ? ['--shift'] : [])]
        this.child = spawn(exe, args, {
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
          if (message === 'TOGGLE' || message.startsWith('TOGGLE ')) {
            // `TOGGLE granted` / `TOGGLE ungranted` says whether
            // AllowSetForegroundWindow succeeded. Worth knowing: the previous
            // fix was built on the assumption that it always does, and its
            // return value was discarded.
            if (message !== 'TOGGLE') console.log(`[focus] hotkey: ${message.toLowerCase()}`)
            this.onTrigger()
          } else if (message.startsWith('ACTIVATE')) {
            console.log(`[focus] hook ${message.toLowerCase()}`)
          } else if (this.settleCommand(message)) {
            /* A reply to send(): matched and resolved there. */
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
        /* A new helper owes nothing: the old one's late replies died with it,
           and what was still waiting is answered now, not by a timer that
           would count against the new one. */
        this.late.clear()
        for (const [verb, queue] of this.pending) for (const f of queue.splice(0)) f(`${verb} FAILED helper-exited`)
        if (this.stopping) return

        /*
         * The budget is three failures CLOSE TOGETHER, not three in a
         * session.
         *
         * It used to be a lifetime count, reset only by a READY that
         * arrived - so three exits at any three moments of a long run spent
         * it for good, and the hotkey ran the rest of the day on
         * globalShortcut, which cannot grant foreground. That is the whole
         * reason this helper exists, so losing it is not a small
         * degradation, and nothing tells the user it happened.
         *
         * It is cheap to spend, too. From the log, 05:28:59 and 05:29:00:
         *   hook helper exited (1073807364); restart 1/3   <- terminated
         *   hook helper exited (3221225794); restart 2/3   <- DLL init failed
         * 0x40010004 and 0xC0000142 one second apart, with the transcriber
         * going down between them: a machine going to sleep. Two thirds of
         * the budget to an event that says nothing whatever about whether
         * the helper works.
         *
         * So failures expire. Three within five minutes is the thing the
         * old comment meant by "something genuinely broken"; anything
         * further apart is two unrelated accidents.
         */
        const now = Date.now()
        if (now - this.lastExitAt > 5 * 60_000) this.restarts = 0
        this.lastExitAt = now

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

  /**
   * Ask the helper to put a window in the foreground.
   *
   * The helper is the process that received the keystroke, so it is the one
   * Windows will let change the foreground. Wumpy cannot: by the time the
   * toggle has travelled down a pipe and through Electron, the moment has
   * passed. Handing over a hwnd and letting the helper do it removes the
   * race rather than racing faster.
   *
   * Fire and forget. The answer comes back on stdout as `ACTIVATE ok` or
   * `ACTIVATE FAILED ...` and is logged, because an autofocus fix that
   * cannot be checked is how this bug survived five of them.
   */
  /**
   * Commands awaiting their reply, oldest first, keyed by the verb.
   *
   * The helper answers every command with one line starting with the verb it
   * was given, and commands are written one at a time, so matching on the
   * verb is enough. Keyed rather than a single slot because a plan's steps
   * are different verbs and a slow CLICK must not be handed a TYPE's answer.
   */
  private pending = new Map<string, Array<(reply: string) => void>>()
  /**
   * Replies owed to requests that already timed out, by verb. The helper
   * answers one command at a time, in order, so the next reply of that verb
   * is the late one; handed to the request after it, a `fill` reading back
   * its box would be told what the previous box said.
   */
  private late = new Map<string, number>()

  private settleCommand(message: string): boolean {
    const verb = message.split(' ')[0]
    const owed = this.late.get(verb) ?? 0
    if (owed > 0) {
      this.late.set(verb, owed - 1)
      return true
    }
    const queue = this.pending.get(verb)
    if (!queue || queue.length === 0) return false
    queue.shift()?.(message)
    return true
  }

  /**
   * Sends one command and waits for the helper's answer.
   *
   * Timed out rather than awaited forever: this is driving the user's
   * desktop, and a step that never settles leaves the rest of a plan hanging
   * with no way to see why. The timeout resolves with a readable failure so
   * the card can show it.
   */
  send(command: string, timeoutMs = 4000): Promise<string> {
    const stdin = this.child?.stdin
    const verb = command.split(' ')[0]
    if (!this.ready || !stdin?.writable) {
      return Promise.resolve(`${verb} FAILED helper-not-running`)
    }
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
        this.late.set(verb, (this.late.get(verb) ?? 0) + 1)
        settle(`${verb} FAILED no-reply-in-${timeoutMs}ms`)
      }, timeoutMs)
      queue.push(settle)
      this.pending.set(verb, queue)
      stdin.write(command + String.fromCharCode(10))
    })
  }

  activate(hwnd: bigint): void {
    const stdin = this.child?.stdin
    if (!this.ready || !stdin?.writable) return
    stdin.write(`ACTIVATE ${hwnd.toString()}${String.fromCharCode(10)}`)
  }

  stop(): void {
    this.stopping = true
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
    this.ready = false
  }
}
