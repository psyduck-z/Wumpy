/**
 * Checks the commands an answer offers as buttons.
 *
 * Wumpy is told to answer "rename this chat" with `/rename` and nothing else.
 * That is the right answer and it used to be a dead end: the user read a
 * command and then typed it out, which is the same complaint that `/listen`
 * got - "how am I supposed to remember this?" - one step earlier.
 *
 * So a line that is nothing but a command is a button now. Which makes two
 * questions worth checking, and neither is about appearance:
 *
 *   WHAT BECOMES ONE. An answer is model output and this app feeds the model
 *   web pages, so a page can propose the words in an answer. The allowlist in
 *   commands.ts is checked by check-commands; what is checked here is that
 *   the renderer asks it at all, and that a shell command inside a fence is
 *   never mistaken for one of Wumpy's.
 *
 *   AND WHAT DOES NOT BREAK. The `code` and `p` renderers are now Wumpy's
 *   rather than react-markdown's defaults, and every block in this app is
 *   read out of the element tree underneath them: a card that stopped being
 *   recognised would be a command that stopped being offered.
 *
 * Rendered with react-dom/server, like check-blocks, because the question is
 * what the panel actually produces.
 *
 * Run with: npm run check:chips
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = join(process.cwd(), '.chip-check.entry.tsx')
const out = join(process.cwd(), '.chip-check.bundle.cjs')

writeFileSync(
  entry,
  [
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { Markdown } from './src/renderer/src/components/Markdown'",
    "import { helpText } from './src/renderer/src/commands'",
    'globalThis.window = { wumpy: { shell: { check: async () => ({ risk: null, allowed: true, scope: 0 }) } } }',
    'export { helpText }',
    'export function render(text, offers = true) {',
    '  return renderToStaticMarkup(',
    '    React.createElement(Markdown, {',
    '      text,',
    '      complete: true,',
    '      onCommand: offers ? () => {} : undefined,',
    '      onRunCommand: async () => null,',
    '      onCommandResult: () => {}',
    '    })',
    '  )',
    '}'
  ].join('\n')
)

let render
let helpText
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    jsx: 'automatic',
    logLevel: 'error',
    loader: { '.css': 'empty' }
  })
  ;({ render, helpText } = await import(pathToFileURL(out).href))
} finally {
  rmSync(entry, { force: true })
}

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 46)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 46)} expected ${JSON.stringify(want)}`)
}

const chips = (html) => (html.match(/class="cmd-chip"/g) ?? []).length
const BT = String.fromCharCode(96)
const FENCE = BT.repeat(3)

/* ------------------------------------------------- what becomes a button */

check('a command on its own is one', chips(render('/engine')), 1)
check(
  'and it carries the command',
  render('/engine').includes('>/engine</button>'),
  true
)
check('written as code, in a sentence', chips(render(`Change it with ${BT}/engine${BT}.`)), 1)
check(
  'and the sentence is still there',
  render(`Change it with ${BT}/engine${BT}.`).includes('Change it with'),
  true
)
check('an argument comes along', chips(render(`${BT}/dock left${BT}`)), 1)
check('aliases resolve', chips(render('/tokens')), 1)

/* --------------------------------------------------- and what does not */

check('prose that mentions one', chips(render('Type /engine to change it.')), 0)
check('a command that may not be offered', chips(render('/key nvidia nvapi-0000')), 0)
check('a command that does not exist', chips(render('/nosuchthing')), 0)
/*
 * The one the fence context exists for.
 *
 * react-markdown calls the same renderer for inline code and for a fence
 * with no language on it, so from inside there is nothing to tell them
 * apart. A shell line that happens to start with a slash - a path, a flag,
 * anything - must not become one of Wumpy's commands.
 */
check(
  'a fence with no language',
  chips(render([FENCE, '/engine', FENCE].join('\n'))),
  0
)
check(
  'and it is still a code block',
  render([FENCE, '/engine', FENCE].join('\n')).includes('codeblock'),
  true
)
/* A summary of an old conversation is a record, not an offer: Message
   renders it without the handler, and nothing in it is clickable. */
check('an answer with nothing to run', chips(render('/engine', false)), 0)
check(
  'which is still code',
  render(`${BT}/engine${BT}`, false).includes('<code>/engine</code>'),
  true
)

/* ------------------------------------------- and the blocks still work */

const RUN = [FENCE + 'wumpy-run', 'Get-Date', FENCE].join('\n')
check('a command fence is still a card', render(RUN).includes('class="cmd '), true)
check('and its command survives', render(RUN).includes('Get-Date'), true)
check(
  'ordinary inline code is still code',
  render(`Run ${BT}Get-Date${BT} for the time.`).includes('<code>Get-Date</code>'),
  true
)
check(
  'and highlighting still has its class',
  render([FENCE + 'js', 'const x = 1', FENCE].join('\n')).includes('language-js'),
  true
)

/* --------------------------------------------------------------- /help */

/*
 * The table is where somebody goes to find out what exists, which makes it
 * the worst place to end at "now type it out". Every clickable command in it
 * is a button; /key and /delete are not, and are still listed.
 */
{
  const html = render(helpText())
  check('/help offers the clickable ones', chips(html) > 15, true)
  check('and does not offer /key', html.includes('>/key</button>'), false)
  check('but still lists it', html.includes('/key'), true)
}

rmSync(out, { force: true })
console.log(failed === 0 ? '\nall chip checks correct' : `\n${failed} chip checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
