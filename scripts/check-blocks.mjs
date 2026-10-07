/**
 * Renders every kind of fenced block the model can emit and asserts it becomes
 * the right component.
 *
 * This exists because the opposite went unnoticed for a while: a regex that
 * detects `wumpy-run` fences ended up with literal backspace characters in it,
 * so it never matched, and every proposed command rendered as an inert code
 * block with no Run button. Nothing failed loudly — the feature was simply
 * dead. Unit tests on the parsers passed, because the parsers were fine; the
 * wiring between them and the renderer was not.
 *
 * Run with: npm run check:blocks
 */
import { build } from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CASES = [
  ['powershell command', '```wumpy-run\n# Check whether Ollama is installed\nollama list\n```', 'CommandCard'],
  ['cmd command', '```wumpy-run-cmd\n# list files\ndir\n```', 'CommandCard'],
  ['bash command', '```wumpy-run-bash\n# list files\nls -la\n```', 'CommandCard'],
  ['question', '```wumpy-ask\nWhich folder?\n- Downloads\n- Documents\n```', 'AskCard'],
  ['web search', '```wumpy-search\n# find it\nlatest electron version\n```', 'SearchCard'],
  ['ordinary code', '```powershell\nGet-Date\n```', 'code block'],
  ['untagged code', '```\nsome text\n```', 'code block'],
  ['prose', 'Just a sentence.', 'prose'],
  // A near miss must not become runnable.
  ['lookalike tag', '```wumpy-runner\nnope\n```', 'code block'],
  // Half-streamed blocks. Markdown renders an unclosed fence as a code block,
  // so the card exists long before the command inside it does.
  ['half-written fence', '```wumpy-run\n# Create te', 'CommandCard'],
  ['comment only', '```wumpy-run\n# Create text.txt\n```', 'CommandCard']
]

/**
 * Prefixes of a streaming answer, each of which once ran as a command.
 *
 * A comment line arriving a character at a time produced `#`, `# Create`,
 * `# Create text` and so on, and in an automatic mode every one of them ran.
 * De-duplicating commands could not help, because each prefix is a different
 * string; and `#` is valid PowerShell that exits 0 with no output, so each one
 * looked like a real, quiet success.
 */
const FULL = [
  'Creating text.txt in your music folder.',
  '',
  '```wumpy-run',
  '# Create text.txt and add content',
  'Set-Content -Path "C:/Users/me/Music/text.txt" -Value "Hi"',
  '```'
].join('\n')

const WHOLE_COMMAND = 'Set-Content -Path "C:/Users/me/Music/text.txt" -Value "Hi"'

// The entry lives inside the project so a relative import resolves normally,
// and is removed again whether or not the check passes.
const entry = join(process.cwd(), '.block-check.entry.tsx')
const out = join(process.cwd(), '.block-check.bundle.cjs')

writeFileSync(
  entry,
  [
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { Markdown } from './src/renderer/src/components/Markdown'",
    "globalThis.window = { wumpy: { shell: { check: async () => ({ risk: null, allowed: true, scope: 'full' }) } } }",
    'export function render(text) {',
    '  return renderToStaticMarkup(',
    '    React.createElement(Markdown, {',
    "      text, tier: 'thinker',",
    '      onRunCommand: async () => null, onCommandResult: () => {},',
    '      onAnswer: () => {},',
    "      onSearch: async () => ({ results: [], provider: 'none' }), onSearchResults: () => {}",
    '    })',
    '  )',
    '}'
  ].join('\n')
)

let render
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
  ;({ render } = await import(pathToFileURL(out).href))
} finally {
  rmSync(entry, { force: true })
}



function classify(html) {
  if (html.includes('class="cmd search')) return 'SearchCard'
  if (html.includes('class="ask')) return 'AskCard'
  if (html.includes('class="cmd ')) return 'CommandCard'
  if (html.includes('codeblock')) return 'code block'
  return 'prose'
}

let failed = 0
for (const [name, md, want] of CASES) {
  const got = classify(render(md))
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} ${got}${ok ? '' : `   (expected ${want})`}`)
}

/* --------------------------------------------- the streaming-prefix cascade */

/** What the card would actually hand to the shell. */
function proposed(html) {
  const m = html.match(/<pre class="cmd-body">([\s\S]*?)<\/pre>/)
  if (!m) return null
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * Showing the command as it arrives is fine; treating it as a proposal is not.
 * A card that is not ready says so, and only a card that is ready can run.
 *
 * Rendered with `complete` left at its default of true — that is, as though
 * streaming had already finished — so this tests the unclosed-fence guard on
 * its own rather than the streaming flag that is supposed to back it up.
 */
let fragments = 0
let cards = 0
for (let n = 1; n <= FULL.length; n++) {
  const html = render(FULL.slice(0, n))
  const body = proposed(html)
  if (body === null) continue
  cards++
  const ready = !html.includes('still writing')
  if (ready && body !== WHOLE_COMMAND) {
    if (fragments < 3) console.log(`FAIL would propose a fragment: ${JSON.stringify(body)}`)
    fragments++
  }
}
if (fragments > 0) failed++

// ...and the finished block must actually become runnable, or the guard above
// is just a way of never running anything.
const finalHtml = render(FULL)
const finalReady = !finalHtml.includes('still writing') && proposed(finalHtml) === WHOLE_COMMAND
if (!finalReady) failed++

console.log(
  `${fragments === 0 ? 'ok  ' : 'FAIL'} ${cards} cards across a streaming answer, ` +
    `${fragments} ready to run a fragment`
)
console.log(`${finalReady ? 'ok  ' : 'FAIL'} the finished block is ready to run`)

rmSync(out, { force: true })

const total = CASES.length + 2
console.log(`\n${total - failed}/${total} block checks correct`)
process.exit(failed === 0 ? 0 : 1)
