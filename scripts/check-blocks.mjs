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
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Counted before the main tally exists, and folded into it below. */
let failedControl = 0

/* --------------------------------- control characters in the source ------ */

/**
 * The bug in this file's own header, caught automatically this time.
 *
 * A regex here once held literal backspace characters instead of word
 * boundaries, so it matched nothing and every proposed command rendered as
 * inert code. It happened again while building bench-ceiling: seven of them
 * in one file, because these scripts are edited by Python helpers and a `\b`
 * in a Python string is chr(8), not a regex boundary. One of them sat in a
 * grader that could therefore never pass, and reported a correct answer as a
 * failure for three runs.
 *
 * Nothing in a listing shows it. grep, sed and the editor all render chr(8)
 * as nothing at all, so the line reads exactly as intended. Only a scan
 * finds it - and writing this check with escape sequences put three more
 * control characters into this very file, so it is written with character
 * codes and no escapes at all.
 */
function controlCharsIn(text) {
  const found = new Set()
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Tab, newline and carriage return are the only ones source may contain.
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) found.add(code)
    if (code === 127) found.add(code)
  }
  return [...found]
}

{
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (['.ts', '.tsx', '.mjs', '.cjs', '.js'].some((e) => entry.name.endsWith(e))) {
        files.push(full)
      }
    }
  }
  walk('src')
  walk('scripts')

  let dirty = 0
  for (const file of files) {
    const codes = controlCharsIn(readFileSync(file, 'utf8'))
    if (codes.length === 0) continue
    dirty++
    failedControl++
    console.log(`FAIL control characters in ${file}: ${codes.join(', ')}`)
  }
  console.log(
    `${dirty ? 'FAIL' : 'ok  '} ${files.length} source files free of stray control characters`
  )
}

const CASES = [
  [
    'powershell command',
    '```wumpy-run\n# Check whether Ollama is installed\nollama list\n```',
    'CommandCard'
  ],
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
    'export function render(text, complete = true, looseFences = false) {',
    '  return renderToStaticMarkup(',
    '    React.createElement(Markdown, {',
    "      text, tier: 'thinker', complete, looseFences,",
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

let failed = failedControl
for (const [name, md, want] of CASES) {
  const got = classify(render(md))
  const ok = got === want
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} ${got}${ok ? '' : `   (expected ${want})`}`
  )
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
 * Rendered mid-stream (`complete: false`), which is when it matters: the guard
 * being tested is the unclosed fence, not the streaming flag behind it.
 */
let fragments = 0
let cards = 0
for (let n = 1; n <= FULL.length; n++) {
  const html = render(FULL.slice(0, n), false)
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

/**
 * The other half: a command whose fence has closed is ready even though the
 * model is still writing. Waiting for the whole answer costs however long it
 * spends on the sentence after the block, which on this hardware is seconds.
 */
const CLOSED_THEN_PROSE = `${FULL}\n\nThat will write the three lines into`
const midStream = render(CLOSED_THEN_PROSE, false)
const readyEarly = !midStream.includes('still writing') && proposed(midStream) === WHOLE_COMMAND
if (!readyEarly) failed++
console.log(`${readyEarly ? 'ok  ' : 'FAIL'} a closed block is ready while the answer continues`)

const NL = String.fromCharCode(10)

/** Counted into the same tally as the table-driven cases above. */
let extraChecks = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failedControl++
  extraChecks++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(48)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

/* --------------------------------- a fence tag the model will not write -- */

/**
 * Gemini answers correctly and tags the fence ```powershell, where Wumpy
 * asks for ```wumpy-run. Without that tag the command is grey text with no
 * button, so a model easily clever enough for the whole ladder scored 1 of
 * 38 - almost all of it this one thing, on the first call, before any quota
 * was touched.
 *
 * Promoting the fence is narrow on purpose. The alternative is a Run button
 * under every snippet anyone writes to illustrate syntax.
 */
{
  const psOnly = ['Here is how:', '```powershell', 'Get-PSDrive C', '```'].join(NL)

  // Off by default: a compliant model keeps the distinction it drew.
  check('a plain fence is inert by default', classify(render(psOnly)), 'code block')
  check('and runnable for a model that needs it', classify(render(psOnly, true, true)), 'CommandCard')
  check(
    'with the command intact',
    proposed(render(psOnly, true, true)),
    'Get-PSDrive C'
  )

  // cmd and bash too, since the app runs all three.
  const cmdOnly = ['```cmd', 'dir', '```'].join(NL)
  check('a cmd fence too', classify(render(cmdOnly, true, true)), 'CommandCard')

  /**
   * If the model DID write a proper block, it meant the difference, and a
   * powershell fence beside it is an example rather than a second offer.
   */
  const both = [
    '```wumpy-run',
    'Get-Date',
    '```',
    'For reference, the long way is:',
    '```powershell',
    'Get-CimInstance Win32_OperatingSystem | Select-Object LocalDateTime',
    '```'
  ].join(NL)
  const bothHtml = render(both, true, true)
  check('a real block wins over a loose one', proposed(bothHtml), 'Get-Date')
  check('and the example stays inert', (bothHtml.match(/class="cmd /g) ?? []).length, 1)

  // An ask or write block counts as "it knows the tags", too.
  const askThenPs = ['```wumpy-ask', 'Which?', '- a', '- b', '```', '```powershell', 'Get-Date', '```'].join(NL)
  check(
    'an ask block also means it knows the tags',
    (render(askThenPs, true, true).match(/class="cmd /g) ?? []).length,
    0
  )

  // Only the first loose fence is promoted.
  const twoPs = ['```powershell', 'Get-Date', '```', '```powershell', 'Remove-Item x', '```'].join(NL)
  const twoHtml = render(twoPs, true, true)
  check('only the first loose fence is promoted', (twoHtml.match(/class="cmd /g) ?? []).length, 1)
  check('and it is the first one', proposed(twoHtml), 'Get-Date')
}

/* ------------------------------------------- only one live button per turn */

/**
 * Asked "my firewall is off, turn it back on", the model proposed the check
 * AND the change: a Get-NetFirewallProfile block and a Set-NetFirewallProfile
 * block, both rendered as cards. The user was handed a live button to alter a
 * security setting next to the button that would have told them whether it
 * needed altering.
 *
 * The prompt already said to propose one command. Nothing enforced it, so
 * this does: later blocks stay visible as code and lose the button.
 */
const TWO_BLOCKS = [
  'First check which profiles are off:',
  '',
  '```wumpy-run',
  'Get-NetFirewallProfile | Select-Object Name, Enabled',
  '```',
  '',
  'Then turn them on:',
  '',
  '```wumpy-run',
  'Set-NetFirewallProfile -All -Enabled True',
  '```'
].join(NL)

const twoHtml = render(TWO_BLOCKS)
const cardCount = (twoHtml.match(/class="cmd /g) ?? []).length
const oneCard = cardCount === 1
if (!oneCard) failed++
console.log(`${oneCard ? 'ok  ' : 'FAIL'} two proposed commands render ${cardCount} card`)

// And it is the first one that kept the button, not the destructive second.
const keptFirst = proposed(twoHtml) === 'Get-NetFirewallProfile | Select-Object Name, Enabled'
if (!keptFirst) failed++
console.log(`${keptFirst ? 'ok  ' : 'FAIL'} the runnable one is the first block`)

// The second is still readable, just inert.
const stillShown = twoHtml.includes('Set-NetFirewallProfile')
if (!stillShown) failed++
console.log(`${stillShown ? 'ok  ' : 'FAIL'} the second is still shown, as code`)

// Mixed tags count too - a cmd or bash block after a powershell one.
const MIXED = ['```wumpy-run', 'Get-Date', '```', '', '```wumpy-run-cmd', 'del x', '```'].join(NL)
const mixedCards = (render(MIXED).match(/class="cmd /g) ?? []).length
const mixedOk = mixedCards === 1
if (!mixedOk) failed++
console.log(`${mixedOk ? 'ok  ' : 'FAIL'} a later cmd block is inert too (${mixedCards} card)`)

/**
 * A question and a command are different decisions, so an ask block is
 * untouched: the rule is one thing to RUN, not one card.
 */
const ASK_THEN_RUN = [
  '```wumpy-ask',
  'Which folder?',
  '- Downloads',
  '- Documents',
  '```',
  '',
  '```wumpy-run',
  'Get-Date',
  '```'
].join(NL)
const askHtml = render(ASK_THEN_RUN)
const bothKept = askHtml.includes('class="ask') && proposed(askHtml) === 'Get-Date'
if (!bothKept) failed++
console.log(`${bothKept ? 'ok  ' : 'FAIL'} an ask block does not consume the one command`)

rmSync(out, { force: true })

const total = CASES.length + 9 + extraChecks
console.log(`\n${total - failed}/${total} block checks correct`)
process.exit(failed === 0 ? 0 : 1)
