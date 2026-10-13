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

/* --------------------------------------------- the pictures that go out */

/*
 * Every image in the conversation used to be attached to every request. The
 * cost is quadratic: ten steps of a desktop plan sends fifty-five pictures,
 * about 60,000 tokens of photographs, for ten pictures' worth of news - on a
 * tier metered per minute and per day.
 */
{
  const shot = [{ dataUrl: 'x' }]
  const convo = [
    { role: 'user', content: 'look', images: shot },
    { role: 'assistant', content: 'a plan' },
    { role: 'user', content: 'report one', images: shot },
    { role: 'assistant', content: 'another plan' },
    { role: 'user', content: 'report two', images: shot }
  ]
  const out = P.trimPictures(convo)
  check(
    'only the newest pictures are attached',
    out.map((m) => Boolean(m.images?.length)),
    [false, false, true, false, true]
  )
  check('two is the default, because before-and-after is the useful pair', P.KEEP_PICTURES, 2)
  check('a dropped picture is admitted, not silently gone', /no longer being sent/.test(out[0].content), true)
  check('and the words that were with it are kept', out[0].content.startsWith('look'), true)
  check('the attachment is actually removed', 'images' in out[0], false)
  check('the ones kept are untouched', out[4], convo[4])
  check('a conversation of words is returned as it was', P.trimPictures([{ role: 'user', content: 'hi' }])[0].content, 'hi')
  check('keeping none drops them all', P.trimPictures(convo, 0).some((m) => m.images?.length), false)
  check('and nothing is mutated', convo[0].images?.length, 1)
}

/* ------------------------------- the control list, which is the same bug */

/*
 * Every screenshot carries up to sixty named controls written into the
 * message body - about 580 tokens - and those were never trimmed, so ten
 * steps of a desktop plan re-sent 5,790 tokens of them on every turn.
 *
 * Worse than the cost: each one says the controls are on screen RIGHT NOW,
 * which is true only of the newest. The model was being handed nine stale
 * descriptions of a window, every one asserting it was current, while the
 * pictures they described had already been dropped for being out of date.
 */
{
  const list =
    'These 60 controls are on screen right now in "Inbox", with their' +
    NL +
    'real centres. PRESS one by name rather than guessing a pixel:' +
    NL +
    Array.from({ length: 60 }, (_, i) => `  Button: "control ${i}"`).join(NL)
  const body = `DONE step 1: CLICK ok at=735,465${NL}${list}`

  check('a list is found and cut', P.withoutControls(body).cut, true)
  check('and what came before it is kept', P.withoutControls(body).text, 'DONE step 1: CLICK ok at=735,465')
  check('a message with no list is untouched', P.withoutControls('just a reply').cut, false)
  check('and comes back unchanged', P.withoutControls('just a reply').text, 'just a reply')

  const convo = Array.from({ length: 10 }, () => ({
    role: 'user',
    content: body,
    images: [{ kind: 'image' }]
  }))
  const out = P.trimPictures(convo)
  const still = out.filter((m) => /controls are on screen/.test(m.content)).length
  check('only the newest lists are still sent', still, P.KEEP_PICTURES)
  check('the stale ones say they went', /no longer being sent: the window has changed/.test(out[0].content), true)
  check('with the step report left intact', out[0].content.startsWith('DONE step 1: CLICK ok'), true)
  const before = convo.map((m) => m.content).join('').length
  const after = out.map((m) => m.content).join('').length
  /* 2,506 on this fixture, whose control names are shorter than real ones.
     With names of the length Gmail actually reports it measured 3,756. */
  check('and it is thousands of tokens', Math.ceil((before - after) / 4) > 2000, true)
  /* The newest two keep everything, because those are the ones being acted on. */
  check('the newest keeps its list', /controls are on screen/.test(out[9].content), true)
  check('and is not annotated', /no longer being sent/.test(out[9].content), false)
}

/*
 * The cut takes everything from the list's first line to the END of the
 * message, which is exact only while the list is written last. It is, at all
 * three places that write one - so this fails the day something is appended
 * after it, rather than silently throwing that something away.
 */
{
  const lines = readFileSync('src/renderer/src/App.tsx', 'utf8').split(NL)
  const calls = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('namedControls(') && !line.includes('function namedControls'))
  check('every control list is written', calls.length, 3)
  const trailing = calls.filter(({ i }) => {
    const next = lines.slice(i + 1).find((l) => l.trim())
    return (next ?? '').trim().startsWith(']')
  })
  check('and every one of them is written last', trailing.length, calls.length)
}

check('main trims before it sends', /trimPictures\(/.test(readFileSync('src/main/index.ts', 'utf8')), true)
/* The transcript keeps them: it is the user's record of what was sent on
   their behalf, and that must not be edited to save tokens. */
check('the renderer does not trim its own transcript', /trimPictures/.test(app), false)
/*
 * The meter counts only what goes out, which is now asserted on the function
 * rather than on the expression: the cap moved into estimateWithFiles when an
 * attachment stopped always being a picture. A grep for the old
 * `Math.min(KEEP_PICTURES` passed for a week and then failed on a refactor
 * that changed nothing about the behaviour.
 */
check('but the meter counts only what goes out', /estimateWithFiles\(chars, files, KEEP_PICTURES\)/.test(app), true)
{
  const picture = (n) => ({ kind: 'image', bytes: n })
  const two = P.estimateWithFiles(0, [picture(1), picture(2)])
  check('two pictures cost two', two, P.IMAGE_TOKENS * 2)
  check('and five still cost two', P.estimateWithFiles(0, [1, 2, 3, 4, 5].map(picture)), two)
  /* Text is not a picture: it is never dropped and never charged as one. */
  check(
    'a text file is charged by its length',
    P.estimateWithFiles(0, [{ kind: 'text', bytes: 1, text: 'x'.repeat(4000) }]),
    1000
  )
  check(
    'and is counted however old it is',
    P.estimateWithFiles(0, [
      { kind: 'text', bytes: 1, text: 'x'.repeat(4000) },
      picture(1),
      picture(2),
      picture(3)
    ]),
    1000 + P.IMAGE_TOKENS * 2
  )
}

/* ------------------------------------------ the instructions, which are not free */

/*
 * Thirteen thousand tokens go out ahead of every turn. The estimate counted
 * them as nothing, so immediately after a compaction the meter read about 1%
 * when the truth was 41% - and compaction cannot shrink them, which is the
 * thing a user would most want to know from that number.
 *
 * Measured against the same assembly the main process sends, so the two
 * cannot drift: the sections and their order live in @shared/assistant now.
 */
const A = await load('src/shared/assistant.ts', 'assistant')
{
  const full = { scope: 'full', search: true, screen: true, browser: true, quota: true }
  const bare = { scope: 'none', search: false, screen: false, browser: false, quota: false }
  check('the preamble is measured, not guessed', A.preambleTokens(full), Math.ceil(A.assemblePrompt(full).length / 4))
  check('and for a reduced one too', A.preambleTokens(bare), Math.ceil(A.assemblePrompt(bare).length / 4))
  check('the full preamble is most of a 32k window', A.preambleTokens(full) > 10_000, true)
  check('turning the screen off is worth real tokens', A.preambleTokens(full) - A.preambleTokens(bare) > 4000, true)
  check('the desktop section only ships with both', A.assemblePrompt({ ...full, browser: false }).includes('A CLICK IS NOT AIM'), false)
  check('and with both, it does', A.assemblePrompt(full).includes('A CLICK IS NOT AIM'), true)
  check('read-only shell gets its own section', A.assemblePrompt({ ...full, scope: 'read' }).includes('may only READ') || A.assemblePrompt({ ...full, scope: 'read' }).includes('only look'), true)
}
check('main no longer assembles its own', /assemblePrompt\(promptShape\(/.test(readFileSync('src/main/index.ts', 'utf8')), true)
check('and the meter adds it to the estimate', /preamble \+ estimateWithFiles/.test(app), true)
check('the tooltip says what cannot be compacted', /Instructions, re-sent every turn/.test(bar), true)

/* ------------------------------ what a summary cannot fix, it must not try */

const LIMIT2 = 32_768
/*
 * The instructions are 13,300 tokens of a 32,768 budget and a summary cannot
 * touch them. Without a floor, a chat holding two short messages sits above
 * the send threshold with nothing to compact - so it compacts, is still over,
 * sends, and compacts again: one request per turn, buying nothing.
 */
check(
  'a conversation that is almost all preamble is not compacted',
  P.needsRoom('send', 22_000, LIMIT2, 21_000),
  false
)
check(
  'but a real conversation over the line is',
  P.needsRoom('send', 22_000, LIMIT2, 13_300),
  true
)
check('the floor is a handful of exchanges', P.MIN_COMPACTABLE >= 1000 && P.MIN_COMPACTABLE <= 4000, true)
check('and without a figure for them, it behaves as before', P.needsRoom('send', 22_000, LIMIT2), true)
check('under the threshold is still under it', P.needsRoom('send', 1000, LIMIT2, 0), false)

check('the cooldown is a minute', P.COMPACT_COOLDOWN_MS, 60_000)
check('the hand-back honours it', /Date\.now\(\) - lastCompact\.current < COMPACT_COOLDOWN_MS/.test(app), true)
check('and a compaction records when it ran', /lastCompact\.current = Date\.now\(\)/.test(app), true)
check('all three triggers pass the instructions through', (app.match(/usage\.instructions|instructions\)/g) ?? []).length >= 3, true)

console.log(`${NL}${count - failed}/${count} pressure checks passed`)
if (failed) process.exit(1)
