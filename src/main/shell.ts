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
  'printenv',
  'sensors',
  // Linux tools that both read and change things: only their reads, below.
  'pacman',
  'yay',
  'hyprctl',
  'systemctl',
  'bluetoothctl',
  'wpctl'
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
const DANGEROUS_FIND_FLAGS = /(^|\s)-(exec|execdir|delete|ok|okdir|fls|fprint|fprintf)(\s|$)/i

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
function topLevelSegments(command: string): string[] {
  const out: string[] = []
  let buf = ''
  let depth = 0
  let quote: string | null = null

  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      buf += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      buf += c
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === '|' || c === ';')) {
      out.push(buf)
      buf = ''
      continue
    } else if (depth === 0 && c === '&' && command[i + 1] === '&') {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += c
  }
  out.push(buf)
  return out
}

export function isReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

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
  const segments = topLevelSegments(trimmed)
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
    const body = segment.trim().replace(/^\$\w+\s*=\s*/, '')
    const tokens = body.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    // Strip what wraps a call rather than names it: a leading paren, and a
    // trailing property access or closing paren.
    const head = tokens[0]
      .toLowerCase()
      .replace(/^[($@]+/, '')
      .replace(/[)\].,].*$/, '')
      .replace(/\.exe$/, '')
    if (!head) continue
    // A pure expression segment - arithmetic, a variable, a number - has no
    // command to allowlist, and the Verb-Noun sweep above has already
    // vetted anything that was a call.
    if (!/^[a-z]/.test(head)) continue

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
      if (!reads.includes(args[0]) && !reads.includes(firstWord)) return false
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

/** How bad, not merely whether. Only 'severe' interrupts accept-all. */
export type RiskLevel = 'none' | 'reversible' | 'severe'

export function riskLevel(command: string): RiskLevel {
  for (const { pattern, reversible } of RISKY) {
    if (pattern.test(command)) return reversible ? 'reversible' : 'severe'
  }
  // The checks below assessRisk's loop - protected places, secret files -
  // are all severe by nature, so anything they catch counts as severe.
  return assessRisk(command) ? 'severe' : 'none'
}

export function assessRisk(command: string): string | null {
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
  if (place && !isReadOnly(command)) return `writes into ${place}`

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
