import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { ShellKind, ShellResult } from '@shared/types'

/** Hard ceiling on a single command, in ms. */
const TIMEOUT_MS = 120_000
/** Captured output is truncated past this, per stream. */
const MAX_OUTPUT = 100_000

/**
 * Patterns worth a second look before running.
 *
 * This is advisory, not a blocklist: it drives a red card and a native
 * confirmation dialog so the user sees what they are agreeing to. Wumpy does
 * not try to decide what is safe on the user's behalf, because a pattern list
 * is trivially sidestepped and would only create false confidence.
 */
const RISKY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: 'recursive or forced delete' },
  { pattern: /\bRemove-Item\b[^|]*-Recurse/i, why: 'recursive delete' },
  { pattern: /\bdel\s+\/[sq]/i, why: 'recursive or quiet delete' },
  { pattern: /\bformat\s+[a-z]:/i, why: 'formats a drive' },
  { pattern: /\bdiskpart\b/i, why: 'partitions disks' },
  { pattern: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, why: 'shuts down or restarts' },
  { pattern: /\breg(\.exe)?\s+delete\b/i, why: 'deletes registry keys' },
  { pattern: /\bRemove-ItemProperty\b/i, why: 'deletes registry values' },
  { pattern: /\b(Set-ExecutionPolicy|icacls|takeown)\b/i, why: 'changes security settings' },
  {
    pattern: /\b(curl|wget|Invoke-WebRequest|iwr)\b[^|]*\|\s*(iex|sh|bash|Invoke-Expression)/i,
    why: 'pipes a download straight into a shell'
  },
  {
    pattern: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i,
    why: 'rewrites or publishes git state'
  },
  { pattern: />\s*\/dev\/sd|dd\s+if=/i, why: 'writes directly to a device' }
]

/**
 * Command heads considered read-only: they report, they do not change.
 *
 * This is an allowlist, not a blocklist, because a blocklist of dangerous
 * commands is endless and a miss is unrecoverable. Anything not named here is
 * treated as a write, which only means it needs the Developer tiers.
 */
const READ_ONLY = new Set([
  // PowerShell: Get-* is reporting by convention, plus a few explicit others.
  'get-childitem',
  'get-command',
  'get-content',
  'get-date',
  'get-computerinfo',
  'get-process',
  'get-service',
  'get-psdrive',
  'get-location',
  'get-host',
  'get-item',
  'get-itemproperty',
  'get-member',
  'get-module',
  'get-volume',
  'get-ciminstance',
  'get-wmiobject',
  'get-filehash',
  'get-help',
  'get-history',
  // Installed-app queries. Asked for by "is X installed" and by "open X",
  // which has to find out before it can decide between launching the app and
  // opening the website. Get-AppxPackage was missing, so a Quick tier could
  // search the uninstall registry but not see a Store app - which on Windows
  // is where half the consumer apps live.
  'get-appxpackage',
  'get-appxprovisionedpackage',
  'get-startapps',
  'get-package',
  'test-path',
  'measure-object',
  'select-object',
  'where-object',
  'sort-object',
  'compare-object',
  'format-table',
  'format-list',
  'resolve-path',
  'split-path',
  // The aliases people and models actually type. Each is the exact cmdlet
  // directly above it, so allowing one and refusing the other was a
  // difference in spelling, not in what the command does - and it refused
  // `Get-AppxPackage | Select Name`, which is the shape asked for by "is this
  // app installed". A script block smuggled into any of them is caught
  // separately and still is.
  'select',
  'sort',
  'measure',
  'group',
  'group-object',
  'ft',
  'fl',
  'gci',
  'gi',
  'gp',
  'gm',
  'gcm',
  'gal',
  'gl',
  'gh',
  'join-path',
  'convertfrom-json',
  'convertto-json',
  'out-string',
  'write-output',
  // Classic shell equivalents.
  'dir',
  'ls',
  'cat',
  'type',
  'echo',
  'where',
  'whoami',
  'hostname',
  'date',
  'systeminfo',
  'tasklist',
  'ver',
  'tree',
  'find',
  'findstr',
  'wc',
  'head',
  'tail',
  // Version and status probes for common tools.
  'node',
  'npm',
  'npx',
  'python',
  'python3',
  'pip',
  'dotnet',
  'java',
  'go',
  'rustc',
  'cargo',
  'ollama',
  'git',
  'code',
  'pwsh',
  'powershell'
])

/**
 * Tools whose safety depends entirely on their arguments.
 *
 * These are listed as the reads they are allowed to do, not the writes they are
 * forbidden — the same reasoning as the top-level allowlist, applied a level
 * deeper. Blocklisting write subcommands was tried first and leaked badly:
 * `node -e "<anything>"` is arbitrary code, `python -m http.server` starts a
 * server, `find . -delete` deletes, and `git config --global` rewrites settings,
 * all of which passed a "head is on the list, subcommand is not a known write"
 * test.
 */
const READ_SUBCOMMANDS: Record<string, string[]> = {
  git: ['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'ls-files', 'shortlog'],
  npm: ['list', 'ls', 'view', 'outdated', 'ping', 'root', 'prefix', 'why'],
  pip: ['list', 'show', 'freeze'],
  ollama: ['list', 'ps', 'show'],
  go: ['version', 'env', 'list'],
  cargo: ['tree', 'metadata'],
  dotnet: ['--list-sdks', '--list-runtimes', '--info'],
  // Interpreters and editors get nothing but their version and help flags:
  // every one of them can run arbitrary code given an argument.
  node: [],
  npx: [],
  python: [],
  python3: [],
  java: [],
  rustc: [],
  pwsh: [],
  powershell: [],
  code: []
}

/** Always safe on any of the tools above. */
const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version', '--help', '-h', '-?', '/?'])

/** Flags that make an otherwise harmless search tool act. */
const DANGEROUS_FIND_FLAGS = /(^|\s)-(exec|execdir|delete|ok|okdir|fls|fprint|fprintf)(\s|$)/i

/** Anything here means the command writes somewhere, whatever its head says. */ /** Anything here means the command writes somewhere, whatever its head says. */
const WRITE_MARKERS =
  /(^|\s)(>|>>|\||&&|;)\s*(set-|new-|remove-|clear-|stop-|start-|restart-|rename-|move-|copy-|out-file|tee-object)|(^|\s)(set-|new-|remove-|clear-|rename-|move-|copy-|stop-|start-|restart-)[a-z]+|(^|\s)(rm|del|rmdir|rd|mkdir|md|move|copy|xcopy|robocopy|format|diskpart|reg|sc|net|shutdown|taskkill|icacls|takeown|attrib)(\s|$)|>\s*\S/i

/**
 * Classifies a command as read-only or not.
 *
 * Used to let the Quick tiers act without handing them the whole machine: they
 * may look things up, and anything that changes state needs a Developer tier.
 */
export function isReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  // Redirection, piping into a mutating cmdlet, or any write-shaped verb.
  if (WRITE_MARKERS.test(trimmed)) return false

  // Every segment of a pipeline has to be read-only on its own.
  const segments = trimmed.split(/\||;|&&/)
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const head = tokens[0].toLowerCase().replace(/\.exe$/, '')
    if (!READ_ONLY.has(head)) return false

    // `find` searches harmlessly until told to act on what it finds.
    if (head === 'find' && DANGEROUS_FIND_FLAGS.test(segment)) return false

    const reads = READ_SUBCOMMANDS[head]
    if (reads) {
      const args = tokens.slice(1).map((t) => t.toLowerCase())
      // Nothing but version or help flags is always fine.
      const onlyFlags = args.length === 0 || args.every((a) => VERSION_FLAGS.has(a))
      if (onlyFlags) continue

      // Otherwise the first argument must be one of this tool's read commands.
      const first = args.find((a) => !a.startsWith('-')) ?? args[0]
      if (!reads.includes(first)) return false
      // A read subcommand must not then be handed a flag that writes.
      if (
        /(^|\s)(--global|--system|-w\b|--write|--set\b|--delete\b|--force\b|-f\b)/i.test(segment)
      ) {
        return false
      }
    }
  }
  return true
}

export function assessRisk(command: string): string | null {
  for (const { pattern, why } of RISKY) {
    if (pattern.test(command)) return why
  }
  return null
}

/** Argv for each supported shell. */
function launcher(kind: ShellKind, command: string): { file: string; args: string[] } {
  switch (kind) {
    case 'cmd':
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
    case 'bash':
      return { file: 'bash', args: ['-lc', command] }
    case 'powershell':
    default:
      // -NoProfile keeps startup fast and avoids a user profile changing
      // behaviour; -NonInteractive makes a prompt fail rather than hang.
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
      }
  }
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_OUTPUT)}\n…output truncated…`, truncated: true }
}

/**
 * Runs one command and resolves with everything the UI needs to show.
 *
 * Never rejects: a failure to launch is reported as a result with an exit code,
 * so the caller has one shape to handle.
 */
export function runCommand(command: string, kind: ShellKind, cwd?: string): Promise<ShellResult> {
  const started = Date.now()
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const { file, args } = launcher(kind, command)
  const readOnly = isReadOnly(command)

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: workingDir,
        windowsHide: true,
        // No shell:true — args are passed as an array, so the command string is
        // only ever interpreted by the shell we explicitly chose.
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
      })
    } catch (err) {
      resolve({
        command,
        shell: kind,
        cwd: workingDir,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false,
        readOnly
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, TIMEOUT_MS)

    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += c.toString('utf8')
    })

    child.on('error', (err) => {
      stderr += `\n${err.message}`
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const out = clip(stdout)
      const errOut = clip(stderr)
      resolve({
        command,
        shell: kind,
        cwd: workingDir,
        stdout: out.text,
        stderr: errOut.text,
        exitCode: timedOut ? -1 : (code ?? -1),
        durationMs: Date.now() - started,
        timedOut,
        truncated: out.truncated || errOut.truncated,
        readOnly
      })
    })
  })
}
