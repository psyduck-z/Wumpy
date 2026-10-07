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
console.log(`${ok ? 'ok  ' : 'FAIL'} destructive + confirmRisky:false in "all" -> ${outcome(bypass)}`)

/* ------------------------------------------------- bypass attempts ------- */

/**
 * Commands whose head is on the allowlist but whose arguments are not safe.
 * Every one of these was allowed by an earlier version of isReadOnly().
 */
const MUST_BLOCK = [
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
  'Get-Content a | Invoke-Expression'
]

/** Reads that must keep working, or the auto mode is useless. */
const MUST_ALLOW = [
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
console.log(`ok   ${MUST_BLOCK.length} unsafe commands need a click, ${MUST_ALLOW.length} reads do not`)

rmSync(out, { force: true })

const total = CASES.length + 1 + MUST_BLOCK.length + MUST_ALLOW.length
console.log(`\n${total - failed}/${total} approval checks correct`)
process.exit(failed === 0 ? 0 : 1)
