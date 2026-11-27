/**
 * The firewall, checked and opened for Wi-Fi sync: see @shared/firewall for
 * what is checked and why. Opening always goes through the system's own
 * password pop-up - pkexec on Linux, the administrator prompt on Windows -
 * never a stored password.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
export async function allowThroughFirewall(): Promise<FirewallVerdict> {
  if (process.platform === 'win32') {
    const r = await powershell(windowsElevateScript(windowsAllowScript()), 180_000)
    const after = await checkFirewall()
    return r.ok || after.state === 'open' ? after : { ...after, why: `Not allowed: the administrator prompt was declined. ${after.why}` }
  }
  if (process.platform === 'linux') {
    const ok = await new Promise<boolean>((resolve) =>
      execFile('pkexec', ['/usr/bin/ufw', 'allow', String(SYNC_PORT), 'comment', 'Wumpy skills sync'], { timeout: 180_000 }, (err) => resolve(!err))
    )
    const after = await checkFirewall()
    return ok || after.state === 'open' ? after : { ...after, why: `Not allowed: the password prompt was declined. ${after.why}` }
  }
  return checkFirewall()
}

/** Checked, and opened if it needs to be: before pairing, which is when it is needed. */
export async function ensureFirewall(): Promise<FirewallVerdict> {
  const now = await checkFirewall()
  return now.state === 'closed' || now.state === 'blocked' ? allowThroughFirewall() : now
}
