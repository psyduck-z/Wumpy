/**
 * Checks what each approval mode permits.
 *
 * This is the permission model, so it is asserted rather than assumed. The
 * table below is the whole contract: which commands run unattended, which wait
 * for a click, and which are refused outright by the tier.
 *
 * Run with: npm run check:approval
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.approval-check.mjs')
await build({
  entryPoints: ['src/main/shell.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { isReadOnly, assessRisk } = await import(pathToFileURL(out).href)

/** Mirrors judge() in src/main/index.ts. */
function judge(command, { tierTools, mode, confirmRisky = true }) {
  const readOnly = isReadOnly(command)
  const allowed = tierTools === 'full' || (tierTools === 'read' && readOnly)
  const risk = assessRisk(command)
  const risky = risk !== null && confirmRisky
  const auto = allowed && !risky && (mode === 'all' || (mode === 'auto' && readOnly))
  return { allowed, auto, risky, readOnly }
}

const READ = 'ollama list'
const WRITE = 'New-Item -ItemType File notes.txt'
const RISKY = 'Remove-Item -Recurse -Force C:\\temp'

const CASES = [
  // command, tier scope, mode, expected outcome
  [READ, 'full', 'manual', 'waits'],
  [READ, 'full', 'auto', 'runs'],
  [READ, 'full', 'all', 'runs'],
  [WRITE, 'full', 'manual', 'waits'],
  [WRITE, 'full', 'auto', 'waits'], // auto only covers reads
  [WRITE, 'full', 'all', 'runs'],
  [RISKY, 'full', 'manual', 'waits'],
  [RISKY, 'full', 'auto', 'waits'],
  [RISKY, 'full', 'all', 'waits'], // destructive still asks
  // Quick-mode tiers may only read, whatever the approval mode.
  [READ, 'read', 'auto', 'runs'],
  [WRITE, 'read', 'auto', 'refused'],
  [WRITE, 'read', 'all', 'refused'],
  [RISKY, 'read', 'all', 'refused'],
  // Flash has no tools at all.
  [READ, 'none', 'all', 'refused']
]

function outcome(v) {
  if (!v.allowed) return 'refused'
  return v.auto ? 'runs' : 'waits'
}

let failed = 0
console.log(`${'command'.padEnd(34)} ${'tier'.padEnd(6)} ${'mode'.padEnd(7)} outcome`)
for (const [command, tierTools, mode, want] of CASES) {
  const got = outcome(judge(command, { tierTools, mode }))
  const ok = got === want
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${command.slice(0, 28).padEnd(29)} ${tierTools.padEnd(6)} ${mode.padEnd(7)} ${got}` +
      (ok ? '' : `   expected ${want}`)
  )
}

// Turning off confirmRisky is the only way a destructive command runs unasked.
const bypass = judge(RISKY, { tierTools: 'full', mode: 'all', confirmRisky: false })
const ok = bypass.auto === true
if (!ok) failed++
console.log(
  `${ok ? 'ok  ' : 'FAIL'} destructive + confirmRisky:false in "all" -> ${outcome(bypass)}`
)

/* ------------------------------------------------- bypass attempts ------- */

/**
 * Commands whose head is on the allowlist but whose arguments are not safe.
 * Every one of these was allowed by an earlier version of isReadOnly().
 */
const MUST_BLOCK = [
  // The other half of the same fix: a write inside parentheses was never
  // looked at before, because only the segment head was checked.
  '(Remove-Item C:\temp -Recurse).Count',
  '(Stop-Process -Name foo).Id',
  // A script block is a command position too. Allowing ForEach-Object
  // without looking inside its braces would have been a way through.
  'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
  'Get-Process | Where-Object { Stop-Process $_ }',
  // Trusting "get-" must not leak into verbs that change things, including
  // ones that read like a question.
  'Set-NetFirewallProfile -Enabled True',
  'Remove-Variable x',
  'Clear-Content notes.txt',
  '(Get-Process).Count; Remove-Item x',
  /**
   * An assignment at the head, which the gate now looks past so that
   * `$folder = [Environment]::GetFolderPath(...); Get-ChildItem $folder`
   * counts as the read it is. Looking past it must not become a way around
   * the sweep.
   */
  '$x = Remove-Item C:/t -Recurse',
  '$x = 1; Remove-Item C:/t',
  '$x = Stop-Process -Name chrome',
  '$a = Get-Date; $b = Remove-Item C:/t',
  '$x = ri C:/t',
  /**
   * A `;` inside braces is no longer a statement boundary - it was cutting
   * `@{n="MB";e={...}}` in half and refusing a pure read - so the Verb-Noun
   * sweep is now the only thing looking inside a script block. These prove
   * it looks.
   */
  'Select-Object @{n="x";e={Remove-Item C:/t}}',
  'Select-Object @{n="x";e={$_ | Remove-Item}}',
  'Get-Process | ForEach-Object { Stop-Process $_ }',
  'Get-Date -Format "a;b"; Remove-Item C:/t',
  /**
   * Aliases, which have no hyphen for the sweep to find and so rely entirely
   * on WRITE_MARKERS. `ri` was missing from it: `ForEach-Object { ri $_ }`
   * was classified a read, and on the auto mode that runs by itself. The
   * cmd-shaped ones were all there; the PowerShell-native ones were not.
   */
  'Get-ChildItem | ForEach-Object { ri $_ }',
  'Get-ChildItem | ForEach-Object { rm -rf $_ }',
  'Get-ChildItem | % { del $_ }',
  'Get-Process | ForEach-Object { spps $_ }',
  'Get-ChildItem | ForEach-Object { mi $_ -Destination D:/x }',
  'node -e "require(0).rmSync()"',
  'node --eval "x"',
  'npx create-react-app x',
  'python -c "import os"',
  'python3 -m http.server',
  'pwsh -Command "Remove-Item x"',
  'find . -name "*.tmp" -delete',
  'find . -exec rm {} ;',
  'git config --global user.email x',
  'git push --force',
  'npm config set registry http://evil',
  'npm install left-pad',
  'ollama rm llama3.2:3b',
  'pip install requests',
  'go install ./...',
  'cargo install ripgrep',
  'Remove-Item -Recurse C:/temp',
  'Get-ChildItem; Remove-Item x',
  'echo hi > f.txt',
  'Get-Content a | Invoke-Expression',
  // A read subcommand handed a flag that writes. Five of the eight flags in
  // that guard were matching a literal backspace rather than a word boundary,
  // because a shell heredoc ate the escape, so they could never fire. Nothing
  // here covered them, which is why it went unnoticed.
  'git log --force',
  'git show --delete',
  'ollama list -f something',
  'npm list --set x',
  'pip list -w /tmp'
]

/** Reads that must keep working, or the auto mode is useless. */
const MUST_ALLOW = [
  /**
   * Parenthesised reads, which the gate used to refuse.
   *
   * It took the head of each pipeline segment, so `(Get-Process).Count`
   * arrived as the token `(get-process).count` and matched no allowlist. On
   * the `auto` approval mode that meant a harmless count sat waiting for a
   * click. Found by bench-ceiling while trying to measure the model: three
   * of its "failures" were this.
   */
  '(Get-Process).Count',
  '(Get-PSDrive C).Used / (Get-PSDrive C).Free',
  '(Get-CimInstance Win32_OperatingSystem).Version',
  '(Get-ChildItem ~/Downloads | Sort-Object Length -Descending | Select-Object -First 3).Name',
  // A hyphenated flag is not a cmdlet, and nor is a hyphenated wildcard.
  // Scanning every hyphenated word for a verb blocked both.
  // Any Get- cmdlet, not an enumerated list of them: the verb is
  // Microsoft's own for "read and return", and naming them one at a time
  // meant every cmdlet nobody thought of was a harmless command that would
  // not auto-run. bench-ceiling found two in ten questions.
  'Get-Volume -DriveLetter C',
  'Get-WmiObject Win32_LogicalDisk',
  'Get-NetFirewallProfile',
  'Get-ComputerInfo | Select-Object OsName',
  // ForEach-Object transforms what it is handed and changes nothing itself.
  // Its absence refused the one correct percentage command bench-ceiling
  // ever produced, which is a whole capability lost to a missing name.
  'Get-PSDrive C | ForEach-Object { "{0:N2}" -f ($_.Used / ($_.Used + $_.Free) * 100) }',
  'Get-Process | Group-Object Name | Sort-Object Count',
  /**
   * Naming a folder before listing it, which is what the prompt now tells
   * the model to do rather than guessing $env:USERPROFILE\Pictures. The gate
   * refused it: the head token `$docs` lost its `$` to the wrapper cleanup
   * and arrived as `docs`, which is in no allowlist.
   */
  '$docs = [Environment]::GetFolderPath("MyDocuments"); Get-ChildItem $docs -File',
  '$t = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; Get-Process | Select-Object -First 1',
  /**
   * A calculated property, which is how "which program is using the most
   * memory, and how much" has to be written. The `;` between its keys was
   * being read as a statement separator, so the gate took `e={[math` for a
   * command name.
   */
  'Get-Process | Sort-Object WS -Descending | Select-Object -First 1 Name, @{n="MB";e={[math]::Round($_.WS / 1MB)}}',
  'Get-Date -Format "yyyy;MM"',
  'dotnet --list-sdks',
  "Get-StartApps | Where-Object Name -like '*Visual-Studio*'",
  'node --version',
  'python --version',
  'git status',
  'git log --oneline -5',
  'git diff',
  'ollama list',
  'ollama ps',
  'npm list',
  'npm --version',
  'pip list',
  'go version',
  'dotnet --list-sdks',
  'find . -name "*.ts"',
  'Get-ChildItem -Path . -File',
  // "Open Spotify" has to find out whether Spotify is installed before it can
  // choose between launching the app and opening the website, and a Quick
  // tier should be able to answer that. Get-AppxPackage was missing, so the
  // uninstall registry was searchable and Store apps - where half the
  // consumer apps on Windows live - were not.
  'Get-AppxPackage *spotify*',
  'Get-StartApps',
  // The aliases people and models actually type. Each is the exact cmdlet
  // already on the list, so refusing them was a difference in spelling.
  'Get-AppxPackage | Select Name',
  'Get-ChildItem | Sort Name',
  'Get-Process | Measure',
  'gci | Select Name',
  'Get-Command ollama -ErrorAction SilentlyContinue',
  'systeminfo',
  'Test-Path C:/Windows',
  'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5'
]

console.log('\nwhat "auto" will and will not run by itself:')
for (const c of MUST_BLOCK) {
  if (isReadOnly(c)) {
    failed++
    console.log(`FAIL would run unattended: ${c}`)
  }
}
for (const c of MUST_ALLOW) {
  if (!isReadOnly(c)) {
    failed++
    console.log(`FAIL refuses a harmless read: ${c}`)
  }
}
console.log(
  `ok   ${MUST_BLOCK.length} unsafe commands need a click, ${MUST_ALLOW.length} reads do not`
)

rmSync(out, { force: true })

/* Launching an app changes nothing on disk, but it is still an action and
   still needs a Developer tier. Removing one certainly does. */
for (const c of [
  'Start-Process spotify',
  'Start-Process "spotify:"',
  'Remove-AppxPackage x',
  // Allowing the aliases must not allow a script block smuggled through one.
  'Get-ChildItem | Select { Remove-Item C:/t -Recurse -Force }',
  'gci | Sort { Remove-Item C:/t -Recurse -Force }'
]) {
  if (isReadOnly(c)) {
    failed++
    console.log(`FAIL treats an action as a read: ${c}`)
  } else {
    console.log(`ok   still needs Developer mode: ${c}`)
  }
}

/* ------------------------------------------- the destructive classifier -- */

let extra = 0

/**
 * What must raise the native dialog.
 *
 * This whole classifier used to be tested by one example - Remove-Item with
 * -Recurse - so it described one shape of damage and nobody noticed it
 * missed the rest. Measured against 24 destructive commands, 23 raised no
 * dialog. On accept-all that is not a skipped confirmation: judge() marks a
 * command that is not risky as `auto`, and the card runs it with no click,
 * so this list was the only thing between the model's first guess and the
 * user's files.
 *
 * Paths are written with forward slashes, which PowerShell accepts, so this
 * table says what it means without backslash escaping in the way.
 */
const MUST_CONFIRM = [
  // Files, gone or moved. Only the recursive delete was here before.
  'Remove-Item C:/Users/me/Pictures/*.png -Force',
  'Remove-Item C:/Users/me/notes.txt',
  'Move-Item C:/Users/me/Pictures/* -Destination D:/x -Force',
  'Get-ChildItem C:/Users/me/Pictures | Move-Item -Destination D:/x -Force',
  'Rename-Item *.log -NewName x.txt',
  'Clear-Content C:/Users/me/notes.txt',
  'Clear-RecycleBin -Force',
  'Set-Content -Path C:/Users/me/notes.txt -Value x',
  'Out-File -FilePath C:/Users/me/notes.txt -InputObject x',
  'cmd /c rmdir /s /q C:/Users/me/Downloads',
  'vssadmin delete shadows /all',
  // Protection switched off - the ones a user would never want to find out
  // about afterwards.
  'Set-NetFirewallProfile -All -Enabled False',
  'netsh advfirewall set allprofiles state off',
  'Set-MpPreference -DisableRealtimeMonitoring $true',
  'Add-MpPreference -ExclusionPath C:/',
  'Disable-NetAdapter -Name Wi-Fi -Confirm:$false',
  'Disable-ComputerRestore -Drive C:/',
  'Stop-Service -Name MpsSvc',
  'Set-Service -Name MpsSvc -StartupType Disabled',
  'Stop-Process -Name chrome -Force',
  'bcdedit /set testsigning on',
  // Registry writes, accounts, and anything arranging to run again later.
  'Set-ItemProperty HKCU:/Software/x -Name y -Value z',
  'New-ItemProperty HKCU:/Software/x -Name y -Value z',
  'reg add HKCU/Software/x /v y /d z',
  'New-LocalUser -Name intruder',
  'net user intruder /add',
  'Add-LocalGroupMember -Group Administrators -Member intruder',
  'Register-ScheduledTask -TaskName x -Action $a',
  'schtasks /create /tn x /tr y /sc onlogon',
  /**
   * The one read that must ask. Asked to list every file on the computer the
   * model proposed a recursive walk of C:, which destroys nothing and so
   * passed every other rule here - and on accept-all would have started by
   * itself and spent minutes thrashing the disk. `dir /s` is the same
   * request in cmd and was missed by a -Recurse-only test.
   */
  'Get-ChildItem -Recurse -File -Path C:/',
  'Get-ChildItem C:/ -Recurse',
  'Get-ChildItem D: -Recurse -File | Measure-Object',
  'dir /s C:/',
  /**
   * The same hazard with the path left off, which is the version the model
   * kept writing once it had been taught not to name a drive. It walks
   * everything below wherever commands run from, which is the profile.
   */
  'Get-ChildItem -Recurse -File',
  'Get-ChildItem -Recurse -File | Sort-Object Length -Descending',
  'Get-ChildItem . -Recurse',
  /**
   * The write-file card refuses Startup, the Start Menu, the Windows folder,
   * Program Files, .ssh and .aws. A shell command reached all of them
   * untouched - six of seven raised no dialog, so on accept-all they ran by
   * themselves. Asked to open Notepad at login the model built a .lnk in
   * Startup through WScript.Shell, a write with no write verb in it for
   * anything to notice. Both doors are guarded from one list now.
   */
  'New-Object -ComObject WScript.Shell; $s.CreateShortcut("$env:APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/x.lnk"); $s.Save()',
  'Copy-Item x.lnk -Destination "$env:APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"',
  'New-Item -ItemType File "C:/Program Files/x.exe"',
  'Copy-Item id_rsa -Destination $env:USERPROFILE/.ssh/',
  /**
   * And the reads that must still ask, because reading is how a secret
   * leaves. Get-Content on a private key is read-only by every other test
   * here, so it raised no dialog - and an unflagged read runs unattended on
   * the auto mode, which exists for exactly that. Its output then goes into
   * the report sent to the model, which is a cloud provider. Wumpy encrypts
   * its own keys and never hands one back; none of that is worth much while
   * every other secret on the disk can be read out automatically.
   */
  'Get-Content $env:USERPROFILE/.ssh/id_rsa',
  'Get-Content $env:USERPROFILE/.aws/credentials',
  'Get-Content D:/Dev/Github/Wumpy/.env',
  'Get-Content $env:APPDATA/wumpy/keys.bin',
  'Get-Content cert.pem',
  'cat $env:USERPROFILE/.netrc',
  'Get-Content $env:USERPROFILE/.git-credentials'
]

for (const c of MUST_CONFIRM) {
  const why = assessRisk(c)
  const v = judge(c, { tierTools: 'full', mode: 'all' })
  const ok = why !== null && v.auto === false
  if (!ok) failed++
  extra++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} asks first: ${c.slice(0, 44).padEnd(45)} ${why ?? 'NO DIALOG, RAN ITSELF'}`
  )
}

/**
 * The other direction, and the reason the patterns above are anchored.
 *
 * A read that raises a dialog is its own kind of broken: it breaks the
 * `auto` mode, whose whole purpose is that reporting runs by itself. So
 * every command the gate calls a read must also be judged harmless. This
 * caught nothing when written, which is the point - it is what makes the
 * next widening of the list safe to attempt.
 *
 * Two deliberate exceptions have been added since, and both are named here
 * so the rule stays honest rather than quietly true: a recursive scan of a
 * drive root, which costs minutes, and a read of a file that holds a
 * secret, which would hand it to a cloud provider unattended. Neither
 * appears in the list below, and the cases proving each is correctly scoped
 * sit next to this.
 */
for (const c of MUST_ALLOW) {
  const why = assessRisk(c)
  const ok = why === null
  if (!ok) failed++
  extra++
  if (!ok) console.log(`FAIL a read would raise a dialog (${why}): ${c.slice(0, 60)}`)
}
console.log(`ok   none of the ${MUST_ALLOW.length} reads raises a dialog`)

/**
 * The scoping of that one exception, in both directions. It is the only
 * read allowed to raise a dialog, so it had better be the only read that
 * does: a recursive scan of a NAMED folder is ordinary work and must stay
 * unattended, and a drive root with no recursion is one directory listing.
 */
const BOUNDED_READS = [
  'Get-ChildItem C:/Users/me/Downloads -Recurse -File',
  'Get-ChildItem ([Environment]::GetFolderPath("MyPictures")) -Recurse -File',
  'Get-ChildItem $env:USERPROFILE -Recurse -File | Measure-Object',
  'Get-ChildItem C:/',
  'Get-PSDrive C',
  'Get-Volume -DriveLetter C',
  // A -Recurse that says where to start is ordinary work and stays
  // unattended, however deep it goes.
  'Get-ChildItem ~ -Recurse -File | Measure-Object',
  'Get-ChildItem $env:USERPROFILE/Downloads -Recurse -Filter *.png',
  // Reading an ordinary file is not reading a secret. environment.txt is
  // the negative case for the .env pattern, which must not match it.
  'Get-Content $env:USERPROFILE/Downloads/notes.txt',
  'Get-Content package.json',
  'Get-Content environment.txt',
  // Looking INTO a protected place is as quiet as looking anywhere.
  'Get-ChildItem C:/Windows/System32 -File',
  'Get-ChildItem $env:APPDATA/Microsoft/Windows/Start Menu'
]

/**
 * Asking any tool for its version is reporting, whether or not anyone wrote
 * that tool down. The allowlist named them one at a time, so
 * `docker --version` was refused - found by bench-ceiling, which could not
 * measure whether the model invents a version for something uninstalled
 * because the check never ran. `-version` with one dash is what ffmpeg and
 * java use and was missing too.
 */
const VERSION_READS = [
  'docker --version',
  'ffmpeg -version',
  'ffmpeg --version',
  'java -version',
  'terraform --help',
  'somescript.exe --version',
  'kubectl version'
]
for (const c of VERSION_READS) {
  const ok = isReadOnly(c)
  if (!ok) failed++
  extra++
  console.log(`${ok ? 'ok  ' : 'FAIL'} a version flag is a read: ${c}`)
}

/**
 * And the shape must not become a way through. A write-shaped head is gone
 * before the flag is ever looked at, and a tool with no flags at all is
 * still an unknown command.
 */
const NOT_VERSION_READS = [
  'Remove-Item --version',
  'rm --version',
  'docker',
  'docker ps',
  'git push'
]
for (const c of NOT_VERSION_READS) {
  const ok = !isReadOnly(c)
  if (!ok) failed++
  extra++
  console.log(`${ok ? 'ok  ' : 'FAIL'} still not a read: ${c}`)
}
for (const c of BOUNDED_READS) {
  const why = assessRisk(c)
  const ok = why === null
  if (!ok) failed++
  extra++
  console.log(`${ok ? 'ok  ' : 'FAIL'} stays unattended: ${c.slice(0, 46).padEnd(47)} ${why ?? ''}`)
}

/**
 * Creating something is reversible by deleting it, so accept-all may still
 * do it unattended. If this starts failing, the list above has stopped
 * drawing the line at "can the user undo this by clicking again" and
 * accept-all has quietly become the auto mode.
 */
const MAY_RUN_UNATTENDED = [
  'New-Item -ItemType Directory -Path C:/Users/me/x',
  'New-Item -ItemType File notes.txt',
  'Compress-Archive -Path x -DestinationPath y',
  'Add-Content -Path log.txt -Value x'
]
for (const c of MAY_RUN_UNATTENDED) {
  const v = judge(c, { tierTools: 'full', mode: 'all' })
  const ok = v.auto === true
  if (!ok) failed++
  extra++
  console.log(`${ok ? 'ok  ' : 'FAIL'} accept-all still runs: ${c.slice(0, 44)}`)
}

const total = CASES.length + 1 + MUST_BLOCK.length + MUST_ALLOW.length + 5 + extra
console.log(`\n${total - failed}/${total} approval checks correct`)
process.exit(failed === 0 ? 0 : 1)
