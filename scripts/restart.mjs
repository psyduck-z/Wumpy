/**
 * Restarts Wumpy, and only Wumpy.
 *
 * The obvious way to do this is `Get-Process electron | Stop-Process -Force`,
 * and it is wrong: it kills every Electron process on the machine. Wumpy is
 * not the only one. An app installed normally runs as a renamed binary
 * (Code.exe, Discord.exe) and survives, but anything portable or running from
 * a node_modules build is plain `electron.exe` and dies with it - which is how
 * a snip-and-paste tool the user depends on got closed out from under them
 * while they were working, more than once.
 *
 * So this matches on the executable PATH, which is unique to this checkout,
 * and leaves everything else alone. The same caution applies to killing
 * anything by name: node, python and powershell all have the problem.
 *
 *   npm run restart
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BUILT = join(ROOT, 'out', 'main', 'index.js')

function ps(script) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  )
  return (r.stdout ?? '').trim()
}

if (!existsSync(ELECTRON)) {
  console.error(`no electron at ${ELECTRON}`)
  process.exit(1)
}

// Path-filtered, and it reports what it is about to close so a surprise is
// visible rather than silent.
const listed = ps(
  `Get-Process electron -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -eq '${ELECTRON}' } | ` +
    `Select-Object -ExpandProperty Id`
)
const mine = listed
  .split(String.fromCharCode(10))
  .map((l) => l.trim())
  .filter(Boolean)

const others = ps(
  `Get-Process electron -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -ne '${ELECTRON}' } | ` +
    `Measure-Object | Select-Object -ExpandProperty Count`
)

console.log(`Wumpy processes: ${mine.length || 'none'}`)
if (Number(others) > 0) {
  console.log(`leaving ${others} other Electron process(es) alone`)
}

if (mine.length) {
  ps(`Stop-Process -Id ${mine.join(',')} -Force -ErrorAction SilentlyContinue`)
}

/**
 * Started in the tray, not on screen.
 *
 * A restart is a developer's errand, and until now it ended with the panel
 * opening over whatever the user was doing - which they noticed, because it
 * happens several times an hour while something is being worked on: "you open
 * up my Wumpy... it's kind of annoying. When you do that, can you just close
 * Wumpy again?"
 *
 * The app already understands --hidden, for the login item. This is the same
 * situation: a start that nobody asked to see. `npm run restart -- --show`
 * brings the old behaviour back for the rare time the panel is the thing being
 * looked at.
 */
const wanted = process.argv.slice(2)
const show = wanted.includes('--show')
// Anything else is passed straight through, which is how a verification run
// gets --remote-debugging-port without a second script.
const extra = wanted.filter((a) => a !== '--show')
const args = show ? ['.', ...extra] : ['.', '--hidden', ...extra]

const child = spawn(ELECTRON, args, { cwd: ROOT, detached: true, stdio: 'ignore' })
child.unref()

console.log(show ? 'starting with the panel open (--show)' : 'starting in the tray — Win+C to open')

// The point of restarting is to run the new build, so say whether it is one.
if (existsSync(BUILT)) {
  const built = statSync(BUILT).mtime
  console.log(`started pid ${child.pid}; out/main/index.js written ${built.toLocaleTimeString()}`)
  if (Date.now() - built.getTime() > 5 * 60_000) {
    console.log('that build is over five minutes old - run `npm run build` first if you edited src')
  }
} else {
  console.log(`started pid ${child.pid}; no out/main/index.js yet - run \`npm run build\``)
}
