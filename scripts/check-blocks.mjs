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
  ['lookalike tag', '```wumpy-runner\nnope\n```', 'code block']
]

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

rmSync(out, { force: true })

console.log(`\n${CASES.length - failed}/${CASES.length} block types render correctly`)
process.exit(failed === 0 ? 0 : 1)
