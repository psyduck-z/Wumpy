/**
 * "Did you mean" - and the mistypes it must stay quiet about.
 *
 * Asked for in one line: when a command is mistyped, name the closest one.
 * The easy half is the suggestion; the half that needs checking is silence,
 * because a suggester that answers every mistake sends people to a command
 * they never wanted. "/c" could be /chats, /compact or /cmd, and "/xyzzy" is
 * not nearly anything - so neither gets a guess.
 *
 * The thresholds are measured against the real command list, aliases
 * included, which is why these run against commands.ts rather than a made-up
 * list of words.
 *
 * Run with: npm run check:nearest
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const near = '.nearest-check.mjs'
const cmds = '.nearest-commands.mjs'
for (const [entry, outfile] of [
  ['src/shared/nearest.ts', near],
  ['src/renderer/src/commands.ts', cmds]
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
}
const N = await import(pathToFileURL(near).href)
const { parseCommand, allCommands } = await import(pathToFileURL(cmds).href)
rmSync(near, { force: true })
rmSync(cmds, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(50)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const COMMANDS = allCommands()
/** What the error says after "Did you mean", or null when it says nothing. */
/* The command is in backticks so the panel offers it as a button rather than
   as something to retype; the name inside them is what this reads. */
const suggests = (text) =>
  /Did you mean `\/([^`]+)`\?/.exec(parseCommand(text)?.message ?? '')?.[1] ?? null

/* -------------------------------------------------------------- the distance */

check('a swap is one edit, not two', N.damerau('mdoel', 'model'), 1)
check('and Levenshtein would have said two', N.damerau('model', 'mdeol') >= 1, true)
check('a missing letter', N.damerau('modl', 'model'), 1)
check('a doubled letter', N.damerau('modell', 'model'), 1)
check('a wrong letter', N.damerau('modem', 'model'), 1)
check('the same word is nothing', N.damerau('model', 'model'), 0)
check('case does not count', N.damerau('MODEL', 'model'), 0)
check('nothing against something', N.damerau('', 'model'), 5)
check('two unrelated words', N.damerau('quit', 'model'), 5)

/* ------------------------------------------------------------ what it offers */

check('a transposition', suggests('/mdoel'), 'model')
check('a missing letter', suggests('/modl'), 'model')
check('an extra letter', suggests('/helpp'), 'help')
check('a swap in a short word', suggests('/hlep'), 'help')
check('an abbreviation', suggests('/mod'), 'model')
check('a word typed past its end', suggests('/screenshoot'), 'screen')
check('and another', suggests('/pinned'), 'pin')
check('a longer command', suggests('/reasonign'), 'reasoning')
check('one with two mistakes', suggests('/aproove'), 'approve')
check('a two-letter prefix', suggests('/ne'), 'new')

/*
 * An alias is a real way to invoke it, so the suggestion is the SPELLING that
 * matched. "/qouta" means "/quota", which works - answering "/usage" sends
 * the user to a word they did not reach for.
 */
check('the alias they were aiming at', suggests('/qouta'), 'quota')
check('and another alias', suggests('/histroy'), 'history')

/*
 * A unique prefix wins at any length: there is only one command beginning
 * with k, so there is nothing to be wrong about.
 */
check('one letter, one possible command', suggests('/k'), 'key')

/* --------------------------------------------------- when it must say nothing */

/* Ambiguous: /chats, /compact, /cmd, /clear, /context all start with c. */
check('one letter, several commands', suggests('/c'), null)
/* /new and /notes both start with n, and notes is an alias of /remember. */
check('and n is ambiguous too, through an alias', suggests('/n'), null)
check('a word that is not nearly anything', suggests('/xyzzy'), null)
check('a long one', suggests('/zzzzzzzz'), null)
check('a command that does not exist at all', suggests('/attch'), null)
check('digits', suggests('/12345'), null)

/* The old message is still in there, so /help is still offered. */
check('the error still points at help', /Type \/help to see them all\./.test(parseCommand('/xyzzy').message), true)
check('and it names what was typed', /Unknown command \/xyzzy\./.test(parseCommand('/xyzzy').message), true)
check('a real command is not an error', parseCommand('/help').kind === 'error', false)
check('nor one by its alias', parseCommand('/quota').kind === 'error', false)

/* ------------------------------------------------------- the rules themselves */

check('three letters allow one mistake', N.tolerance(3), 1)
check('six allow two', N.tolerance(6), 2)
check('longer allow three', N.tolerance(12), 3)
check('nothing matches an empty input', N.nearest('', COMMANDS), null)
check('a distance beyond the word length is refused', N.nearest('zz', [{ name: 'ab' }]), null)
/* Both lengths get a say: a long typo must not reach a tiny command. */
check('a long typo does not reach a short name', N.nearest('reviewing', [{ name: 'pin' }]), null)
check('ties go to the first in the list', N.nearest('ab', [{ name: 'abc' }, { name: 'abd' }])?.name, 'abc')
check('an exact name beats a prefix', N.nearest('pin', [{ name: 'pinned' }, { name: 'pin' }])?.name, 'pin')
check('nearestName is just the name', N.nearestName('mdoel', COMMANDS), 'model')

/* --------------------------------------------------------------- the wiring */

const source = readFileSync('src/renderer/src/commands.ts', 'utf8')
check('the parser asks for the nearest', /nearest\(name, allCommands\(\)\)/.test(source), true)
check('and offers the spelling that matched', /did\.via/.test(source), true)

/*
 * Every command's own name must be nearest to itself, which is a cheap way of
 * saying no two commands are confusable with each other by this measure.
 */
{
  const wrong = COMMANDS.filter((c) => N.nearest(c.name, COMMANDS)?.name !== c.name).map((c) => c.name)
  check('every command is its own nearest match', wrong, [])
}

console.log(`${NL}${count - failed}/${count} nearest-match checks passed`)
if (failed) process.exit(1)
