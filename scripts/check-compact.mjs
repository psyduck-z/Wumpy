/**
 * Compaction that does not make Wumpy forget (src/shared/compact.ts): "when
 * it compacts context, the AI becomes dumber".
 *
 * Where the cut falls (the task in progress is kept whole, from the request
 * that started it), what the summariser is shown (who said what, output as
 * output, an earlier summary whole), what it is asked for (their
 * instructions quoted, what is done, where it stands), and how the summary
 * reads afterwards (as its memory).
 *
 * The real model, before and after: `--compact-check` in main/index.ts.
 *
 * Run with: node scripts/check-compact.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(66)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

const out = join(process.cwd(), '.compact-check.mjs')
await build({ entryPoints: ['src/shared/compact.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const C = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const u = (content, extra = {}) => ({ role: 'user', content, ...extra })
const a = (content) => ({ role: 'assistant', content })
const out_ = (content) => u(content, { automatic: true })
const words = (n) => 'word '.repeat(n)

/* A chat: some talk, then a task of eight steps, each with output handed back. */
const chat = [
  u('Always answer in short sentences, and call me Sam.'),
  a('Will do, Sam.'),
  u('What is a closure?'),
  a(words(300)),
  u('Make me a snake game in ~/games/snake.html, and test it.'),
  ...Array.from({ length: 8 }, (_, i) => [a(`Step ${i}: writing and running.`), out_(`output ${i} ` + words(250))]).flat(),
  a('The snake game works. Next I will add a high score.')
]
const at = C.cutPoint(chat, C.keepBudget(32768, 6000))
check('the task in progress is kept whole, from the request that began it', chat[at].content, 'Make me a snake game in ~/games/snake.html, and test it.')
check('which is far more than the four messages it used to keep', chat.length - at, 18)
check('and what came before it is summarised', at, 4)

const tight = C.cutPoint(chat, 1500)
check('with little room, at least four are kept', chat.length - tight >= C.MIN_KEEP, true)
check('and the kept part does not open on half an exchange', chat[tight].role === 'user', true)
check('too short to be worth it: nothing', C.cutPoint(chat.slice(0, 5), 1500), null)
const pictures = [u('look'), a('ok'), u('again', { images: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), a('seen'), u('and'), a('fine'), u('now'), a('done')]
check('pictures count for what they cost', C.cutPoint(pictures, 4000) >= 3, true)

/* What the summariser is shown. */
const earlier = { role: 'assistant', content: 'OLD MEMORY ' + 'x'.repeat(20000), summary: true }
const t = C.transcriptFor([earlier, u('hi'), out_('result ' + 'y'.repeat(30000)), a('reply')])
check('an earlier summary is labelled as older memory', /### EARLIER SUMMARY/.test(t), true)
check('and is never cut', t.includes('x'.repeat(20000)), true)
check('output handed back is labelled as output, not as the user', /### Output handed back to the assistant/.test(t), true)
check('a huge output keeps its start and its end', /\[… \d+ characters left out …\]/.test(t) && t.includes('result '), true)
const huge = Array.from({ length: 60 }, (_, i) => u(`msg ${i} ` + 'z'.repeat(9000)))
check('a whole transcript is cut to fit the summariser', C.transcriptFor(huge).length <= 90_000, true)
check('pictures are mentioned, not dropped silently', /\[2 pictures not shown\]/.test(C.transcriptFor([u('see', { images: [1, 2] })])), true)

/* What it is asked for. */
const p = C.COMPACT_PROMPT
check("their instructions, quoted word for word", /## The user's instructions[\s\S]*word for word/.test(p), true)
check('what is done and what is not', /\(done\), \(in progress\) or \(not started\)/.test(p), true)
check('paths and numbers exact', /full paths/.test(p) && /never "a file"/.test(p), true)
check('where it stands and the next step', /## Where it stands[\s\S]*next step/.test(p), true)
check('an earlier summary carried into the new one', /EARLIER SUMMARY[\s\S]*only copy/.test(p), true)
check('room to say it: far more than 500 tokens', C.SUMMARY_TOKENS >= 1500, true)

/* How it reads afterwards. */
check('read back as its own memory, not as something said to it', /^YOUR MEMORY OF THE EARLIER PART/.test(C.asMemory('x')), true)
check('and it is told not to claim it cannot remember', /do not say you cannot remember/.test(C.asMemory('x')), true)

/* Wired in. */
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const chatTs = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
check('the panel cuts where cutPoint says, not at four', /cutPoint\(msgs, keepBudget\(/.test(app) && !/const keep = 4/.test(app), true)
check('the summary goes out as memory', /asMemory\(m\.content\)/.test(chatTs), true)
check('main asks with compactRequest, with room for the summary', /compactRequest\(req\.messages\)/.test(main) && /numPredict: SUMMARY_TOKENS/.test(main) && !/numPredict: 500 \}/.test(main.slice(main.indexOf('IPC.chatCompact'), main.indexOf('IPC.chatCompact') + 1500)), true)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\ncompaction keeps the task, their instructions, and where it stood')
