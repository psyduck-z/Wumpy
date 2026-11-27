/**
 * The firewall check for Wi-Fi sync (src/shared/firewall.ts): what each set
 * of Windows rules and each ufw file means, and that the scripts say what
 * they should. The Windows scripts run for real in check-firewall-live.mjs,
 * on the Windows build machine.
 *
 * Run with: node scripts/check-firewall.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(64)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

const out = join(process.cwd(), '.firewall-check.mjs')
await build({ entryPoints: ['src/shared/firewall.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const F = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

/* ------------------------------------------------------------ Windows */

const on = [
  { name: 'Domain', on: true },
  { name: 'Private', on: true },
  { name: 'Public', on: true }
]
const facts = (over) => ({ category: 'Private', profiles: on, app: [], port: [], ...over })
const v = (over) => F.windowsVerdict(facts(over)).state
const both = (profile) => [
  { action: 'Allow', profile, protocol: 'TCP' },
  { action: 'Allow', profile, protocol: 'UDP' }
]

check('nothing allowed: closed', v({}), 'closed')
check('Wumpy port rule, any network: open', v({ port: both('Any') }), 'open')
check('only TCP allowed: still closed (UDP finds the devices)', v({ port: both('Any').slice(0, 1) }), 'closed')
check('allowed for private networks, on a public one: closed', v({ category: 'Public', port: both('Private') }), 'closed')
check('"Domain, Private" covers a private network', v({ port: both('Domain, Private') }), 'open')
check('the box was allowed for this Wumpy.exe: open', v({ app: [{ program: 'C:\\w\\app-1\\Wumpy.exe', self: true, action: 'Allow', profile: 'Private' }] }), 'open')
check(
  'the box was closed: blocked, even with the port rule',
  v({ port: both('Any'), app: [{ program: 'C:\\w\\app-1\\Wumpy.exe', self: true, action: 'Block', profile: 'Private, Public' }] }),
  'blocked'
)
check(
  'a block for an older Wumpy.exe does not block this one',
  v({ port: both('Any'), app: [{ program: 'C:\\w\\app-0\\Wumpy.exe', self: false, action: 'Block', profile: 'Any' }] }),
  'open'
)
check(
  'an allow for an older Wumpy.exe does not allow this one',
  v({ app: [{ program: 'C:\\w\\app-0\\Wumpy.exe', self: false, action: 'Allow', profile: 'Any' }] }),
  'closed'
)
check('the firewall off on this network: off', v({ profiles: [{ name: 'Private', on: false }] }), 'off')
check('a domain network is the Domain profile', F.windowsVerdict(facts({ category: 'DomainAuthenticated', port: both('Domain') })).network, 'Domain')
check('no network: unknown', v({ category: '' }), 'unknown')
check('no facts at all: unknown', F.windowsVerdict(null).state, 'unknown')
check('it says which network', F.windowsVerdict(facts({ category: 'Public' })).why, 'Windows Firewall has not been told to let your devices reach Wumpy on this public network.')
check('open and off are fine; closed and blocked are not', ['open', 'off', 'closed', 'blocked', 'unknown'].map((state) => F.reachable({ state, why: '' })), [true, true, false, false, false])

const allow = F.windowsAllowScript()
check('allowing: TCP and UDP on the sync port', [/-Protocol TCP -LocalPort 47820/.test(allow), /-Protocol UDP -LocalPort 47820/.test(allow)], [true, true])
check('from the local network only', (allow.match(/-RemoteAddress LocalSubnet/g) ?? []).length, 2)
check('on any kind of network (a "public" home Wi-Fi too)', (allow.match(/-Profile Any/g) ?? []).length, 2)
check("it removes only inbound Block rules, only Wumpy's", /\*\\wumpy\.exe'[\s\S]*Action -eq 'Block' -and \[string\]\$_\.Direction -eq 'Inbound'/.test(allow), true)
check('and its own old rule first, so allowing twice leaves one pair', /Get-NetFirewallRule -DisplayName 'Wumpy skills sync'.*Remove-NetFirewallRule/.test(allow), true)
const check1 = F.windowsCheckScript("C:\\Users\\o'brien\\AppData\\Local\\wumpy\\app-0.1.9\\Wumpy.exe")
check("a path with a ' in it is quoted for PowerShell", check1.includes("$exe = 'C:\\Users\\o''brien\\AppData"), true)
check('the check prints JSON', /ConvertTo-Json -Depth 4 -Compress$/.test(check1), true)
const elevated = F.windowsElevateScript('Write-Output 1')
check('allowing asks Windows for an administrator (the pop-up)', /Start-Process -FilePath 'powershell\.exe' -Verb RunAs -Wait/.test(elevated), true)
const b64 = F.encoded('Write-Output "é"')
check('-EncodedCommand is UTF-16LE base64', Buffer.from(b64, 'base64').toString('utf16le'), 'Write-Output "é"')

/* --------------------------------------------------------------- ufw */

const omarchy = `*filter\n-A ufw-user-input -p udp --dport 53317 -j ACCEPT\n-A ufw-user-input -p tcp --dport 53317 -j ACCEPT\nCOMMIT\n`
const opened = omarchy.replace('COMMIT', '### tuple ### allow any 47820 0.0.0.0/0 any 0.0.0.0/0 in comment=...\n-A ufw-user-input -p tcp --dport 47820 -j ACCEPT\n-A ufw-user-input -p udp --dport 47820 -j ACCEPT\nCOMMIT')
check("Omarchy's ufw as installed: closed", F.ufwVerdict('ENABLED=yes\n', omarchy).state, 'closed')
check('after `ufw allow 47820`: open', F.ufwVerdict('ENABLED=yes\n', opened).state, 'open')
check('ufw turned off: off', F.ufwVerdict('ENABLED=no\n', omarchy).state, 'off')
check('no ufw: off', F.ufwVerdict(null, null).state, 'off')
check('a deny rule for the port is not open', F.ufwVerdict('ENABLED=yes\n', '-A ufw-user-input -p tcp --dport 47820 -j DROP\n-A ufw-user-input -p udp --dport 47820 -j DROP\n').state, 'closed')

/* ------------------------------------------------------- where it is used */

const main = readFileSync('src/main/index.ts', 'utf8')
const pair = main.slice(main.indexOf("case 'pair': {"), main.indexOf("case 'unpair': {"))
check('pairing opens the firewall before it starts listening', pair.indexOf('ensureFirewall()') > 0 && pair.indexOf('ensureFirewall()') < pair.indexOf('lanSync.start()'), true)
check('paired, it is checked again after each start (an update is a new Wumpy.exe)', /setTimeout\(\(\) => void firewallAtStart\(\), 25_000\)/.test(main), true)
check('opening goes through the system pop-up, never sudo', !/\bsudo\b/.test(readFileSync('src/main/firewall.ts', 'utf8')) && /pkexec/.test(readFileSync('src/main/firewall.ts', 'utf8')), true)
const tab = readFileSync('src/renderer/src/components/SettingsTab.tsx', 'utf8')
check('Settings shows it, with Allow and Check', /what="Firewall"/.test(tab) && /checkWall\(true\)/.test(tab) && /checkWall\(false\)/.test(tab), true)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall firewall checks pass')
