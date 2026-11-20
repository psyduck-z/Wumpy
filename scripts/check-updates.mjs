/**
 * Checks the Windows self-update is wired end to end: the workflow publishes
 * a newer numbered release on every push, every installer knows where to look,
 * and the app looks, installs on restart, and never on Linux or a dev run.
 *
 * Run with: node scripts/check-updates.mjs
 */
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(p, 'utf8')
let failed = 0
const check = (what, ok) => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

const flow = read('.github/workflows/windows.yml')
check('the workflow may write a release', /permissions:\s*\n\s*contents: write/.test(flow))
check('each build publishes, with a version of its own', /--publish always -c\.extraMetadata\.version=0\.1\.\$\{\{ github\.run_number \}\}/.test(flow))
check('with the token to do it', /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(flow))
const yml = read('electron-builder.yml')
check('installers know where to look', /publish:\s*\n\s*provider: github\s*\n\s*owner: psyduck-z\s*\n\s*repo: Wumpy\s*\n\s*releaseType: release/.test(yml))
const up = read('src/main/updater.ts')
check('Windows installs only', /process\.platform !== 'win32' \|\| !app\.isPackaged\) return/.test(up))
check('looks at startup and every hour, and downloads by itself', /setTimeout\(check, 60_000\)/.test(up) && /setInterval\(check, EVERY_MS\)/.test(up) && /autoDownload = true/.test(up))
check('a restart with an update waiting installs it and starts the new one', /quitAndInstall\(true, true\)/.test(up))
const main = read('src/main/index.ts')
check('the app starts it', /startUpdates\(\(line\) => console\.log\(line\)\)/.test(main))
check('and a restart goes through it before relaunching the old copy', /if \(restartIntoUpdate\(.*\)\) return\s*\n\s*app\.relaunch/.test(main))
const pkg = JSON.parse(read('package.json'))
check('electron-updater ships with the app', Boolean(pkg.dependencies?.['electron-updater']))

console.log(failed ? `\n${failed} FAILED of the update checks` : '\nall update checks correct')
process.exit(failed ? 1 : 0)
