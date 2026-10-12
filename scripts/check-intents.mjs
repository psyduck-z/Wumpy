/**
 * The phrases Wumpy answers itself, and the ones it must not steal.
 *
 * Asking a model to rename a chat is the worst use of one: the answer is
 * always the same slash command, and a reasoning model ties itself in knots
 * over being asked to do something it cannot - measured at 129 seconds and
 * 3,620 characters of scratchpad for "rename this chat to Speculative
 * Fiction". So a handful of phrasings never reach a model.
 *
 * Which makes the FALSE POSITIVES the dangerous half, and this module had no
 * checks at all. A phrase matched here never reaches the model, so a pattern
 * that is a shade too generous does not answer slightly wrong - it answers a
 * different question entirely and the real one is gone. Two were:
 *
 *   "rename it to Bob"   - the chat and the file the user was just discussing
 *                          are both "it". The word chat is required now.
 *   "show history"       - PowerShell has one, the browser has one, the
 *                          composer has one. Only the chats' history counts.
 *
 * So most of what follows is phrases that must FALL THROUGH, which is the
 * side a regex is never written for.
 *
 * Run with: npm run check:intents
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.intents-check.mjs'
await build({
  entryPoints: ['src/renderer/src/intents.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const { matchIntent } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const kind = (text) => matchIntent(text)?.kind ?? null
const title = (text) => matchIntent(text)?.title ?? null

/* ------------------------------------------------- what it should recognise */

check('rename this chat to X', kind('rename this chat to Ideas'), 'rename')
check('and takes the title', title('rename this chat to Ideas'), 'Ideas')
check('retitle, as', kind('retitle this chat as Ideas'), 'rename')
check('call this chat X', title('call this chat Ideas'), 'Ideas')
check('name this conversation X', title('name this conversation Ideas'), 'Ideas')
check('the conversation', title('rename the conversation to Ideas'), 'Ideas')
check('my chat', title('rename my chat to Ideas'), 'Ideas')
check('no "to" at all', title('rename this chat Ideas'), 'Ideas')
check('a polite one', title('please can you rename this chat to Ideas'), 'Ideas')
check('a full stop is not part of the name', title('rename this chat to Ideas.'), 'Ideas')
check('a new chat', kind('start a new chat'), 'new')
check('clearing one', kind('clear this conversation'), 'new')
check('compacting one', kind('compact this chat'), 'compact')
check('and the saved ones', kind('show my chats'), 'resume')
check('listed', kind('list conversations'), 'resume')
check('or the chat history by name', kind('show my chat history'), 'resume')

/* ------------------------------------------------ what must reach the model */

/*
 * The object has to be the chat. "it" is whatever was being talked about one
 * turn ago, which on this app is usually a file, a window or a tab.
 */
check('rename it to X is not for us', kind('rename it to Bob'), null)
check('nor rename this to X', kind('rename this to Bob'), null)
check('nor a file', kind('rename the file to notes.txt'), null)
check('nor a folder', kind('rename this folder to Archive'), null)
check('nor a tab', kind('rename the tab to Inbox'), null)
check('and not a bare history', kind('show history'), null)
check('nor the shell history', kind('show my powershell history'), null)
check('nor clearing something else', kind('clear the recycle bin'), null)
check('nor resetting the machine', kind('reset my password'), null)
check('nor a new file', kind('make a new file'), null)
check('nor compacting a disk', kind('compact the disk'), null)
/* A question is a question, even when it contains the words. */
check('a question falls through', kind('can you rename this chat?'), null)
check('a slash command is the parser"s', kind('/rename Ideas'), null)
/* A paragraph that happens to contain "rename" is a conversation. */
check(
  'and so does a long sentence',
  kind(
    'I was wondering whether you could rename this chat to something shorter because the title is long'
  ),
  null
)
check('nothing is nothing', kind('   '), null)
check('a title with no name asks for the picker instead', kind('rename this chat to a better name'), null)

/* -------------------------------------------------------- ambiguous quoting */

/*
 * `rename this chat to "very funny"` probably wants the quotes; `to
 * "mathematics"` probably does not. Nothing in the text says which, so it
 * asks - one click is cheaper than being wrong, and far cheaper than a
 * reasoning model deliberating for two minutes.
 */
{
  const asked = matchIntent('rename this chat to "very funny"')
  check('quotes raise a choice', asked?.kind, 'renameChoice')
  check('with both readings', asked?.options, ['very funny', '"very funny"'])
  check('the stripped one is offered first', asked?.options?.[0], 'very funny')
}
check('an unquoted title does not ask', matchIntent('rename this chat to very funny')?.kind, 'rename')

/* --------------------------------------------------- the pattern itself */

const src = readFileSync('src/renderer/src/intents.ts', 'utf8')
check('the chat is named, not assumed', /\(\?:chat\|conversation\)\\s\*/.test(src), true)
check('and why that matters is written down', /rename it to Bob/.test(src), true)
check('history must be said to be the chats', /conversation history/.test(src), true)

console.log(`${NL}${count - failed}/${count} intent checks passed`)
if (failed) process.exit(1)
