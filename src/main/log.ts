import { app } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A log file, because the console was going nowhere.
 *
 * `npm run restart` spawns Wumpy detached with stdio: 'ignore' - it has to,
 * or the app would die with the terminal that started it. The consequence
 * went unnoticed for a long time: every diagnostic line the app writes has
 * been going into a closed pipe.
 *
 * That turned one bug in particular into folklore. Autofocus has been
 * "fixed" five times, and each attempt added instrumentation saying exactly
 * what happened - `gave up waiting for the keyboard after 600ms`, `forced
 * foreground DID NOT WORK` - and not one of those lines was ever readable.
 * Five rounds of guessing at a problem that was already explaining itself.
 *
 * So: a file. Appended to synchronously, because the interesting lines are
 * written in the moments around a crash or a hang, and a buffered write is
 * one that does not survive either.
 */

/** Keep the tail, not the head: what just happened is what is being debugged. */
const MAX_BYTES = 512 * 1024

let path: string | null = null

/** Where the log lives. Beside the settings, so `/open logs` can find it. */
export function logPath(): string {
  if (path) return path
  const dir = app.getPath('userData')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* already there */
  }
  path = join(dir, 'wumpy.log')
  return path
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Halve the file when it gets long, keeping the recent end. */
function trim(file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.slice(Math.floor(text.length / 2)))
  } catch {
    /* a log that cannot be trimmed is not worth an error */
  }
}

/** One line, timestamped. Never throws: logging must not break the app. */
export function log(line: string): void {
  try {
    const file = logPath()
    trim(file)
    appendFileSync(file, `[${stamp()}] ${line}${String.fromCharCode(10)}`)
  } catch {
    /* no log is bad; a crash from logging is worse */
  }
}

/**
 * Send everything the app already says to the file as well as the console.
 *
 * Deliberately a wrapper rather than a replacement: `npm run dev` runs
 * attached to a terminal and the console is genuinely useful there. This
 * only adds the copy that survives being detached.
 */
export function captureConsole(): void {
  const levels: Array<['log' | 'warn' | 'error', string]> = [
    ['log', ''],
    ['warn', 'WARN '],
    ['error', 'ERROR ']
  ]
  for (const [level, prefix] of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      log(prefix + args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    }
  }
}
