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
  // Trusting "get-" must not leak into verbs that change things, including
  // ones that read like a question.
  'Set-NetFirewallProfile -Enabled True',
  'Remove-Variable x',
  'Clear-Content notes.txt',
  '(Get-Process).Count; Remove-Item x',
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

const total = CASES.length + 1 + MUST_BLOCK.length + MUST_ALLOW.length + 5
console.log(`\n${total - failed}/${total} approval checks correct`)
process.exit(failed === 0 ? 0 : 1)
