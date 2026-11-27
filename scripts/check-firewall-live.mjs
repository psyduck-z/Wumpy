/**
 * The Windows firewall check and fix, run for real (src/shared/firewall.ts) -
 * on the Windows build machine, which is the only Windows anybody here has
 * to try it on. Elsewhere it says so and passes.
 *
 * As the build machine runs as administrator: a Block rule like the one
 * Windows makes when its "allow this app?" box is closed, for a made-up
 * Wumpy.exe; the check must call that blocked; allowing must remove it and
 * add Wumpy's rule; the check must then call it open. Then everything it
 * made is removed again.
 *
 * Run with: node scripts/check-firewall-live.mjs
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'win32') {
  console.log('skip: the Windows firewall can only be tried on Windows')
  process.exit(0)
}

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(64)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

const out = join(process.cwd(), '.firewall-live.mjs')
await build({ entryPoints: ['src/shared/firewall.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const F = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', F.encoded(script)], {
    encoding: 'utf8',
    timeout: 120_000
  })
const exe = 'C:\\wumpy-ci\\app-9.9.9\\Wumpy.exe'
const facts = () => {
  const raw = ps(F.windowsCheckScript(exe)).trim()
  return JSON.parse(raw)
}
const cleanup = () =>
  ps(
    `Get-NetFirewallRule -DisplayName '${F.RULE_NAME}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n` +
      "Get-NetFirewallRule -DisplayName 'wumpy-ci-block' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n" +
      /* Nothing to remove is an error PowerShell still exits 1 for, ignored or not. */
      'exit 0'
  )

try {
  cleanup()
  const t = Date.now()
  const before = facts()
  console.log(`     (the check took ${Date.now() - t} ms) facts: ${JSON.stringify({ ...before, app: before.app.length, port: before.port.length })}`)
  check('the check prints the facts', typeof before.category === 'string' && Array.isArray(before.profiles), true)
  const verdict0 = F.windowsVerdict(before)
  console.log(`     before: ${verdict0.state} - ${verdict0.why}`)
  check('with nothing allowed, it is not open', verdict0.state !== 'open', true)

  ps(`New-NetFirewallRule -DisplayName 'wumpy-ci-block' -Program '${exe}' -Direction Inbound -Action Block -Profile Any | Out-Null`)
  const blockedFacts = facts()
  check('the Block rule Windows would make is found, for this Wumpy.exe', blockedFacts.app.some((r) => r.self && r.action === 'Block'), true)
  const blocked = F.windowsVerdict(blockedFacts)
  check('and it is called blocked (or the firewall is off here)', ['blocked', 'off'].includes(blocked.state), true)

  ps(F.windowsAllowScript())
  const afterFacts = facts()
  check('allowing removed the Block rule', afterFacts.app.some((r) => r.self && r.action === 'Block'), false)
  check('and added the TCP and UDP rules', afterFacts.port.map((r) => r.protocol).sort(), ['TCP', 'UDP'])
  const after = F.windowsVerdict(afterFacts)
  console.log(`     after: ${after.state} - ${after.why}`)
  check('now it is open (or the firewall is off here)', ['open', 'off'].includes(after.state), true)
  ps(F.windowsAllowScript())
  check('allowing twice still leaves one pair', facts().port.length, 2)

  /* The pop-up path. On the build machine there is nobody to click it, and it may not appear at all. */
  try {
    ps(F.windowsElevateScript('exit 0'))
    console.log('ok   the administrator path ran (no prompt on this machine)')
  } catch (err) {
    console.log(`note the administrator path did not run here: ${String(err.message).split('\n')[0]}`)
  }
} catch (err) {
  failed++
  console.log(`FAIL ${err.stack ?? err}`)
} finally {
  cleanup()
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nthe Windows firewall check and fix work for real')
