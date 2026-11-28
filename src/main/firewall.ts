/**
 * The firewall, checked and opened for Wi-Fi sync: see @shared/firewall for
 * what is checked and why. Opening always goes through the system's own
 * password pop-up - pkexec on Linux, the administrator prompt on Windows -
 * never a stored password.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { rootable } from './elevate'
import {
  SYNC_PORT,
  encoded,
  ufwVerdict,
  windowsAllowScript,
  windowsCheckScript,
  windowsElevateScript,
  windowsVerdict,
  type FirewallVerdict,
  type WindowsFacts
} from '@shared/firewall'

function powershell(script: string, timeout: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(script)],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => resolve({ ok: !err, out: String(out ?? '') })
    )
  })
}

function readOr(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Whether their other devices can reach this one, now. */
export async function checkFirewall(): Promise<FirewallVerdict> {
  if (process.platform === 'win32') {
    const r = await powershell(windowsCheckScript(process.execPath), 30_000)
    let facts: WindowsFacts | null = null
    try {
      const j = JSON.parse(r.out.trim()) as Partial<WindowsFacts>
      facts = {
        category: String(j.category ?? ''),
        profiles: Array.isArray(j.profiles) ? j.profiles : [],
        app: Array.isArray(j.app) ? j.app : [],
        port: Array.isArray(j.port) ? j.port : []
      }
    } catch {
      facts = null
    }
    return windowsVerdict(facts)
  }
  if (process.platform === 'linux') {
    return ufwVerdict(readOr('/etc/ufw/ufw.conf'), readOr('/etc/ufw/user.rules'))
  }
  return { state: 'unknown', why: 'Wumpy cannot check the firewall on this system.' }
}

/** Opens it, behind the system's password pop-up; then checks again. */
export async function allowThroughFirewall(owner?: bigint): Promise<FirewallVerdict> {
  if (process.platform === 'win32') {
    const r = await powershell(windowsElevateScript(windowsAllowScript(), owner), 180_000)
    const after = await checkFirewall()
    return r.ok || after.state === 'open' ? after : { ...after, why: `Not allowed: the administrator prompt was declined. ${after.why}` }
  }
  if (process.platform === 'linux') {
    /* Through the user's systemd when this process cannot gain root itself (main/elevate.ts). */
    const run = rootable('/usr/bin/pkexec', ['/usr/bin/ufw', 'allow', String(SYNC_PORT), 'comment', 'Wumpy skills sync'])
    const r = await new Promise<{ ok: boolean; code: number | null; err: string }>((resolve) =>
      execFile(run.file, run.args, { timeout: 180_000 }, (err, _out, stderr) =>
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : null) : 0, err: String(stderr ?? '').trim() })
      )
    )
    const after = await checkFirewall()
    if (r.ok || after.state === 'open') return after
    /* 126 is pkexec's "they closed the box"; anything else is not them saying no, and is said as it is. */
    const why =
      r.code === 126 || /dismissed|not authorized/i.test(r.err)
        ? 'Not allowed: the password prompt was closed.'
        : `The password prompt could not open${r.err ? ` (${r.err.split('\n').pop()?.slice(0, 120)})` : ''}.`
    return { ...after, why: `${why} ${after.why}` }
  }
  return checkFirewall()
}

/** Checked, and opened if it needs to be: before pairing, which is when it is needed. */
export async function ensureFirewall(owner?: bigint): Promise<FirewallVerdict> {
  const now = await checkFirewall()
  return now.state === 'closed' || now.state === 'blocked' ? allowThroughFirewall(owner) : now
}
