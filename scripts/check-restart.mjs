/**
 * Restarting Wumpy.
 *
 * Asked for in these words: "add a restart command". It comes back on the
 * chat it left, saved first; with the panel shown only if it was shown; and
 * through the earbuds it says "Restarting." and waits for the turn to end.
 * The music it paused is resumed before it goes, and the keys are never
 * touched - a restart is not a reset.
 *
 * The parsing is run; the rest is checked as wiring, since a check cannot
 * restart the app it is checking.
 *
 * Run with: node scripts/check-restart.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.restart-${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

const K = await load('src/renderer/src/commands.ts', 'commands')
const I = await load('src/renderer/src/intents.ts', 'intents')
const H = await load('src/renderer/src/handsfree.ts', 'handsfree')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
const read = (f) => readFileSync(f, 'utf8')

/* ----------------------------------------------------------- the command */

check('/restart', K.parseCommand('/restart'), { kind: 'restart' })
check('/relaunch is the same', K.parseCommand('/relaunch'), { kind: 'restart' })
check('/quit no longer claims to quit', K.findCommand('quit').hint.includes('Quit Wumpy'), false)
/* The model may propose it, and it always asks: it is not a chip. */
const proposal = K.readAppProposal('# Restart Wumpy\n/restart')
check('the model can propose it', proposal.refused, null)
check('and it asks first, even on accept-all', proposal.harmless, false)

/* ------------------------------------------------------------ said aloud */

const intent = (t) => I.matchIntent(t)
check('"restart wumpy"', intent('restart wumpy'), { kind: 'restart' })
check('"Restart yourself."', intent('Restart yourself.'), { kind: 'restart' })
check('"can you reboot wumpy please"', intent('can you reboot wumpy please'), { kind: 'restart' })
check('"restart the server" is the user’s work', intent('restart the server'), null)
check('"restart my computer" too', intent('restart my computer'), null)

/* After the turn, not during it; and at once outside one. */
{
  const ran = []
  H.setHandsFree(true)
  H.afterTurn(() => ran.push('restart'))
  check('in a voice turn it waits', ran, [])
  H.setHandsFree(false)
  check('and runs when the turn ends', ran, ['restart'])
  H.afterTurn(() => ran.push('again'))
  check('outside one it runs now', ran, ['restart', 'again'])
  H.setHandsFree(true)
  H.setHandsFree(false)
  check('and only once', ran, ['restart', 'again'])
}

/* ---------------------------------------------------------------- wiring */

const main = read('src/main/index.ts')
const app = read('src/renderer/src/App.tsx')
const tray = read('src/main/tray.ts')
const preload = read('src/preload/index.ts')
const prompt = read('src/shared/assistant.ts')

check('it relaunches, then quits in order', /app\.relaunch\(\{ args \}\)\s+app\.quit\(\)/.test(main), true)
check('not app.exit, so the counts are flushed', /async function restartWumpy[\s\S]{0,900}app\.exit/.test(main), false)
check('the music comes back first', /await releaseAllMusic\(\)[\s\S]{0,80}app\.relaunch/.test(main), true)
check('hidden stays hidden', /if \(!panel\?\.onScreen\) args\.push\('--hidden'\)/.test(main), true)
check('one start’s flags are not carried over', /OWN_FLAGS = \/\^--\(\?:hidden\|voice\|toggle\|restart/.test(main), true)
check('the chat id is checked before it is passed', /if \(chatId && \/\^\[\\w-\]\{1,80\}\$\/\.test\(chatId\)\)/.test(main), true)
check('and handed back once', /const id = launchChat\s+launchChat = null/.test(main), true)
check('wumpy --restart restarts the running one', /argv\.includes\('--restart'\)\)\s*\{\s*askRestart/.test(main), true)
check('a panel that does not answer is restarted anyway', /setTimeout\(\(\) => void restartWumpy\(/.test(main), true)
check('the tray offers it', tray.includes("label: 'Restart Wumpy'"), true)
check('the keys are never touched', /restartWumpy[\s\S]{0,1200}(keys\.clear|keys\.bin)/.test(main), false)

check('the panel saves the chat first', /chats\s+\.save\(\{ id: chatId[\s\S]{0,200}window\.wumpy\.app\.restart\(keep \? chatId : null, why\)/.test(app), true)
check('and opens it again at startup', /launchChat\(\)\.then\(\(id\) => \{\s+if \(id\) void openChatRef\.current\(id\)/.test(app), true)
check('the earbuds hear that it is restarting', /tell\('Restarting\.'\)\s+afterTurn\(/.test(app), true)
check('the preload carries it', /restart: \(chatId: string \| null, why: string\)/.test(preload), true)
check('the model knows it may propose it', prompt.includes('/restart,'), true)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} restart checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
