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
check('each build has a version of its own', /--publish never -c\.extraMetadata\.version=0\.1\.\$\{\{ github\.run_number \}\}/.test(flow))
check('and is published whole, in one step: installer, blockmap and latest.yml', /gh release create "v\$v" "dist\/Wumpy-\$v-setup\.exe" "dist\/Wumpy-\$v-setup\.exe\.blockmap" dist\/latest\.yml/.test(flow))
check('in bash, where the -c.flag survives', /--publish never[^\n]*\n\s*shell: bash/.test(flow))
check('with the token to do it', /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(flow))
const yml = read('electron-builder.yml')
check('installers know where to look', /publish:\s*\n\s*provider: github\s*\n\s*owner: psyduck-z\s*\n\s*repo: Wumpy\s*\n\s*releaseType: release/.test(yml))
const up = read('src/main/updater.ts')
check('Windows installs only', /process\.platform !== 'win32' \|\| !app\.isPackaged\) return/.test(up))
check('looks at startup and every hour, and downloads by itself', /setTimeout\(checkForUpdate, 60_000\)/.test(up) && /setInterval\(checkForUpdate, EVERY_MS\)/.test(up) && /autoDownload = true/.test(up))
check('and installs itself once nobody is using Wumpy', /state\.stage === 'ready' && d\.idle\(\)\) d\.restart\(/.test(up))
check('a restart with an update waiting installs it and starts the new one', /quitAndInstall\(true, true\)/.test(up))
const main = read('src/main/index.ts')
check('the app starts it', /startUpdates\(\{/.test(main))
check('idle is the key tester\'s idle: no answer, no agent, the panel away, ten quiet minutes',
  /idle: \(\) =>\s*turnStartedAt === null &&\s*\(agents\?\.active\(\) \?\? 0\) === 0 &&\s*!panel\.onScreen &&\s*Date\.now\(\) - Math\.max\(startedAt, lastTurnEndedAt\) >= QUIET_FOR_MS/.test(main))
check('its restart saves the chat first (through the panel)', /restart: \(why\) => askRestart\(why\)/.test(main))
check('and the chat it left opens again after the installer starts the new one',
  /writeFileSync\(join\(app\.getPath\('userData'\), 'resume-chat\.txt'\), chatId\)/.test(main) && /unlinkSync\(left\)/.test(main))
check('the panel hears every change', /changed: \(state\) => panel\.send\(IPC\.updateState, state\)/.test(main))
const header = read('src/renderer/src/components/Header.tsx')
check('the header shows it downloading', /update\?\.stage === 'downloading'/.test(header) && /updating \{update\.percent \?\? 0\}%/.test(header))
check('and a button once it is ready, held while an answer is written', /update\?\.stage === 'ready'/.test(header) && /disabled=\{busy\}/.test(header))
const appTsx = read('src/renderer/src/App.tsx')
check('which restarts through the chat-saving restart', /onUpdate=\{\(\) => void restartRef\.current\(/.test(appTsx))
check('and a restart goes through it before relaunching the old copy', /if \(restartIntoUpdate\(.*\)\) return\s*\n\s*app\.relaunch/.test(main))
const pkg = JSON.parse(read('package.json'))
check('electron-updater ships with the app', Boolean(pkg.dependencies?.['electron-updater']))

console.log(failed ? `\n${failed} FAILED of the update checks` : '\nall update checks correct')
process.exit(failed ? 1 : 0)
