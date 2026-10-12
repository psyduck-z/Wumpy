/**
 * When the conversation gets summarised, and who it is allowed to interrupt.
 *
 * Asked for in one sentence: "if the context is above 90% while it's doing
 * something, stop whatever it's doing, compact, and then continue. Because
 * when it's burst the context, it can't do anything."
 *
 * Three things are worth checking here, and only the first is arithmetic.
 *
 * THE THRESHOLDS have to be ordered. Idle is cheapest and goes first, a send
 * is next, and the mid-task one is last because it costs a request in the
 * middle of a sequence somebody is watching. If those ever cross, the
 * expensive trigger starts firing before the cheap one has had its chance.
 *
 * THE WIRING, because the gap was never in the deciding - it was that three
 * of the four turns in this app are sent by the app itself, and not one of
 * them asked. A desktop plan hands back a dozen turns carrying a dozen
 * screenshots without the user pressing Enter once.
 *
 * THE MIRROR, which is the subtle one. `await compactHistory(); send(text)`
 * runs both halves in a single microtask, and a React re-render is not one of
 * the things that happens in between - so a send after a compaction built its
 * history from the conversation as it was BEFORE the summary, and the whole
 * point of compacting first was lost in silence.
 *
 * Run with: npm run check:pressure
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

async function load(entry, tag) {
  const out = `.pressure-check-${tag}.mjs`
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

const P = await load('src/shared/pressure.ts', 'pressure')

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)

/* ------------------------------------------------------------ the ordering */

check('idle is the cheapest moment, so it goes first', P.IDLE_AT < P.SEND_AT, true)
check('and mid-task is the last resort', P.SEND_AT < P.MIDTASK_AT, true)
check('which is the number that was asked for', P.MIDTASK_AT, 0.9)
check('every turn kind has a threshold', [
  P.thresholdFor('idle'),
  P.thresholdFor('send'),
  P.thresholdFor('auto')
], [0.6, 0.65, 0.9])

/* ------------------------------------------------------------ the decision */

const LIMIT = 32_768
check('an empty conversation needs nothing', P.needsRoom('auto', 0, LIMIT), false)
check('two thirds full is not mid-task business', P.needsRoom('auto', LIMIT * 0.7, LIMIT), false)
check('but it is a send-time matter', P.needsRoom('send', LIMIT * 0.7, LIMIT), true)
check('and an idle one', P.needsRoom('idle', LIMIT * 0.7, LIMIT), true)
check('91% stops a hand-back', P.needsRoom('auto', LIMIT * 0.91, LIMIT), true)
check('exactly 90% does not, so the test is one-sided', P.needsRoom('auto', LIMIT * 0.9, LIMIT), false)
check('over the limit certainly does', P.needsRoom('auto', LIMIT * 2, LIMIT), true)
/* A nonsense limit must not compact on every single turn: the meter falls
   back to an estimate in exactly the moments the counts are missing. */
check('a zero limit decides nothing', P.needsRoom('auto', 5000, 0), false)
check('and neither does a missing one', P.needsRoom('auto', 5000, Number.NaN), false)
check('a negative count is not negative room', P.fullness(-100, LIMIT), 0)

check(
  'what the user is told names the reason',
  P.roomNote(LIMIT * 0.93, LIMIT),
  'The conversation was 93% of the way full, so earlier turns were summarised before carrying on.'
)

/* --------------------------------------------------- counting the pictures */

/*
 * A screenshot was worth nothing to the estimate, which was survivable while
 * one was a rare thing the user asked for. Every step of a desktop plan
 * returns one now: twelve steps is thirteen thousand tokens the meter could
 * not see, in the one loop that fills the window fastest.
 */
check('characters are four to a token', P.estimateTokens(4000), 1000)
check('and a picture costs what one of ours costs', P.estimateTokens(0, 1), P.IMAGE_TOKENS)
check('a dozen of them is most of the window', P.estimateTokens(0, 12) > LIMIT * 0.4, true)
check('they are counted together', P.estimateTokens(4000, 2), 1000 + 2 * P.IMAGE_TOKENS)
check('nothing is nothing', P.estimateTokens(0, 0), 0)

/* ----------------------------------------------- the request that bursts it */

/*
 * The failure the user described - "when it's burst the context, it can't do
 * anything" - is the one where every retry sends the same oversized history
 * and fails the same way. Recognising it is what lets the app summarise and
 * ask again instead of leaving the chat dead.
 *
 * The patterns are narrow on purpose. Treating an ordinary rate limit as a
 * context overflow would rewrite the conversation to fix a problem that was
 * only ever a wait.
 */
check('google naming the input token count', P.tooBig('The input token count (1052341) exceeds the maximum'), true)
check('a per-minute TOKEN limit', P.tooBig('Quota exceeded for metric: tokens per minute'), true)
check('the openai-shaped wording', P.tooBig("This model's maximum context length is 8192 tokens"), true)
check('and a flat refusal of the size', P.tooBig('413 Request Entity Too Large'), true)
check('an ordinary rate limit is NOT this', P.tooBig('429 Too Many Requests: requests per minute'), false)
check('nor a dead key', P.tooBig('API key not valid. Please pass a valid API key.'), false)
check('nor a provider having a bad day', P.tooBig('503 The model is overloaded. Please try again later.'), false)
check('nor nothing at all', P.tooBig(''), false)
check('and it does not care about case', P.tooBig('CONTEXT LENGTH EXCEEDED'), true)

/* -------------------------------------------------------------- the wiring */

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const chat = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
const bar = readFileSync('src/renderer/src/components/StatusBar.tsx', 'utf8')

check('nothing compares a raw fraction any more', /CONTEXT_TOKENS \* 0\.6/.test(app), false)
check('the send path asks the shared rule', /needsRoom\('send'/.test(app), true)
check('and so does the idle one', /needsRoom\('idle'/.test(app), true)
check('and the mid-task one', /needsRoom\('auto'/.test(app), true)

/*
 * All four automatic hand-backs. These are the turns nobody typed, and they
 * are the whole reason this file exists: a command's output, search results,
 * a screenshot, and the report from a plan.
 */
for (const where of [
  'onCommandResult',
  'onSearchResults',
  'onScreenCaptured',
  'onDesktopDone'
]) {
  const at = app.indexOf(`const ${where} = useCallback(`)
  const body = app.slice(at, at + 1400)
  check(`${where} makes room first`, at > 0 && /await makeRoom\(\)/.test(body), true)
}

check('the room is made through a ref, not a forward reference', /makeRoomRef = useRef/.test(app), true)
check('and the ref is filled in after the compaction exists', app.indexOf('makeRoomRef.current = makeRoomNow') > app.indexOf('const compactHistory'), true)
check('the user is told it happened', /roomNote\(used, limit\)/.test(app), true)
check('a request that was too big is retried once', /tooBig\(m\.error\)/.test(app), true)
check('and only once, by id', /retried\.current\.has\(failed\.id\)/.test(app), true)
check('the meter uses the same thresholds it acts on', /MIDTASK_AT \* 100/.test(bar), true)

/* --------------------------------------------------------------- the mirror */

check('replace updates the mirror at once', /messagesRef\.current = next/.test(chat), true)
check('and so does clearing it', /messagesRef\.current = \[\]/.test(chat), true)
check(
  'and it says why, because the reason is not local',
  /runs both halves in one/.test(chat),
  true
)

console.log(`${NL}${count - failed}/${count} pressure checks passed`)
if (failed) process.exit(1)
