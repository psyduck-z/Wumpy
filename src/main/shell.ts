import { asksForRoot, rootable, stopUnit } from './elevate'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { ShellKind, ShellResult } from '@shared/types'
import { protectedPlace } from '@shared/writefile'

/**
 * Hard ceiling on a single command, in ms.
 *
 * Two minutes was enough while commands were questions - a version, a listing,
 * whether something is installed. It stopped being enough once Wumpy could be
 * asked to install something: `winget install Spotify.Spotify` on an ordinary
 * connection runs well past it, and the kill arrives in the middle of a real
 * installation.
 *
 * Ten minutes instead. Nothing is blocked while it runs - the panel stays
 * usable and the card says "running…" - so the cost of waiting too long is
 * patience, while the cost of cutting too early was an install reported as
 * finished when it was not.
 */
const TIMEOUT_MS = 600_000
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
/**
 * `reversible` means accept-all may run it without stopping to ask.
 *
 * Accept-all is meant to mean accept all. Uninstalling an app interrupted
 * it with a native dialog, and an uninstall is not data loss - the app can
 * be installed again, which is the test that separates the two. Deleting
 * files, disabling Defender and writing into Startup are not undone by
 * reinstalling anything, so those still ask however impatient the mode is.
 *
 * The dialog still fires for these in the manual and auto modes, where the
 * user has not said "stop asking me".
 */
const RISKY: Array<{ pattern: RegExp; why: string; reversible?: boolean }> = [
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
  { pattern: />\s*\/dev\/sd|dd\s+if=/i, why: 'writes directly to a device' },
  // Linux.
  { pattern: /(^|[\s;&|(])(sudo|pkexec|doas|su)\s/i, why: 'runs as root' },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b|\bwipefs\b|\b(fdisk|parted|sgdisk)\b/i, why: 'partitions or formats a disk' },
  { pattern: /\b(chmod|chown)\s+(-[a-z]*R[a-z]*\s+)/, why: 'changes permissions recursively' },
  { pattern: /\b(pacman|yay|paru)\s+-R/, why: 'removes a package', reversible: true },
  { pattern: /\bsystemctl\s+(--user\s+)?(disable|mask|stop)\b/i, why: 'turns a service off', reversible: true },
  /**
   * Uninstalling, which was not here and should have been.
   *
   * Asked to uninstall Spotify, Wumpy found the UninstallString and stopped,
   * because the prompt told it to hand the path over rather than act. That
   * was the wrong protection in the wrong place: the user had asked for an
   * uninstall and got a piece of homework.
   *
   * The right protection is the one the app already has for everything else
   * destructive — the card they click, and the native dialog that fires even
   * on accept-all. Measured before adding these: running uninstall.exe was
   * classified "not risky", so neither would have fired. The prompt can only
   * safely say "go ahead and propose it" once this does.
   */
  { pattern: /\bunins(tall)?[\w-]*\.exe\b/i, why: 'runs an uninstaller', reversible: true },
  { pattern: /\bmsiexec\b[^|]*\/(x|uninstall)\b/i, why: 'uninstalls a program', reversible: true },
  { pattern: /\bwinget\s+uninstall\b/i, why: 'uninstalls a program', reversible: true },
  {
    pattern: /\bRemove-Appx(Provisioned)?Package\b/i,
    why: 'removes an installed app',
    reversible: true
  },
  {
    pattern: /\bUninstall-(Package|Module|WindowsFeature)\b/i,
    why: 'uninstalls a program',
    reversible: true
  },
  /**
   * Everything below was missing, and the gap was wider than the list.
   *
   * `Remove-Item -Recurse` was here and almost nothing else, so this
   * described one shape of damage and missed the rest. Measured against 24
   * destructive commands, 23 raised no dialog: deleting every *.png in a
   * folder, `rmdir /s /q` over Downloads, moving a tree to another drive,
   * turning the firewall off, disabling Defender's real-time monitoring,
   * excluding C:\ from scanning, stopping the firewall service.
   *
   * On accept-all that is not merely a skipped dialog. judge() marks a
   * command that is not risky as `auto`, and CommandCard then runs it with
   * no click at all - so this list was the only thing standing between the
   * model's first guess and the user's files, and it was one line long.
   *
   * The line drawn here is whether clicking again undoes it. Creating a file
   * or a folder is reversible and may still run unattended; destroying,
   * moving, renaming, killing and disabling are not, so they ask first. That
   * keeps accept-all meaning "do not make me approve every read and every
   * new file" rather than "change my security settings quietly".
   *
   * The short aliases are anchored to a command position. Matching a bare
   * `move` or `del` anywhere would flag a path or a -match pattern that
   * merely contains the word, and a read that raises a dialog is its own
   * kind of broken.
   */
  { pattern: /\bRemove-Item\b/i, why: 'deletes files' },
  { pattern: /\b(rmdir|rd)\b[^|]*\/s/i, why: 'recursively deletes a folder' },
  { pattern: /\bMove-Item\b/i, why: 'moves files' },
  { pattern: /\bRename-Item\b/i, why: 'renames files' },
  { pattern: /\bClear-Content\b/i, why: 'empties a file' },
  { pattern: /\bClear-RecycleBin\b/i, why: 'empties the recycle bin' },
  { pattern: /\b(Set-Content|Out-File)\b/i, why: 'overwrites a file' },
  {
    pattern: /(?:^|[|;&]\s*)\s*(del|erase|move|ren|rd|rmdir|mv)\b/i,
    why: 'deletes, moves or renames files'
  },
  { pattern: /\bvssadmin\b[^|]*\bdelete\b/i, why: 'deletes shadow copies' },
  // Protection being switched off, which is the one a user would never want
  // to discover after the fact.
  { pattern: /\bSet-NetFirewallProfile\b/i, why: 'changes the firewall' },
  { pattern: /\bnetsh\b[^|]*\badvfirewall\b[^|]*\bset\b/i, why: 'changes the firewall' },
  { pattern: /\b(Set|Add|Remove)-MpPreference\b/i, why: 'changes Defender settings' },
  { pattern: /\bDisable-\w+/i, why: 'turns something off' },
  { pattern: /\b(Stop|Set|Suspend)-Service\b/i, why: 'stops or reconfigures a service' },
  { pattern: /\bStop-Process\b/i, why: 'kills a running program' },
  { pattern: /\bbcdedit\b/i, why: 'changes how Windows boots' },
  // Registry writes. The delete side was already here; the write side was
  // not, and Run-key persistence is a write.
  { pattern: /\b(New|Set)-ItemProperty\b/i, why: 'changes the registry' },
  { pattern: /\breg(\.exe)?\s+(add|import)\b/i, why: 'changes the registry' },
  // Accounts, and anything that arranges to run again later.
  { pattern: /\b(New|Set|Remove)-LocalUser\b|\bnet\s+user\b/i, why: 'changes user accounts' },
  {
    pattern: /\bAdd-LocalGroupMember\b|\bnet\s+localgroup\b/i,
    why: 'changes group membership'
  },
  {
    pattern: /\b(Register|Unregister)-ScheduledTask\b|\bschtasks\b[^|]*\/(create|delete)/i,
    why: 'changes scheduled tasks'
  },
  /**
   * The one read in here, and it earns its place.
   *
   * Asked to list every file on the computer, the model proposed
   * `Get-ChildItem -Recurse -File -Path C:\`. Nothing is destroyed, so every
   * other rule here says let it run - and on accept-all it would start by
   * itself and spend minutes thrashing the disk to produce more lines than
   * any window can hold. Being told first is the whole value.
   *
   * Both halves must be present: a recursive walk, and a bare drive root. A
   * recursive scan of a named folder is ordinary and stays unattended, and a
   * drive root with no recursion is one directory listing.
   *
   * `dir /s` is the same request in cmd and was missed by a -Recurse-only
   * test, which a check caught.
   */
  {
    pattern:
      /(?=[\s\S]*(?:-Recurse\b|\bdir\b[\s\S]*?\/s\b))(?=[\s\S]*(?:^|\s)[A-Za-z]:[\\/]?(?:\s|$))/i,
    why: 'scans an entire drive, which takes minutes'
  },
  /**
   * The same hazard with the path left off, which is the version the model
   * kept writing after it had been taught not to name a drive:
   * `Get-ChildItem -Recurse -File` walks everything below wherever commands
   * run from, which is their whole profile.
   *
   * Recognised by the absence of anything path-shaped - a separator, a `~`,
   * an $env: or an [Environment] lookup - because a -Recurse that names
   * where to start is ordinary work and must stay unattended.
   */
  {
    pattern:
      /^(?=[\s\S]*-Recurse\b)(?![\s\S]*(?:[\\/]|~|\$env:|\$home|\[Environment\]|\$PSScriptRoot))/i,
    why: 'scans everything below the working folder'
  }
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
  // Found by bench-ceiling: the correct percentage command was refused for
  // want of this one name. It transforms what it is handed and changes
  // nothing itself - what matters is the script block it is given, and the
  // sweep below now looks inside those.
  /**
   * The two New- cmdlets that create a value rather than a thing.
   *
   * New-TimeSpan is how date arithmetic is written, and the gate refused
   * the correct answer to "how many hours has my machine been up" because
   * every new- prefix was treated as a write. New-Object is NOT here and
   * must not be: it builds COM objects, and a WScript.Shell is how a model
   * wrote a .lnk into the Startup folder.
   */
  'new-timespan',
  'new-guid',
  // Windows tools that only report when given their status flag; the
  // flags themselves are vetted by READ_SUBCOMMANDS below.
  'manage-bde',
  'foreach-object',
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
  'powershell',
  // Linux: reports about the machine, which change nothing.
  'ps',
  'df',
  'du',
  'free',
  'uptime',
  'uname',
  'nproc',
  'lsblk',
  'lscpu',
  'lspci',
  'lsusb',
  'id',
  'groups',
  'pwd',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'stat',
  'file',
  'which',
  'whereis',
  /* Only as `command -v name`, which says where a program is: given anything
     else, command RUNS its argument. See flagsRead. */
  'command',
  /* Do nothing at all: `command -v a b 2>/dev/null || true` was refused for its true. */
  'true',
  'false',
  'printenv',
  'sensors',
  /* Filters, which read what they are piped and print it: `upower -e |
     grep BAT` and `grep -r TODO src` were refused for want of a name here.
     None of these can write except through a redirect, which is caught
     on its own. sed is not here: it can write by itself (w, -i). awk can
     too, and is here only for the programs that cannot - see flagsRead. */
  'grep',
  'awk',
  'gawk',
  'mawk',
  'egrep',
  'fgrep',
  'rg',
  'cut',
  'tr',
  'nl',
  // Battery and power: queries only, below.
  'upower',
  // Linux tools that both read and change things: only their reads, below.
  'pacman',
  'yay',
  'hyprctl',
  'systemctl',
  'bluetoothctl',
  'wpctl',
  'rfkill'
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
  /**
   * Windows tools whose reporting verb is a flag rather than a word.
   *
   * manage-bde -status is how you ask about BitLocker without elevation,
   * and the gate refused it - so a question about disk encryption failed
   * as "not read-only" rather than as the permission error it really is.
   * Found by the ladder on a second model. -on, -off and -lock are not
   * here and stay behind a click.
   *
   * `sc query` and `netsh ... show` are deliberately absent. sc is in
   * WRITE_MARKERS and is also PowerShell's alias for Set-Content, and
   * netsh puts its verb third - `netsh advfirewall show` - which does not
   * fit a first-argument rule and is not worth bending one for.
   * Get-Service and Get-NetFirewallProfile answer both questions.
   */
  'manage-bde': ['-status', '/status'],
  // Queries only: -S installs, -R removes, dispatch and keyword change the
  // desktop, start and enable change services.
  pacman: ['-Q', '-Qi', '-Qs', '-Ql', '-Qe', '-Qm', '-Qo', '-Qq', '-Qqe', '-Qdt', '-Si', '-Ss', '-Sl'],
  yay: ['-Q', '-Qi', '-Qs', '-Qm', '-Si', '-Ss'],
  hyprctl: ['version', 'monitors', 'workspaces', 'activeworkspace', 'clients', 'activewindow', 'devices', 'getoption', 'binds', 'layers', 'instances', 'cursorpos', 'systeminfo'],
  systemctl: ['status', 'list-units', 'list-unit-files', 'list-timers', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat'],
  bluetoothctl: ['devices', 'info', 'show', 'list', 'paired-devices'],
  wpctl: ['status', 'inspect', 'get-volume'],
  /* list reports; block and unblock switch radios. */
  rfkill: ['list'],
  /* -i and -e report; --monitor never ends, and nothing here changes power. */
  upower: ['-i', '-e', '-d', '--dump', '--enumerate', '--show-info', '--version'],
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
/**
 * `-version` with one dash is what ffmpeg and java use, and omitting it
 * refused `ffmpeg -version` while allowing `ffmpeg --version`, which is the
 * allowlist being wrong about the world rather than careful.
 */
const VERSION_FLAGS = new Set([
  '--version',
  '-version',
  '-v',
  '-V',
  'version',
  '--help',
  '-h',
  '-?',
  '/?'
])

/** Flags that make an otherwise harmless search tool act. */
const DANGEROUS_FIND_FLAGS = /(^|\s)-(exec|execdir|delete|ok|okdir|fls|fprint0?|fprintf)(\s|$)/i

/** Anything here means the command writes somewhere, whatever its head says. */
const WRITE_MARKERS =
  /(^|\s)(>|>>|\||&&|;)\s*(set-|new-(?!timespan|guid)|remove-|clear-|stop-|start-|restart-|rename-|move-|copy-|out-file|tee-object)|(^|\s)(set-|new-(?!timespan|guid)|remove-|clear-|rename-|move-|copy-|stop-|start-|restart-)[a-z]+|(^|\s)(rm|del|rmdir|rd|mkdir|md|move|copy|xcopy|robocopy|format|diskpart|reg|sc|net|shutdown|taskkill|icacls|takeown|attrib|ri|mi|rni|clc|si|sp|spps|spsv|kill|erase)(\s|$)|>\s*\S/i

/**
 * Classifies a command as read-only or not.
 *
 * Used to decide what may run unattended: a read can run itself on the `auto`
 * approval mode, and anything that changes state waits for a click.
 */
/**
 * Whether a cmdlet reports rather than changes.
 *
 * The allowlist named Get-* cmdlets one by one, with a comment saying "Get-*
 * is reporting by convention" directly above the enumeration - so every
 * cmdlet nobody had thought of was a gap, and each one shows up as a
 * harmless command refusing to auto-run. bench-ceiling turned up Get-Volume
 * and Get-WmiObject within ten questions, which is enough to stop adding
 * them individually.
 *
 * Get is Microsoft's own verb for "read and return", and PowerShell's verb
 * guidance is explicit that it must not change state. Trusting the verb
 * closes the whole class. The named list stays for everything that does not
 * follow the convention - test-, measure-, select- and the external tools.
 */
function isReadingCmdlet(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('get-') || READ_ONLY.has(lower)
}

/**
 * Splits on the pipes and statement separators that really are separators.
 *
 * A flat `split(/\||;|&&/)` cut inside a calculated property: the `;` in
 * `@{n="MB";e={[math]::Round($_.WS / 1MB)}}` was taken for a statement
 * boundary, so the gate read `e={[math` as a command name and refused a pure
 * read - the exact shape needed to answer "which program is using the most
 * memory, and how much". A `;` or `|` inside brackets, braces or quotes
 * belongs to the expression, not to the pipeline.
 */
/**
 * How a shell quotes, which decides where its commands start and end.
 *
 * Every quote was taken as a quote and nothing escaped one, so
 * `echo \"; touch x; echo \"` read as a single echo: bash takes `\"` as a
 * plain character, ends the echo at the `;`, and runs `touch`. PowerShell
 * escapes with a backtick, and in cmd a single quote is no quote at all -
 * `echo 'a & calc'` runs calc there. Found by checking the review's
 * findings, 2026-11.
 */
type Dialect = 'bash' | 'ps' | 'cmd'

/**
 * The shell a command will run in. Off Windows that is bash, whatever the
 * block was tagged (see launcher). On Windows, the one it is going to, and
 * PowerShell when it is not said - which is what runs it then.
 */
function dialectsFor(shell: ShellKind | undefined, platform: string): Dialect[] {
  if (platform !== 'win32') return ['bash']
  if (shell === 'cmd') return ['cmd']
  if (shell === 'bash') return ['bash']
  return ['ps']
}

/**
 * The command with everything quoted or escaped blanked to `_`, as `dialect`
 * reads it: same length, so a place in one is the same place in the other.
 * The quote marks themselves are kept. Structure is read from this; what
 * runs is still the original.
 */
function maskQuotes(command: string, dialect: Dialect): string {
  const out = command.split('')
  const esc = dialect === 'bash' ? '\\' : dialect === 'ps' ? '`' : '^'
  let quote: string | null = null
  /* bash's $'...', where a backslash escapes, unlike in '...'. */
  let ansi = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      const escapes =
        (dialect === 'bash' && c === '\\' && (quote === '"' || ansi)) || (dialect === 'ps' && c === '`' && quote === '"')
      if (escapes) {
        out[i] = '_'
        if (i + 1 < command.length) out[++i] = '_'
        continue
      }
      if (c === quote) {
        /* PowerShell doubles a quote to put one in: 'it''s'. */
        if (dialect === 'ps' && command[i + 1] === quote) {
          out[i] = '_'
          out[++i] = '_'
          continue
        }
        quote = null
        ansi = false
        continue
      }
      out[i] = '_'
      continue
    }
    if (c === esc) {
      out[i] = '_'
      if (i + 1 < command.length) out[++i] = '_'
      continue
    }
    if (c === '"' || (c === "'" && dialect !== 'cmd')) {
      quote = c
      ansi = dialect === 'bash' && c === "'" && command[i - 1] === '$'
    }
  }
  return out.join('')
}

function topLevelSegments(command: string, dialect: Dialect = 'bash'): string[] {
  const out: string[] = []
  let buf = ''
  let depth = 0
  const m = maskQuotes(command, dialect)

  for (let i = 0; i < command.length; i++) {
    const c = m[i]
    if (c !== command[i]) {
      buf += command[i]
      continue
    }
    /* cmd has no brackets that hold a `&` in, and no `;` between commands. */
    if (dialect !== 'cmd' && (c === '(' || c === '[' || c === '{')) depth++
    else if (dialect !== 'cmd' && (c === ')' || c === ']' || c === '}')) depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === '|' || (c === ';' && dialect !== 'cmd') || c === '\n' || c === '\r')) {
      /* A new line is a new command, as much as a `;` is: `cat a` and then
         `mv ~/Documents ~/.trash` on the next line was one read. */
      out.push(buf)
      buf = ''
      continue
    } else if (depth === 0 && c === '&' && command[i + 1] === '&') {
      out.push(buf)
      buf = ''
      i++
      continue
    } else if (depth === 0 && c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      /* One `&` ends a command too - bash's background, PowerShell's call
         operator - unless it is part of a redirect (`>&2`, `&>`). */
      out.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  out.push(buf)
  return out
}

/**
 * Redirections that throw output away or merge it, and write nothing:
 * `2>/dev/null`, `&>/dev/null`, `2>&1`, PowerShell's `2>$null`, cmd's `>nul`.
 *
 * Every one of these counted as a write. A background agent, on the `auto`
 * mode, asked `cat /sys/class/power_supply/BAT0/status 2>/dev/null` - the
 * ordinary way to read without noise - was told it "would change
 * something", and spent ten of its ten steps asking again. Only the exact
 * device is let through: `>/dev/nullx` is a file, and still a write.
 */
const harmlessRedirects = (platform: string): RegExp =>
  platform === 'win32'
    ? /(^|\s)(?:\d|&)?>>?\s*(?:\$null|nul)(?=$|[\s;|&)])|(^|\s)\d>&\d(?=$|[\s;|&)])/gi
    : /* Not $null or nul here: in bash `$null` is a variable that can hold
         any path, and `> nul` makes a file called nul. */
      /(^|\s)(?:\d|&)?>>?\s*\/dev\/null(?=$|[\s;|&)])|(^|\s)\d>&\d(?=$|[\s;|&)])/g

/**
 * The commands inside a command: `$(...)`, backticks, and bash's `<(...)`.
 *
 * None of these was looked at. `echo $(rm -rf ~/x)` has `echo` at its head
 * and nothing write-shaped where the sweeps look - `rm` follows a `(`, not
 * a space - so it counted as a read and ran by itself on the `auto` mode.
 * Found while letting background agents run reads. Each one is judged as a
 * command of its own now. A PowerShell subexpression that is only a
 * variable - `$($_.Length)` - has no command in it and is left alone.
 */
function substitutions(command: string): string[] {
  const out: string[] = []
  for (let i = 0; i < command.length; i++) {
    const two = command.slice(i, i + 2)
    if (two === '$(' || two === '<(' || two === '>(') {
      /* Quotes inside count as quotes: `$(echo ')';touch x)` ends at the
         second bracket, not the quoted one, so `touch` is seen. */
      let depth = 1
      let j = i + 2
      let quote: string | null = null
      for (; j < command.length && depth > 0; j++) {
        const c = command[j]
        if (quote) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") quote = c
        else if (c === '(') depth++
        else if (c === ')') depth--
      }
      out.push(command.slice(i + 2, j - 1))
      i = j - 1
    } else if (command[i] === '`') {
      const end = command.indexOf('`', i + 1)
      if (end < 0) {
        out.push(command.slice(i + 1))
        break
      }
      out.push(command.slice(i + 1, end))
      i = end
    }
  }
  /* Only a bare variable or property - `$_.Length`, `$env:USERNAME` - is
     not a command. `$($SHELL -c ...)` and `$($x; ri C:\temp -Recurse)`
     start with `$` too, and are. */
  return out.map((s) => s.trim()).filter((s) => s && !/^\$[\w:]+(?:\.\w+|\[[^\]]*\])*$/.test(s))
}

/**
 * .NET types whose static members only compute or report. Anything else
 * reached with `::` - `[Diagnostics.Process]::Start('calc')`,
 * `[IO.File]::WriteAllText(...)` - runs or writes, and a calculated
 * property's script block was never looked into for it.
 */
const PURE_TYPES =
  /^(?:system\.)?(?:math|io\.path|datetime|datetimeoffset|timespan|string|char|int|int16|int32|int64|uint32|uint64|long|double|single|float|decimal|byte|bool|boolean|convert|guid|version|regex|text\.regularexpressions\.regex|text\.encoding|bitconverter|uri|globalization\.cultureinfo)$/i
/** Types with both kinds of member: these ones only report. */
const READING_MEMBERS: Record<string, RegExp> = {
  environment:
    /^(?:get\w*|machinename|username|userdomainname|osversion|processorcount|is64bit\w*|currentdirectory|systemdirectory|tickcount(?:64)?|version|newline|commandline|userinteractive|systempagesize|workingset|specialfolder)$/i,
  'io.file': /^(?:exists|get\w+|read\w+)$/i,
  'io.directory': /^(?:exists|get\w+|enumerate\w+)$/i,
  'net.dns': /^gethostname$/i
}

/**
 * Methods that only compute a value from the one they are called on. A
 * method on a file, a folder or a process is how a read became a write:
 * `(Get-Item ~/Documents).Delete($true)`, `Where-Object { $_.Kill() }`.
 */
const PURE_METHODS =
  /^(?:to\w*|get\w*|trim\w*|substring|contains|containskey|containsvalue|startswith|endswith|split|replace|indexof|indexofany|lastindexof|padleft|padright|equals|compareto|add(?:days|hours|minutes|seconds|milliseconds|months|years|ticks)|subtract|normalize|format|join|count|tostring)$/i

/**
 * What PowerShell can do inside an expression that no command name shows:
 * call a .NET static, call a method, or set a property. Read from the
 * command with its quoted text blanked (maskQuotes), so a string that
 * mentions `.Delete(` is no reason to ask, and a call outside one is seen.
 */
function psExpressionsRead(masked: string): boolean {
  for (const m of masked.matchAll(/::/g)) {
    const before = masked.slice(0, m.index)
    const type = /\[\s*([\w.]+)\s*\]\s*$/.exec(before)?.[1]?.toLowerCase().replace(/^system\./, '')
    if (!type) return false
    const member = /^::\s*([A-Za-z_]\w*)/.exec(masked.slice(m.index))?.[1] ?? ''
    if (PURE_TYPES.test(type)) continue
    if (!READING_MEMBERS[type]?.test(member)) return false
  }
  /* A member named at run time - `.'Kill'()`, `.$m()` - can be anything. */
  if (/[\w)\]}]\.\s*['"$(]/.test(masked)) return false
  for (const m of masked.matchAll(/[\w)\]}]\.([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1]
    /* .Where({...}) and .ForEach({...}) filter; .ForEach('Kill') calls Kill. */
    if (/^(?:where|foreach)$/i.test(name)) {
      if (!/^\s*\{/.test(masked.slice(m.index + m[0].length))) return false
      continue
    }
    if (!PURE_METHODS.test(name)) return false
  }
  /* `(Get-Process x).PriorityClass = 'Idle'` changes the process. */
  if (/(?:[\w)\]}]\.|::\s*)[A-Za-z_]\w*\s*(?:[+\-*/%]|\?\?)?=(?!=)/.test(masked)) return false
  return true
}

/** The statement keywords whose own brackets are what runs. */
const KEYWORDS = /^(?:if|elseif|else|foreach|for|while|do|until|switch|try|catch|finally|trap|param|begin|process|end|function|filter)\b/i
/**
 * A statement that is a value rather than a command. Not `%` - ForEach-
 * Object's alias - nor `.`, which runs a script, nor `/`, a path.
 */
const EXPRESSION_START = /^[$\d(\[@\-!{"',]/

/**
 * Every command inside a bracket is judged as a command.
 *
 * Only Verb-Noun names were looked for inside brackets, so a bare name
 * there ran unseen: `Get-Content (calc)`, and `Select-Object @{e={ calc }}`
 * - a calculated property runs its block once for every row. Now each
 * statement inside `(...)` and `{...}` is either a value, whose own
 * brackets are looked into the same way, or a command, which has to be a
 * read like any other. `${HOME}` and bash's `$((1 + 2))` hold no command.
 */
function bracketsRead(raw: string, masked: string, dialect: Dialect, judge: (c: string) => boolean): boolean {
  const open = new Set(['(', '{'])
  for (let i = 0; i < masked.length; i++) {
    if (!open.has(masked[i])) continue
    const close = masked[i] === '(' ? ')' : '}'
    let depth = 1
    let j = i + 1
    for (; j < masked.length && depth > 0; j++) {
      if (masked[j] === masked[i]) depth++
      else if (masked[j] === close) depth--
    }
    const body = raw.slice(i + 1, depth === 0 ? j - 1 : j)
    const variable = masked[i] === '{' && masked[i - 1] === '$'
    const arithmetic = masked[i] === '(' && masked[i + 1] === '(' && masked[i - 1] === '$'
    if (!variable && !arithmetic && !statementsRead(body, dialect, masked[i] === '{' && masked[i - 1] === '@', judge)) return false
    i = j - 1
  }
  return true
}

function statementsRead(body: string, dialect: Dialect, hashtable: boolean, judge: (c: string) => boolean): boolean {
  for (const part of topLevelSegments(body, dialect)) {
    let s = part.trim().replace(/^\$[\w:]+\s*[+\-*/]?=(?!=)\s*/, '').replace(/^(?:return|throw|exit)\b\s*/i, '')
    /* In @{...} a bare word before `=` is a key; the value can still run. */
    if (hashtable) s = s.replace(/^[A-Za-z_][\w-]*\s*=(?!=)\s*/, '')
    if (!s) continue
    /* In bash everything in a bracket is a command - `( $SHELL -c x )` runs
       one - so only PowerShell (and cmd, where a `$` is just a letter) has
       values here. */
    if (dialect !== 'bash' && (KEYWORDS.test(s) || EXPRESSION_START.test(s))) {
      const m = maskQuotes(s, dialect)
      if (!bracketsRead(s, m, dialect, judge)) return false
      continue
    }
    if (!judge(s)) return false
  }
  return true
}

/**
 * The flags that make one of the allowed tools write or run something.
 * `segment` is one command; `masked` is the same with its quoted text
 * blanked.
 */
function flagsRead(head: string, segment: string, masked: string): boolean {
  const has = (re: RegExp): boolean => re.test(segment)
  switch (head) {
    /* `--output` writes what it is told to wherever it is told: git log
       --format=... --output=~/.bashrc writes a shell startup file. The rest
       run programs, or read another repository's settings. */
    case 'git':
      return !has(/(^|\s)(--output|--ext-diff|--textconv|--exec-path|--config-env|--git-dir|--work-tree)(=|\s|$)/i)
    /* Short options run together: -oFILE and -uo FILE write as -o does. */
    case 'sort':
      return !has(/(^|\s)(-[a-zA-Z]*o|--output|--compress-program|\/o)/i)
    /* tree -R writes a listing into every folder it visits. */
    case 'tree':
      return !has(/(^|\s)(-[a-zA-Z]*[oR]|--output)/)
    /* file -C compiles a magic file, which it writes. */
    case 'file':
      return !has(/(^|\s)(-[a-zA-Z]*C|--compile)/)
    case 'date':
      return !has(/(^|\s)(--set|-u?s)(?=[\s='"\d]|$)/)
    case 'hostname':
      /* Given a name, it renames the computer. */
      return !segment
        .trim()
        .split(/\s+/)
        .slice(1)
        .some((t) => !t.startsWith('-') || /^(-F|--file|-b|--boot)/.test(t))
    case 'hyprctl':
      return !has(/(^|\s)--batch(=|\s|$)/)
    case 'go':
      return !has(/(^|\s)--?(toolexec|exec|overlay)(=|\s|$)/)
    case 'sensors':
      return !has(/(^|\s)-[a-zA-Z]*s/)
    /*
     * awk, only when its program cannot write or run anything.
     *
     * Wumpy's own Linux prompt answers "how long has it been on" with
     * `awk '{printf "%.1f\n", $1/3600}' /proc/uptime`, and the gate refused
     * it for being awk - so the one question the prompt shows how to answer
     * waited for a click that df never needs. awk writes with print > file
     * (any > at all is already refused by WRITE_MARKERS, comparison or not),
     * runs with system() and | "cmd", and gawk writes with -o, -p, -d and
     * -i inplace, and loads code with -f, -i, -l and -E. So: no system, no
     * getline (it can run a command too), no | anywhere in the program, and
     * no flag but -F and -v.
     */
    /* The prompt's own install check is `command -v git && git --version`,
       and it was refused for its first word. */
    case 'command': {
      const words = masked.trim().split(/\s+/).slice(1)
      return words.length >= 2 && /^-[vV]$/.test(words[0]) && words.slice(1).every((w) => /^[\w.+-]+$/.test(w))
    }
    case 'awk':
    case 'gawk':
    case 'mawk': {
      if (has(/\bsystem\s*\(|\bgetline\b|\|/)) return false
      const flags = masked.trim().split(/\s+/).slice(1).filter((t) => t.startsWith('-'))
      return flags.every((t) => /^-[Fv]/.test(t) || t === '--')
    }
    /* `ForEach-Object Delete` calls Delete on everything it is handed. */
    case 'foreach-object': {
      let rest = masked
      for (let was = ''; was !== rest; ) [was, rest] = [rest, rest.replace(/\{[^{}]*\}/g, ' ')]
      const words = rest.trim().split(/\s+/).slice(1)
      return words.every((w) => /^-(process|begin|end)$/i.test(w))
    }
    default:
      return true
  }
}

/**
 * Whether a command only reads, in the shell it will run in (`shell`, when
 * known: see dialectsFor). `platform` is for the checks, which try the
 * Windows rules on Linux too.
 */
export function isReadOnly(command: string, shell?: ShellKind, platform: string = process.platform): boolean {
  return dialectsFor(shell, platform).every((d) => readsAs(command, d, platform))
}

function readsAs(command: string, dialect: Dialect, platform: string): boolean {
  const isReadOnly = (c: string): boolean => readsAs(c, dialect, platform)
  const trimmed = command.trim().replace(harmlessRedirects(platform), ' ').trim()
  if (!trimmed) return false
  /* Writing into a process substitution is writing. */
  if (/>\(/.test(trimmed)) return false
  for (const inner of substitutions(trimmed)) if (!isReadOnly(inner)) return false
  const masked = maskQuotes(trimmed, dialect)
  if (dialect === 'ps' && !psExpressionsRead(masked)) return false
  if (!bracketsRead(trimmed, masked, dialect, isReadOnly)) return false

  // Redirection, piping into a mutating cmdlet, or any write-shaped verb.
  if (WRITE_MARKERS.test(trimmed)) return false

  /**
   * Every Verb-Noun anywhere in the command has to be read-only.
   *
   * Checking only the head of each pipeline segment missed everything
   * inside parentheses, in both directions. It refused `(Get-Process).Count`
   * - the head token being `(get-process).count`, which is in no allowlist -
   * so a harmless count would not auto-run on the `auto` approval mode. And
   * it would have waved through a write hidden in a sub-expression, because
   * nothing ever looked there.
   *
   * Found by bench-ceiling, which set out to measure the model and turned up
   * three of these instead: (Get-Process).Count, (Get-PSDrive C).Used, and a
   * parenthesised Get-CimInstance. The model was right every time and the
   * gate was wrong.
   *
   * Only at a command position - start, or after ( | ; & { - because matching
   * every hyphenated word blocked `dotnet --list-sdks` on the strength of
   * "list-sdks", and would block a wildcard like '*Visual-Studio*' too.
   */
  const CMDLET_AT_START = /(?:^|[(|;&{=])\s*([A-Za-z][\w]*-[A-Za-z][\w]*)/g
  for (const [, cmdlet] of trimmed.matchAll(CMDLET_AT_START)) {
    if (!isReadingCmdlet(cmdlet)) return false
  }

  // Every segment of a pipeline has to be read-only on its own.
  const segments = topLevelSegments(trimmed, dialect)
  for (const segment of segments) {
    /**
     * `$folder = [Environment]::GetFolderPath("MyDocuments"); Get-ChildItem
     * $folder` is a read, and the gate refused it: the head token `$folder`
     * had its `$` stripped by the wrapper cleanup below, leaving `folder`,
     * which is in no allowlist. Naming a thing before using it is the normal
     * way to write that, and the prompt now tells the model to look folders
     * up rather than guess them - so this shape arrives often.
     *
     * The right-hand side is what actually runs, so judge that. A write
     * there is still caught, because the Verb-Noun sweep above counts `=`
     * as a command position for exactly this reason.
     */
    /*
     * A loop or a test around reads is a read: `for d in /sys/class/*; do
     * cat "$d/status"; done` was refused for its `for`, `do` and `done`,
     * and a background agent spent its steps finding that out. The keyword
     * is set aside and what it runs is judged as usual; the list a `for`
     * walks is words, and any command in it was judged above.
     */
    const body = segment
      .trim()
      .replace(/^\$\w+\s*=\s*/, '')
      .replace(/^(?:do|then|else|elif|if)\s+/i, '')
    if (/^(?:done|fi|then|do|else)$/i.test(body)) continue
    /* A variable on its own prints its value: `$env:USERNAME`. */
    /* Not in bash, where `$x` alone runs whatever x holds. */
    if (dialect !== 'bash' && /^\$[\w:]+(?:\.\w+)*$/.test(body)) continue
    if (/^for\s+\w+\s+in\b/i.test(body)) continue
    const tokens = body.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    /* A .NET static that only reports - [Environment]::MachineName,
       [IO.Directory]::GetFiles(...) - checked by psExpressionsRead above. */
    if (dialect === 'ps' && /^\[[\w.]+\]\s*::/.test(tokens[0])) continue
    // Strip what wraps a call rather than names it: a leading paren, and a
    // trailing property access or closing paren.
    const head = tokens[0]
      .toLowerCase()
      .replace(/^[($@]+/, '')
      .replace(/^["']+/, '')
      .replace(/["')\].,].*$/, '')
      .replace(/\.exe$/, '')
    /* Nothing left of `./evil.sh` or `.` once the property-access trim has
       run: a name that starts with a dot or a slash is a file to run. */
    if (!head) {
      if (/^[.\/\\~!{&]/.test(tokens[0].replace(/^["']+/, ''))) return false
      continue
    }
    /*
     * Not a name: a number, or one of the .NET statics that only compute -
     * `[math]::Round(...)` - is an expression with nothing to allowlist.
     * Everything else that does not start with a letter runs something:
     * a path (`./x.sh`, `/bin/sh`), `.` or `!` or `{` or `&` before a
     * command. These all used to pass, by being skipped.
     */
    if (!/^[a-z]/.test(head)) {
      if (/^\d/.test(head)) continue
      if (/^\[(?:system\.)?(?:math|io\.path)\]::/i.test(tokens[0])) continue
      if (/^\[(?:system\.)?environment\]::get/i.test(tokens[0])) continue
      return false
    }
    /* A path to a program, even one that starts with a letter. */
    if (/[\\/]/.test(head)) return false

    /**
     * Any tool asked only for its version or its help is reporting.
     *
     * The allowlist named tools one at a time, so `docker --version` was
     * refused outright - not because asking a version is dangerous, but
     * because nobody had written docker down. bench-ceiling found it while
     * trying to measure whether the model invents a version for something
     * that is not installed, which it cannot be asked to do if the check
     * never runs. The same gap covers every tool nobody has thought of,
     * which is the whole point of not enumerating them.
     *
     * Only when the flags are ALL it was given: `git --version` is a read,
     * `git push --version` is not a shape anyone writes, and a write-shaped
     * head is already gone by here - the Verb-Noun sweep and WRITE_MARKERS
     * both run first, so `Remove-Item --version` never reaches this.
     */
    const flagArgs = tokens.slice(1).map((t) => t.toLowerCase())
    if (flagArgs.length > 0 && flagArgs.every((a) => VERSION_FLAGS.has(a))) continue

    if (!isReadingCmdlet(head)) return false

    // `find` searches harmlessly until told to act on what it finds.
    if (head === 'find' && DANGEROUS_FIND_FLAGS.test(segment)) return false
    /* And these each have one flag that writes or never ends. */
    if (head === 'rg' && /(^|\s)--pre(=|\s|$)/.test(segment)) return false
    if (head === 'upower' && /(^|\s)(--monitor|--monitor-detail|-m)(\s|$)/.test(segment)) return false
    if (!flagsRead(head, segment, maskQuotes(segment, dialect))) return false

    const reads = READ_SUBCOMMANDS[head]
    if (reads) {
      const args = tokens.slice(1).map((t) => t.toLowerCase())
      // Nothing but version or help flags is always fine.
      const onlyFlags = args.length === 0 || args.every((a) => VERSION_FLAGS.has(a))
      if (onlyFlags) continue

      /**
       * The read verb is the first argument, flag or not.
       *
       * This took the first NON-flag argument, which is right for
       * `git status` and wrong for `manage-bde -status C:` - there it
       * tested "c:" and refused a plain status query. Both forms are
       * accepted now: whichever of the two is a known read verb.
       */
      const firstWord = args.find((a) => !a.startsWith('-')) ?? args[0]
      /* As typed, too: pacman's operations are case-sensitive - -Ss reads,
         -S installs - and lowercased, `pacman -Ss joplin` became "-ss",
         which is on no list, so every package query was refused. */
      const typed = tokens[1] ?? ''
      if (!reads.includes(args[0]) && !reads.includes(firstWord) && !reads.includes(typed)) return false
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

/**
 * Whether a command may run, and whether it runs without a click: judge()
 * in index.ts, without the settings, so scripts/check-approval.mjs tests
 * this and not a copy of it. A copy is how that check went on passing
 * "destructive still asks in accept-all" long after accept-all stopped
 * asking (found by a review, 2026-11).
 *
 * Accept-all runs everything, red ones included - the user's word, see
 * judge(). `auto` runs reads, and nothing marked risky while confirmRisky
 * is on.
 */
export function decide(v: {
  readOnly: boolean
  level: RiskLevel
  scope: 'none' | 'read' | 'full'
  mode: string
  confirmRisky: boolean
}): { allowed: boolean; auto: boolean } {
  const allowed = v.scope === 'full' || (v.scope === 'read' && v.readOnly)
  const risky = v.mode !== 'all' && v.level !== 'none' && v.confirmRisky
  const auto = allowed && !risky && (v.mode === 'all' || (v.mode === 'auto' && v.readOnly))
  return { allowed, auto }
}

/** How bad, not merely whether. Shown on the card; accept-all runs every level. */
export type RiskLevel = 'none' | 'reversible' | 'severe'

export function riskLevel(command: string, shell?: ShellKind): RiskLevel {
  for (const { pattern, reversible } of RISKY) {
    if (pattern.test(command)) return reversible ? 'reversible' : 'severe'
  }
  // The checks below assessRisk's loop - protected places, secret files -
  // are all severe by nature, so anything they catch counts as severe.
  return assessRisk(command, shell) ? 'severe' : 'none'
}

export function assessRisk(command: string, shell?: ShellKind): string | null {
  for (const { pattern, why } of RISKY) {
    if (pattern.test(command)) return why
  }

  /**
   * The places the write-file card refuses, guarded on the shell door too.
   *
   * writefile vets a resolved destination and will not write into Startup,
   * the Start Menu, the Windows folder, Program Files, .ssh or .aws. A shell
   * command reached all of them untouched: six of seven such commands raised
   * no dialog, and on accept-all that means they ran by themselves. Asked to
   * open Notepad at login, the model built a .lnk in Startup through
   * WScript.Shell - a write with no write verb in it anywhere.
   *
   * Only when the command is not a read, so looking inside C:/Windows stays
   * as quiet as looking anywhere else.
   */
  const place = protectedPlace(command)
  if (place && !isReadOnly(command, shell)) return `writes into ${place}`

  /**
   * A read that must still ask, because reading is how a secret leaves.
   *
   * `Get-Content ~/.ssh/id_rsa` is read-only by every test in this file, so
   * it raised no dialog - and a read that raises no dialog runs unattended
   * on BOTH automatic modes, the `auto` one existing precisely to run reads
   * without a click. Its output then goes into the report that is sent to
   * the model, which is a cloud provider. So an unattended read of a
   * private key hands that key to a third party with nobody present.
   *
   * Wumpy takes care that its own keys never leave: they are encrypted with
   * DPAPI, no handler returns one, and the word never appears in preload.
   * None of that is worth much while any other secret on the disk can be
   * read out automatically, so these ask first.
   */
  const secret = SECRET_FILES.find(({ pattern }) => pattern.test(command))
  if (secret) return secret.why
  return secretByWildcard(command)
}

/** Folders that hold keys, and the names of files that are one. */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.docker', '.password-store', '.kube']
const SECRET_NAMES = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'keys.bin',
  '.env',
  '.env.local',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'key.pem',
  'key.ppk',
  'key.p12',
  'key.pfx',
  'key.jks',
  'key.keystore',
  'vault.kdbx'
]

/** A glob as a pattern, read the way the shell expands it. */
function globPattern(glob: string, platform: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') re += '[^/\\\\]*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end < 0) re += '\\['
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  /* bash's * and ? never match a leading dot; PowerShell's do. */
  const dot = platform !== 'win32' && /^[*?[]/.test(glob) ? '(?!\\.)' : ''
  return new RegExp(`^${dot}${re}$`, platform === 'win32' ? 'i' : '')
}

/**
 * A wildcard that reaches a secret the names above would have caught
 * spelled out: `cat ~/.ss?/id_*`, `head ~/.a?s/cred*`, `keys.bi?`. Each
 * part of a path with a wildcard in it is tried against the folders and
 * files that hold keys. A plain `*` on its own is left alone as a file
 * name - `du -sh ~/*` is ordinary - but not as a folder on Windows, where
 * it takes in .ssh.
 */
export function secretByWildcard(command: string, platform: string = process.platform): string | null {
  for (const word of command.split(/[\s"'=,;|&()<>]+/)) {
    if (!/[*?[]/.test(word)) continue
    const parts = word.split(/[\\/]+/).filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!/[*?[]/.test(part)) continue
      const last = i === parts.length - 1
      const plain = /^\*+$/.test(part)
      const re = globPattern(part, platform)
      if ((!plain || !last) && SECRET_DIRS.some((d) => re.test(d))) return 'reaches a folder of keys with a wildcard'
      if (last && !plain && SECRET_NAMES.some((n) => re.test(n))) return 'reaches a file of keys with a wildcard'
    }
  }
  return null
}

/**
 * Files whose contents are a secret, whether the command reads or writes.
 *
 * Matched on the command text rather than a resolved path, because that is
 * all there is at this point - `$env:USERPROFILE\.ssh\id_rsa` never becomes
 * a real path until PowerShell expands it.
 *
 * Every separator class here is [\\/]: a backslash OR a slash. Written
 * [\/] it matches a forward slash only and nothing on Windows ever hits it.
 */
const SECRET_FILES: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /[\\/]\.ssh[\\/]/i, why: 'reads from .ssh, where private keys live' },
  { pattern: /[\\/]\.aws[\\/]/i, why: 'reads from .aws, where credentials live' },
  {
    pattern: /(^|[\\/\s"'])\.env(\.[a-z]+)?([\s"']|$)/i,
    why: 'reads a .env file, which holds keys'
  },
  { pattern: /keys\.bin/i, why: 'reads Wumpy’s own encrypted key store' },
  {
    pattern: /\.(pem|ppk|p12|pfx|jks|keystore)([\s"']|$)/i,
    why: 'reads a certificate or private key file'
  },
  { pattern: /[\\/]id_(rsa|ed25519|ecdsa|dsa)([\s"']|$)/i, why: 'reads an SSH private key' },
  {
    pattern: /[\\/]\.?(netrc|npmrc|pypirc|git-credentials|docker[\\/]config\.json)([\s"']|$)/i,
    why: 'reads a file that stores login tokens'
  }
]

/** Argv for each supported shell. */
function launcher(kind: ShellKind, command: string): { file: string; args: string[] } {
  // Off Windows there is no PowerShell or cmd: every block runs in bash,
  // whichever tag the model gave it (the Linux prompt asks for bash).
  if (process.platform !== 'win32') kind = 'bash'
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

/** How often live output is passed on, at most. */
const LIVE_INTERVAL_MS = 160

/**
 * How much live output is kept.
 *
 * Only the tail is ever shown, and the full text is sent again on every
 * flush, so holding the whole of a 100,000-character build log here would
 * mean posting it across the bridge six times a second for no gain.
 */
const MAX_LIVE = 8000

function clipLive(stdout: string, stderr: string): string {
  const NL = String.fromCharCode(10)
  const joined = stderr
    ? stdout.endsWith(NL) || !stdout
      ? stdout + stderr
      : stdout + NL + stderr
    : stdout
  return joined.length > MAX_LIVE ? joined.slice(-MAX_LIVE) : joined
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
export function runCommand(
  command: string,
  kind: ShellKind,
  cwd?: string,
  onProgress?: (text: string) => void
): Promise<ShellResult> {
  const started = Date.now()
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
  /* A pkexec in it: started so the password pop-up can appear (main/elevate.ts). */
  const plain = launcher(kind, command)
  const { file, args, unit }: { file: string; args: string[]; unit?: string } = asksForRoot(command)
    ? rootable(plain.file, plain.args, { cwd: workingDir, env })
    : plain
  const readOnly = isReadOnly(command)

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: workingDir,
        windowsHide: true,
        // No shell:true — args are passed as an array, so the command string is
        // only ever interpreted by the shell we explicitly chose.
        env
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

    /*
     * Live output, sent on a timer rather than per chunk.
     *
     * A download progress bar redraws many times a second and each redraw is
     * its own write; forwarding every one would put thousands of IPC messages
     * and thousands of React renders behind a card nobody can read that fast.
     * Six frames a second is past the point where it looks any smoother.
     */
    let pending = false
    let flushTimer: NodeJS.Timeout | null = null
    const flush = (): void => {
      flushTimer = null
      if (!pending) return
      pending = false
      onProgress?.(clipLive(stdout, stderr))
    }
    const nudge = (): void => {
      if (!onProgress) return
      pending = true
      if (flushTimer === null) flushTimer = setTimeout(flush, LIVE_INTERVAL_MS)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      stopUnit(unit)
    }, TIMEOUT_MS)

    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += c.toString('utf8')
      nudge()
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += c.toString('utf8')
      nudge()
    })

    child.on('error', (err) => {
      stderr += `\n${err.message}`
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      /*
       * The last flush is sent, not cancelled.
       *
       * Clearing the timer alone lost it: a command that finishes inside the
       * flush interval writes everything it has to say and then exits, so the
       * pending frame was the only frame, and `winget search` streamed
       * nothing at all. Measured as flushes: 0 on output that was plainly
       * there in the result.
       */
      if (flushTimer !== null) clearTimeout(flushTimer)
      flush()
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
