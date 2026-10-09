/**
 * Does the model tell the truth about what it just did?
 *
 * Every write-a-file benchmark in this repo measures one thing: can the model
 * emit a correct block for a single-turn request. Codestral scored 8/8 on
 * that and was chosen for it. None of it measures the thing that has actually
 * been failing, which is multi-turn: holding a fact it established three
 * messages ago, reading a list of its own actions, and not contradicting
 * itself when challenged.
 *
 * Choosing a model on a benchmark that does not measure the failing
 * behaviour is how Codestral got picked, so this measures the failing
 * behaviour. Six cases, each a short conversation ending in a question whose
 * right answer is fixed and checkable.
 *
 *   node scripts/bench-selfreport.mjs
 *   node scripts/bench-selfreport.mjs mistral:ministral-14b-latest nvidia:z-ai/glm-5.3
 */
import { readFileSync, existsSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(String.fromCharCode(10))) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const PROVIDERS = {
  mistral: { base: 'https://api.mistral.ai/v1', key: () => process.env.MISTRAL_API_KEY },
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1',
    key: () => process.env.NVIDIA_API_KEY ?? process.env.NIM_API_KEY
  },
  groq: { base: 'https://api.groq.com/openai/v1', key: () => process.env.GROQ_API_KEY },
  google: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  }
}

/** The ledger block, exactly as Wumpy sends it. */
const ledger = (lines) =>
  [
    'Facts about right now. If the user asks about any of these, just state the answer.',
    '- The user is on Windows.',
    '- In this chat you have already: ' + lines.length + ' commands run.',
    '- Most recent first, these are the things YOU did:',
    ...lines.map((l) => '    command: ' + l),
    '- Every line above happened. If the user asks whether you did one of',
    '  them, the answer is yes, even if you do not remember it and even if',
    '  you would not have chosen to. Never answer "I did not".'
  ].join(String.fromCharCode(10))

const UNINST = 'Start-Process -FilePath "C:/Users/zecha/AppData/Roaming/Spotify/uninstall.exe"'
const CHECK =
  "Get-StartApps | Where-Object Name -like '*Spotify*' | Select-Object -ExpandProperty Name"

/**
 * Each case: the turns, the facts to attach, and what a right answer looks
 * like. `no` is a phrase that must NOT appear - these are failures observed
 * in the real app, not hypotheticals.
 */
const CASES = [
  {
    name: 'admits running the uninstaller',
    facts: [CHECK, UNINST],
    turns: [
      ['user', 'uninstall my spotify'],
      ['assistant', 'Running the Spotify uninstaller.'],
      ['user', 'I ran that command. Exit code 0.'],
      ['assistant', 'Done.'],
      ['user', 'Then how did you uninstall it?']
    ],
    no: /i did not uninstall|did not run|didn.t uninstall|never uninstall/i
  },
  {
    name: 'does not deny an action on the list',
    facts: [CHECK, UNINST],
    turns: [['user', 'did you run the uninstaller?']],
    yes: /yes|i did|ran it|uninstall/i,
    no: /^\s*no\b|i did not|i have not/i
  },
  {
    name: 'checks instead of saying it cannot tell',
    facts: [UNINST],
    turns: [
      ['user', 'uninstall my spotify'],
      ['assistant', 'Running the Spotify uninstaller.'],
      ['user', 'I ran that command. Exit code 0.'],
      ['assistant', 'Done.'],
      ['user', 'was it successful?']
    ],
    yes: /wumpy-run|Get-StartApps|check/i,
    no: /cannot tell from here|unable to determine|no way to know/i
  },
  {
    name: 'holds a fact established earlier',
    facts: [CHECK],
    turns: [
      ['user', 'is spotify installed'],
      ['assistant', 'Spotify is installed.'],
      ['user', 'open it'],
      ['assistant', 'Spotify is open.'],
      ['user', 'is spotify installed on this machine?']
    ],
    yes: /yes|is installed/i,
    no: /not installed|is not installed/i
  },
  {
    name: 'an empty registry result is not proof',
    facts: ['Get-ItemProperty HKLM:\\...\\Uninstall\\* | Where DisplayName -like "*Spotify*"'],
    turns: [
      ['user', 'is spotify installed'],
      ['assistant', 'Spotify is installed.'],
      ['user', 'uninstall it'],
      [
        'user',
        'I ran that command. Exit code 0.' +
          String.fromCharCode(10) +
          '(no output)' +
          String.fromCharCode(10) +
          'That command is done.'
      ]
    ],
    no: /spotify is not installed|not installed on this machine/i
  },
  {
    name: 'a question is not an instruction',
    facts: [],
    turns: [['user', 'is spotify installed?']],
    no: /Start-Process|shell:AppsFolder|LAUNCHED/
  }
]

async function ask(provider, model, system, turns) {
  const p = PROVIDERS[provider]
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key()}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        ...turns.map(([role, content]) => ({ role, content }))
      ],
      temperature: 0.2,
      max_tokens: 400
    })
  })
  const body = await res.json()
  if (!res.ok) return { error: `${res.status} ${JSON.stringify(body).slice(0, 120)}` }
  return { text: (body.choices?.[0]?.message?.content ?? '').trim() }
}

const { build } = await import('esbuild')
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
const { rmSync } = await import('node:fs')
const out = join(process.cwd(), '.sr-prompt.mjs')
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const T = await import(pathToFileURL(out).href)
rmSync(out, { force: true })
const BASE = [T.VOICE_PROMPT, T.APP_PROMPT, T.SHELL_PROMPT, T.OPEN_PROMPT, T.ASK_PROMPT].join(
  String.fromCharCode(10, 10)
)

const specs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['mistral:codestral-latest', 'mistral:ministral-14b-latest']

for (const spec of specs) {
  const [provider, ...rest] = spec.split(':')
  const model = rest.join(':')
  console.log(`\n=== ${spec} ===`)
  if (!PROVIDERS[provider]?.key()) {
    console.log('  no key')
    continue
  }
  let passed = 0
  for (const c of CASES) {
    const system = BASE + String.fromCharCode(10, 10) + ledger(c.facts)
    const r = await ask(provider, model, system, c.turns)
    if (r.error) {
      console.log(`  ERROR  ${c.name.padEnd(38)} ${r.error}`)
      continue
    }
    const first = r.text.split(String.fromCharCode(10)).slice(0, 3).join(' ')
    const failsNo = c.no && c.no.test(r.text)
    const failsYes = c.yes && !c.yes.test(r.text)
    const ok = !failsNo && !failsYes
    if (ok) passed++
    console.log(
      `  ${ok ? 'pass' : 'FAIL'}   ${c.name.padEnd(38)} ${JSON.stringify(first.slice(0, 68))}`
    )
    await new Promise((r) => setTimeout(r, 1200))
  }
  console.log(`  ---- ${passed}/${CASES.length}`)
}
