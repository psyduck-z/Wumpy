/**
 * The time each message was sent, and the rule against answering a machine
 * question from a check of something else. See src/shared/sent.ts.
 *
 * "when i send messages, allow it to note the TIME i sent it, so, after
 * refining the guidlines to ALWAYS verify and take NO shortcuts, it can tell
 * when i was away, adapt, etc"
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.TZ = 'Europe/London'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(62)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

async function load(entry, name) {
  const out = join(process.cwd(), `.sent-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    alias: { '@shared': './src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const read = (path) => readFileSync(path, 'utf8')

const S = await load('src/shared/sent.ts', 'sent')
const N = await load('src/shared/needs.ts', 'needs')

/* ------------------------------------------------------------ the stamp */

const at = (iso) => new Date(iso).getTime()
check('a morning message', S.sentStamp(at('2026-11-19T07:26:00Z'), null), '[sent Thu 19 Nov, 7:26 am]')
check('an evening one', S.sentStamp(at('2026-11-18T23:05:00Z'), null), '[sent Wed 18 Nov, 11:05 pm]')
check('noon is pm, midnight is am', [S.sentStamp(at('2026-11-19T12:00:00Z'), null), S.sentStamp(at('2026-11-19T00:04:00Z'), null)], [
  '[sent Thu 19 Nov, 12:00 pm]',
  '[sent Thu 19 Nov, 12:04 am]'
])
check(
  'a few minutes on is one sitting, and says nothing',
  S.sentStamp(at('2026-11-19T07:30:00Z'), at('2026-11-19T07:26:00Z')),
  '[sent Thu 19 Nov, 7:30 am]'
)
check(
  'a night away says how long',
  S.sentStamp(at('2026-11-19T07:26:00Z'), at('2026-11-18T22:10:00Z')),
  '[sent Thu 19 Nov, 7:26 am - 9 hours after their last message]'
)
check('gaps in words', [25, 59, 60, 100, 600, 2870, 4320].map((m) => S.gapWords(m * 60_000)), [
  '25 minutes',
  '59 minutes',
  'an hour',
  '2 hours',
  '10 hours',
  '2 days',
  '3 days'
])
check('every stamp is found by STAMP', S.STAMP.test(S.sentStamp(at('2026-11-19T07:26:00Z'), at('2026-11-16T07:00:00Z'))), true)

/* ------------------------------------------------- stamped on the wire */

const chat = [
  { role: 'user', content: 'am i plugged in', sentAt: at('2026-11-18T22:10:00Z') },
  { role: 'assistant', content: 'Yes.' },
  { role: 'user', content: 'Output of the command: Not charging' },
  { role: 'system', content: 'Earlier in this conversation: ...' },
  { role: 'user', content: 'am i charging now', sentAt: at('2026-11-19T07:26:00Z') }
]
const wire = S.withSentTimes(chat)
check('their messages carry the time', wire.map((m) => m.content.slice(0, 40)), [
  '[sent Wed 18 Nov, 10:10 pm] am i plugged',
  'Yes.',
  'Output of the command: Not charging',
  'Earlier in this conversation: ...',
  '[sent Thu 19 Nov, 7:26 am - 9 hours afte'
])
check('what they typed is kept', chat[0].content, 'am i plugged in')
check('the same history stamps the same each turn', JSON.stringify(S.withSentTimes(chat)) === JSON.stringify(wire), true)

/* A stamp must not be taken for a request to open, click or install. */
let fired = 0
for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  for (const month of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
    for (const gap of ['', ' - 9 hours after their last message', ' - 3 days after their last message'])
      if (N.needsFor([{ role: 'user', content: `[sent ${day} 9 ${month}, 7:26 am${gap}] hi` }]).length) fired++
check('no stamp switches on a capability', fired, 0)

/* A stamp copied into an answer is neither shown nor said. */
const K = await load('src/shared/kept.ts', 'kept')
const T = await load('src/shared/spoken.ts', 'spoken')
check('a copied stamp is not shown', K.withoutKept('[sent Thu 19 Nov, 7:26 am] No - it is not charging.'), 'No - it is not charging.')
check('nor after a keep note', K.withoutKept('<keep>word: PLANET</keep>[sent Thu 19 Nov, 7:26 am] Guess a letter.'), 'Guess a letter.')
check('nor said', T.speakable('[sent Thu 19 Nov, 7:26 am - 9 hours after their last message] Welcome back.'), 'Welcome back.')
check('a bracket that is not a stamp is left alone', K.withoutKept('[1] First, the battery.'), '[1] First, the battery.')

/* ------------------------------------------------------------ the wiring */

const main = read('src/main/index.ts')
const chatHook = read('src/renderer/src/hooks/useChat.ts')
check('the renderer sends when each of theirs was sent', /m\.role === 'user' && !m\.automatic \? \{ sentAt: m\.createdAt \}/.test(chatHook), true)
check('main stamps them on the way out', /withSentTimes\(req\.messages\)\.map\(\(m\) => \(\{ role: m\.role, content: m\.content, images: m\.images \}\)\)/.test(main), true)
check('and the model is told what a stamp and a gap mean', /starts with \[sent <day>, <time>\], added by the app/.test(main) && /Never write a stamp yourself/.test(main) && /check again rather than/.test(main), true)

/* ---------------------------------------------------- verify, no shortcuts */

const A = read('src/shared/assistant.ts')
const lean = read('src/shared/lean.ts')
check('one check does not answer the next question', /a check of something next to it: plugged in is not charging/.test(A), true)
check('doubted, it checks rather than repeating itself', /or doubted, check; never just restate/.test(A), true)
check('the short prompt says it too', /plugged',\s+'in is not charging\. Asked again or doubted, check; never just restate\./.test(lean), true)

console.log(failed ? `\n${failed} FAILED of the sent-time checks` : '\nall sent-time checks correct')
process.exit(failed ? 1 : 0)
