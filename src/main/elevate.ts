import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/**
 * The password pop-up on Linux, even when this process may not ask for one.
 *
 * pkexec is setuid root, and the kernel ignores setuid in a process that has
 * "no new privileges" set - which is inherited, and cannot be cleared. A
 * Wumpy started from something that set it (a sandboxed terminal, a service
 * with NoNewPrivileges=) passes it on through every restart, and then every
 * pkexec fails at once with "pkexec must be setuid root": no pop-up at all,
 * and Settings said "the password prompt was declined". Clicking Allow did
 * nothing, which is how it was found.
 *
 * So, when it is set, the command is handed to the user's systemd instead
 * (systemd-run --user): it runs as a service of theirs, outside this process
 * tree and without the flag, and the polkit agent asks for the password as
 * it would for anything else. --wait and --pipe keep its output and its exit
 * code. Without the flag, nothing changes.
 */

let flagged: boolean | null = null

/** Whether this process has "no new privileges": setuid programs (pkexec, sudo) cannot gain root from it. */
export function noNewPrivs(): boolean {
  if (flagged !== null) return flagged
  try {
    flagged = process.platform === 'linux' && /^NoNewPrivs:\s*1\b/m.test(readFileSync('/proc/self/status', 'utf8'))
  } catch {
    flagged = false
  }
  return flagged
}

/** A command that asks for root through a setuid program. */
export const asksForRoot = (command: string): boolean => /(^|[\s;&|(`])(pkexec|sudo|doas)(\s|$)/.test(command)

const SYSTEMD_RUN = ['/usr/bin/systemd-run', '/bin/systemd-run'].find((p) => existsSync(p))

/**
 * `file args` as they should be started so a password pop-up can work: as
 * given, or through the user's systemd when this process cannot gain root.
 * `unit` is set when it goes through systemd, to stop it by.
 */
export function rootable(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): { file: string; args: string[]; unit?: string } {
  if (!noNewPrivs() || !SYSTEMD_RUN) return { file, args }
  const unit = `wumpy-root-${randomBytes(4).toString('hex')}`
  /* The command's environment, as it would have had it: a service starts with the manager's. */
  const env = Object.entries(opts.env ?? process.env)
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !/[\n\0]/.test(v))
    .map(([k, v]) => `--setenv=${k}=${v}`)
  return {
    file: SYSTEMD_RUN,
    args: [
      '--user',
      '--wait',
      '--pipe',
      '--collect',
      '--quiet',
      `--unit=${unit}`,
      ...(opts.cwd ? [`--working-directory=${opts.cwd}`] : []),
      ...env,
      '--',
      file,
      ...args
    ],
    unit
  }
}

/** Stops one started through systemd: killing systemd-run alone leaves the service running. */
export function stopUnit(unit: string | undefined): void {
  if (unit) execFile('systemctl', ['--user', 'stop', unit], () => undefined)
}
