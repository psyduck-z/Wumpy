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
check('installed builds only, never a dev run', /if \(deps \|\| !app\.isPackaged\) return/.test(up))
check('downloads on Windows only; Linux looks at its source folder', /if \(process\.platform === 'linux'\) \{\s*startLinuxUpdates\(d\)\s*return\s*\}\s*if \(process\.platform !== 'win32'\) return/.test(up))
check('every 30 minutes, as asked', /export const EVERY_MS = 30 \* 60 \* 1000/.test(up))
check('Linux checks every 30 minutes too', /setInterval\(\(\) => void checkLinux\(\), EVERY_MS\)/.test(up))
check('a Linux restart never runs the Windows installer', /if \(linux \|\| state\.stage !== 'ready'\) return false/.test(up))
check('looks at startup and every 30 minutes, and downloads by itself', /setTimeout\(checkForUpdate, 60_000\)/.test(up) && /setInterval\(checkForUpdate, EVERY_MS\)/.test(up) && /autoDownload = true/.test(up))
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
check('which restarts through the chat-saving restart', /: void restartRef\.current\(`to install Wumpy/.test(appTsx))
check('and a restart goes through it before relaunching the old copy', /if \(restartIntoUpdate\(.*\)\) return\s*\n\s*app\.relaunch/.test(main))
const pkg = JSON.parse(read('package.json'))
check('electron-updater ships with the app', Boolean(pkg.dependencies?.['electron-updater']))


/* /update, and the Linux source updater. */
const commands = read('src/renderer/src/commands.ts')
check('/update is a command', /name: 'update',[\s\S]{0,200}kind: 'update', force: \/\^\(force\|anyway\|rebuild\)\$\/i/.test(commands))
check('which asks main to update now', /window\.wumpy\.update\.now\(action\.force\)/.test(appTsx) && /ipcMain\.handle\(IPC\.updateNow, \(_e, force: boolean\) => updateNow\(force === true\)\)/.test(main))
check('the header offers an available update, through /update', /update\?\.stage === 'available'/.test(header) && /runCommandRef\.current\(\{ kind: 'update', force: false \}, '\/update'\)/.test(appTsx))
check('a Linux update restarts once installed', /deps\.restart\('to start the updated Wumpy'\)/.test(up))
check('nothing new means nothing built, unless forced', /if \(!about && !force\) \{/.test(up))
const src = read('src/main/sourceupdate.ts')
check('pulls fast-forward only, so nothing is merged or thrown away', /\['pull', '--ff-only', '--quiet', \.\.\.from\]/.test(src) && !/reset --hard|checkout --|stash/.test(src))
check('a branch with no upstream still sees origin\'s commits', /refs\/remotes\/origin\/\$\{branch\}/.test(src) && /HEAD\.\.\$\{pullFrom\.remote\}\/\$\{pullFrom\.branch\}/.test(src))
check('git never waits on a password prompt', /GIT_TERMINAL_PROMPT: '0'/.test(src))
check('builds with the same script a person runs', /run\('npm', \['run', 'install:linux'\]/.test(src))
check('no shell between Wumpy and the build', /spawn\(cmd, args, \{/.test(src) && !/shell: true/.test(src))
check('the install says where it was built from', /writeFileSync\(join\(root, 'source\.txt'\), process\.cwd\(\)\)/.test(read('scripts/install-linux.mjs')))

const { build } = await import('esbuild')
const { join } = await import('node:path')
const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { pathToFileURL } = await import('node:url')
const out = join(process.cwd(), '.updates-check.mjs')
await build({ entryPoints: ['src/main/sourceupdate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const S = await import(pathToFileURL(out).href)
rmSync(out, { force: true })
check('nothing new says nothing', S.whatsNew({ behind: 0, edited: false }) === '')
check('new commits are counted', S.whatsNew({ behind: 2, edited: false }) === '2 new commits on GitHub')
check('and edits since the install named', S.whatsNew({ behind: 1, edited: true }) === '1 new commit on GitHub and changes made in the source folder since it was installed')
const dir = mkdtempSync(join(tmpdir(), 'wumpy-src-'))
mkdirSync(join(dir, 'src', 'main'), { recursive: true })
mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
writeFileSync(join(dir, 'src', 'main', 'a.ts'), '')
writeFileSync(join(dir, 'node_modules', 'x', 'b.js'), '')
utimesSync(join(dir, 'src', 'main', 'a.ts'), 1000, 1000)
utimesSync(join(dir, 'node_modules', 'x', 'b.js'), 9e8, 9e8)
check('the newest edit is of the build inputs', S.newestEdit(dir) === 1_000_000)
check('and node_modules is not an edit', S.newestEdit(dir) < 9e11)
const ran = await S.run('node', ['-e', 'console.log("hi"); process.exit(3)'], dir, 10_000)
check('a failed step is a failure, with its output', ran.ok === false && /hi/.test(ran.out))
check('the tail of a build is its last lines', S.tail('a\nb\nc\nd', 2) === 'c\nd')
rmSync(dir, { recursive: true, force: true })

console.log(failed ? `\n${failed} FAILED of the update checks` : '\nall update checks correct')
process.exit(failed ? 1 : 0)
