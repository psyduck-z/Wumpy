/**
 * Wumpy keeping its own receipts.
 *
 * Asked whether it had opened Spotify, the model said "I did not open
 * Spotify. I checked whether it is installed", said it again when told it was
 * wrong, said it a third time, and admitted it only when told to re-read its
 * own command. The output of that command said LAUNCHED.
 *
 * The prompt rules written after the first occurrence did not hold, and on
 * reflection they could not: they asked the model to be honest about its own
 * memory of its own intent, and its memory was that the command was "the
 * installed-check" - which is what the prompt had called it. It was reading
 * the label rather than the receipt.
 *
 * So the app keeps the receipt. Every command, write, link and search is
 * recorded by the code that performed it and stated in the facts block, and
 * the model is told that anything on that list happened. It is no longer
 * being asked to remember; it is being told.
 *
 * The case that makes this worth the tokens is the user's own: a script that
 * runs once and does something that cannot be undone. "I didn't run anything"
 * about one of those is the worst sentence this app could produce.
 *
 * Run with: node scripts/check-ledger.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.ledger-check.mjs')
await build({
  entryPoints: ['src/renderer/src/ledger.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const L = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

/* ------------------------------------------------- nothing has happened yet */

// An ordinary conversation must pay nothing for this. The facts block is sent
// on every turn and every line in it is billed on every turn.
check('a fresh chat records nothing', L.actionsSoFar().length, 0)
check('and adds no facts', L.actionFacts(), [])

/* --------------------------------------------------------- one command run */

L.record('command', "Get-StartApps | Where-Object Name -like '*Spotify*'")
const one = L.actionFacts()
check('one command is recorded', L.actionsSoFar().length, 1)
check('and stated in the singular', one[0].includes('1 command run'), true)
check('with the command itself named', one[1].includes('Get-StartApps'), true)
// The sentence the model has to read before it can deny anything.
check('and the denial closed off', one.join(' ').includes('Do not deny it'), true)
check('the answer to "did you" is given', one.join(' ').includes('the answer is yes'), true)

/* ------------------------------------------------------- the Spotify case */

L.record('command', '$a = Get-StartApps ...; Start-Process $a; "LAUNCHED $a"')
const two = L.actionFacts()
check('two commands counted', two[0].includes('2 commands run'), true)
// "Did you just open Spotify" is always about the last thing.
check('the most recent is the one named', two[1].includes('Start-Process'), true)
check('and not the earlier one', two[1].includes('Where-Object'), false)

/* ------------------------------------------- several kinds at once */

L.record('write', 'C:\\Users\\zecha\\Downloads\\hello.py')
L.record('open', 'open.spotify.com')
L.record('open', 'github.com')
const mixed = L.actionFacts().join(' ')
check('commands still counted', mixed.includes('2 commands run'), true)
check('files counted separately', mixed.includes('1 file written'), true)
check('and links, pluralised', mixed.includes('2 links opened'), true)

/* ---------------------------------------------------- bounded, and cleared */

// Every line here is paid for on every turn for the rest of the chat, so a
// long command cannot drag the whole thing in with it.
L.record('command', 'X'.repeat(500))
const long = L.actionFacts()[1]
check('a long command is clipped', long.length < 200, true)
check('and says so', long.endsWith('…'), true)

L.forgetActions()
check('a new chat starts clean', L.actionsSoFar().length, 0)
// Without this, reopening a saved chat would claim this session did things
// that happened in another one.
check('and claims nothing', L.actionFacts(), [])

/* ------------------------------------------------------- wired into the app */

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const useChat = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const prompt = readFileSync('src/shared/assistant.ts', 'utf8')

// Recorded by the code that acted, not inferred from the transcript later.
check('a command records itself', /record\('command', result\.command\)/.test(app), true)
check('a write records itself', /record\('write', result\.path\)/.test(app), true)
check('a link records itself', /record\('open', result\.host\)/.test(app), true)
check('a search records itself', /record\('search', query\)/.test(app), true)
// A failed write or a refused link did not happen and must not be claimed.
check('only a write that happened', /result\.written\) record\('write'/.test(app), true)
check('only a link that opened', /result\.opened\) record\('open'/.test(app), true)

check('cleared with the conversation', (app.match(/forgetActions\(\)/g) ?? []).length >= 2, true)
check('sent with every turn', useChat.includes('actions: actionFacts()'), true)
check('and reaches the facts block', main.includes('...actions'), true)

// The rule that tells the model the list outranks its recollection.
check(
  'the prompt points at the facts',
  prompt.includes('WHAT YOU DID IS IN THE FACTS, NOT IN YOUR MEMORY'),
  true
)
check('and names the Spotify failure', prompt.includes('calls Start-Process started the app'), true)
// The over-correction is its own failure: told off for one action, the model
// answered "I will not run any commands."
check('not over-correcting into uselessness', prompt.includes('This is not "never act"'), true)

console.log(failures ? `\n${failures} ledger checks FAILED` : '\nall ledger checks')
process.exitCode = failures ? 1 : 0
