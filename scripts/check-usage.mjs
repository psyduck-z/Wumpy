/**
 * Counting what was spent, and the two backends being genuinely two.
 *
 * The accounting matters more than it looks. The free quotas turned out to be
 * the binding constraint and they are invisible until they run out, so a total
 * that is quietly wrong is worse than no total - it would say there is room
 * when there is not. The thinking tokens are the specific trap: they appear in
 * neither of the fields a reasonable person would add up.
 *
 * Run with: node scripts/check-usage.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

async function load(entry, name) {
  const out = join(process.cwd(), `.usage-check-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error'
  })
  return import(pathToFileURL(out).href)
}
const U = await load('src/shared/usage.ts', 'u')
const T = await load('src/shared/assistant.ts', 't')
const P = await load('src/shared/parsefail.ts', 'p')
const C = await load('src/shared/cloud.ts', 'c')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  const shown = JSON.stringify(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${shown?.length > 50 ? `${shown.slice(0, 50)}…` : shown}`
  )
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

/* -------------------------------------------------------------- the counting */

let day = { date: '2026-10-08', models: {} }
day = U.record(day, {
  model: 'gemini-3.5-flash',
  via: 'google',
  promptTokens: 1154,
  completionTokens: 335,
  thinkingTokens: 487,
  generatingMs: 2000
})
day = U.record(day, {
  model: 'gemini-3.5-flash',
  via: 'google',
  promptTokens: 1200,
  completionTokens: 300,
  thinkingTokens: 400,
  generatingMs: 2000
})
day = U.record(day, {
  model: 'phi4-mini:3.8b',
  via: 'local',
  promptTokens: 1080,
  completionTokens: 250,
  generatingMs: 18000
})

const lines = U.summarise(day)
check('one line per model', lines.length, 2)
check('the busiest first', lines[0].model, 'gemini-3.5-flash')
check('turns are counted', lines[0].requests, 2)

// 1154+335+487 + 1200+300+400 = 3876. Adding only prompt and completion would
// say 2989, understating by the 887 that was spent thinking.
check('thinking is in the total', lines[0].tokens, 3876)
check('and is shown separately', lines[0].thinking, 887)
check('local speed is computed', Math.round(lines[1].tokensPerSecond), 14)
check('hosted speed is computed', Math.round(lines[0].tokensPerSecond), 159)

let cached = U.record(
  { date: 'd', models: {} },
  {
    model: 'openai/gpt-oss-120b',
    via: 'groq',
    promptTokens: 7495,
    completionTokens: 100,
    cachedTokens: 4076
  }
)
check('cached tokens come off the bill', U.summarise(cached)[0].tokens, 7495 + 100 - 4076)

check('record does not mutate', Object.keys({ date: 'd', models: {} }.models).length, 0)
check(
  'an error is counted without tokens',
  U.summarise(U.record({ date: 'd', models: {} }, { model: 'x', via: 'google', error: true }))[0]
    .errors,
  1
)
check(
  'a rate limit is counted apart from a failure',
  U.summarise(
    U.record({ date: 'd', models: {} }, { model: 'x', via: 'google', error: true, limited: true })
  )[0].limited,
  1
)
check(
  'no generating time is not a divide by zero',
  U.summarise(
    U.record({ date: 'd', models: {} }, { model: 'x', via: 'local', completionTokens: 10 })
  )[0].tokensPerSecond,
  0
)

/* ------------------------------------------------------------ the allowances */

const burned = { date: 'd', models: {} }
let d38 = burned
for (let i = 0; i < 25; i++)
  d38 = U.record(d38, { model: 'gemini-3.8-flash', via: 'google', promptTokens: 100 })
check('the 25-a-day model reads as spent', U.summarise(d38)[0].usedFraction, 1)
check('and says where the number came from', U.summarise(d38)[0].note.includes('measured'), true)
check(
  'a model with no known cap says nothing false',
  U.summarise(U.record({ date: 'd', models: {} }, { model: 'gemini-3.5-flash', via: 'google' }))[0]
    .usedFraction,
  null
)
check(
  'a local model has no cap at all',
  U.summarise(U.record({ date: 'd', models: {} }, { model: 'phi4-mini:3.8b', via: 'local' }))[0]
    .usedFraction,
  null
)
check(
  'and says so',
  U.summarise(
    U.record({ date: 'd', models: {} }, { model: 'phi4-mini:3.8b', via: 'local' })
  )[0].note.includes('this PC'),
  true
)
check(
  'never over 100%',
  U.summarise(U.record(d38, { model: 'gemini-3.8-flash', via: 'google' }))[0].usedFraction <= 1,
  true
)

check('today is a local date, not UTC', U.todayKey(new Date(2026, 0, 5)), '2026-01-05')
check('and is zero padded', U.todayKey(new Date(2026, 10, 1)), '2026-11-01')

/* ----------------------------------------------------- the one assistant */

/**
 * There were four tiers in two modes on two backends, and each needed its own
 * model, output cap and voice. The measurements ended that: Codestral took
 * every column of the write-a-file benchmark at 0.51s to first token and 511
 * billed tokens a call, so there is nothing left to ration between tiers.
 */
check('there is one model, and it is the measured one', T.DEFAULT_MODEL, 'codestral-latest')
check('it is a model the cloud layer can route', C.providerFor(T.DEFAULT_MODEL), 'mistral')
check(
  'and one the picker offers',
  C.CLOUD_MODELS.some((m) => m.id === T.DEFAULT_MODEL),
  true
)

const a = T.assistantFor(T.DEFAULT_MODEL, true)
check('it may act, because that is the app', a.tools, 'full')
check(
  'and /shell off is what turns that down',
  T.assistantFor(T.DEFAULT_MODEL, false).tools,
  'none'
)
// 384 was a patience budget at 13 tok/s. At 121 it is a truncation, and this
// is the only tier there is.
check('the output cap is sized for a hosted model', a.options.num_predict >= 2000, true)
check('reasoning is off by default', a.thinking, false)

// The prompt that survived is the one written for a capable model. The local
// voice told a 3.8B model to stop talking, which on a capable one is an
// instruction to give the shallow answer.
check(
  'the voice does not cap length verbatim',
  a.systemPrompt.includes('One or two sentences.'),
  false
)
check('nor tell it to stop talking', a.systemPrompt.includes('Answer directly and stop'), false)
check(
  'length follows the question instead',
  a.systemPrompt.includes('Length fits the question'),
  true
)
check('and uncertainty is said out loud', a.systemPrompt.includes('SAY WHAT YOU DO NOT KNOW'), true)

// The worked examples went with the local path: they were measured into
// existence on phi4-mini (5/8 -> 8/8) and are a liability on a model that
// imitates their terse register as readily as their structure.
check('the worked examples are gone', typeof T.shellExamples, 'undefined')

/* --------------------------------------------- who Wumpy is, and how it talks */

/**
 * The prompt had grown by accretion - one shouted section per failure - and
 * had become eight prohibitions with two sentences of identity in front of
 * them. It also said several things twice: "say what the command did" and
 * "if you did something unasked, say so" each appeared in two sections, in
 * nearly the same words.
 *
 * Rewritten as one piece. The duplication paid for the half that was missing:
 * who Wumpy is and how it should sound. That half is not decoration - almost
 * everything about the voice follows from one fact, which is that the panel
 * opens over the top of something the user was already doing.
 */
const flat = T.VOICE_PROMPT.replace(/\s+/g, ' ')

check('it says where it lives', /Windows system tray on this person/.test(flat), true)
// The reason for every brevity rule below it.
check(
  'and why that shapes the answers',
  /came to you mid-task and want to get back to it/.test(flat),
  true
)
// Reworded after the model quoted the old line back as "I can see the
// machine" - it had said "You can see their machine, but only through
// commands they approve", and the qualifier lost to the clause in front
// of it.
check('it cannot see the machine', /You CANNOT see their machine/.test(flat), true)
check(
  'the permission model is stated',
  /propose a command, have\s*them click it, and read what comes back/.test(flat),
  true
)
check('and it says so outright', /Never say you can see the machine/.test(flat), true)
check('and that nothing runs by itself', /Nothing you write runs on its own/.test(flat), true)

check('answer first', /Answer first/.test(flat), true)
check('no preamble', /No preamble/.test(flat), true)
// The specific filler a model reaches for when it has nothing to add yet.
check('no Certainly', /no "Certainly"/.test(flat), true)
check('no repeating the question', /no repeating the question back/.test(flat), true)
check('specific beats generic', /Be specific about THEIR machine/.test(flat), true)
check('because generic is available anywhere', /they can get that anywhere/.test(flat), true)
// It apologised three times in one exchange while repeating the same denial.
check('apologise once at most', /Apologise at most once/.test(flat), true)
check('and only when actually wrong', /only for something you actually got wrong/.test(flat), true)
check('no lecturing', /do not lecture/i.test(flat), true)
check('no unasked-for warnings', /do not warn about things nobody asked about/.test(flat), true)
// The command is on screen before it runs, so it is read by a person.
check('the command is part of the answer', /part of your answer/.test(flat), true)

// Said once each now, not twice.
check(
  '"say what the command DID" appears once',
  (flat.match(/Say what the command DID/g) ?? []).length,
  1
)
check(
  'and the unasked-action rule once',
  (flat.match(/say so plainly and briefly/g) ?? []).length,
  1
)

/* ------------------------------------- doing only what was asked */

/**
 * Asked "is spotify installed", Wumpy opened Spotify.
 *
 * Not a model failure first - a design one. I had merged the check and the
 * launch into one command to save a round trip on "open Spotify", which made
 * every question about an app also start it. The user was mid-task and got a
 * Spotify login window over the top of their work.
 *
 * Then, asked about it, the model said "I did not open Spotify. I checked
 * whether it is installed" - while the output of its own command read
 * LAUNCHED. That second part is the worse one: a wrong action can be undone,
 * and an account of your own actions that the user cannot trust cannot.
 *
 * The commands are separated again, asserted in check-openapp by running the
 * asking one and counting processes. This is the general rule behind it.
 */
// Flattened: these are prose rules, and where a line wraps is not part
// of what they say. Matching the raw text made a reflow look like a
// deleted rule.
const voice = T.VOICE_PROMPT.replace(/\s+/g, ' ')
check('a question is not an instruction', /A QUESTION IS NOT AN INSTRUCTION/.test(voice), true)
check('and the question words are named', /"Is X installed", "do I have X"/.test(voice), true)
check(
  'nothing is started on the back of one',
  /Do not install, launch, open, start, create, change or delete/.test(voice),
  true
)
// The specific trap I built: a command that answers and acts at once.
check(
  'the answering command wins when both exist',
  /use the one that only answers/.test(voice),
  true
)
check('acting unasked is not a bonus', /never a free bonus/.test(voice), true)
// The alternative to doing it: say it, and let them ask.
check('an obvious next step is named, not taken', /Naming is not doing/.test(voice), true)
check('and scope is held to what was asked', /not the three/.test(voice), true)

// Saying what happened, from the output rather than from intent.
check(
  'it reports what the command did',
  /Say what the command DID, not what you meant it to do/.test(voice),
  true
)
check(
  'reading LAUNCHED as having launched',
  /if the output says LAUNCHED, something was launched/i.test(voice),
  true
)
check(
  'denial is called out as the worse failure',
  /Denying it is worse than the thing itself/.test(voice),
  true
)
check('and owning it is required', /say so plainly and briefly/.test(voice), true)

/* ------------------------------------------------- the verification habit */

// The point of this prompt is a model that checks instead of asserting. A
// confident wrong answer about the user's own machine is the worst thing it
// can produce here, because it is indistinguishable from a right one.
const apiPrompt = T.VOICE_PROMPT.replace(/\s+/g, ' ')
check('it is told to check rather than guess', /CHECK, DO NOT GUESS/.test(apiPrompt), true)
check(
  'and reminded it can see command output',
  /propose a command and be given its output/.test(apiPrompt),
  true
)
check('it is told to read what came back', /READ WHAT CAME BACK/.test(apiPrompt), true)
check('and to change its mind when contradicted', /change your mind/.test(apiPrompt), true)
check(
  're-proposing a failed command is called out',
  /near-identical command again/.test(apiPrompt),
  true
)
check(
  'observed is separated from inferred',
  /observed from what you are inferring/.test(apiPrompt),
  true
)
check('inventing a path or version is forbidden', /Never invent a path/.test(apiPrompt), true)
check('"I cannot tell from here" is a real answer', /cannot tell from here/.test(apiPrompt), true)
// The discipline reaches the one voice there is. It was measured as making no
// difference on two saturated tests and kept anyway, because it was asked for
// and because the parts most likely to matter need a harder test to show up.
check('the one voice carries the discipline', /CHECK, DO NOT GUESS/.test(T.VOICE_PROMPT), true)
check('and there is only one voice', typeof T.VOICE_PROMPT, 'string')

// Worked examples existed because a small model imitates. A capable one
// imitates their terse register too, and they cost 110 tokens a turn.
check('the worked examples went with Ollama', typeof T.API_EXAMPLES, 'undefined')

/* ------------------------------------------------- the split is real in code */

const main = readFileSync('src/main/index.ts', 'utf8')
check('there is one model, resolved in one place', /function resolveModel/.test(main), true)
check('and no backend to branch on', /activeBackend/.test(main), false)
check('nor a per-tier model map', /tierModels/.test(main), false)
check(
  'usage is recorded on success',
  /usage\.add\(\{[\s\S]{0,200}promptTokens: stats\.promptTokens/.test(main),
  true
)
check('and on failure', /usage\.add\(\{[\s\S]{0,160}error: true/.test(main), true)
check(
  'the default model is the measured one',
  readFileSync('src/shared/defaults.ts', 'utf8').includes('model: DEFAULT_MODEL'),
  true
)
check(
  'no prompt text is stored with the counts',
  /content|text|prompt:/.test(
    readFileSync('src/shared/usage.ts', 'utf8')
      .split('export interface ModelUsage')[1]
      .split('}')[0]
  ),
  false
)

/* ----------------------------------------------- falling back, out loud */

// The point of having two backends is knowing which one answered. A silent
// downgrade to a 3.8B model would make the API side untrustworthy in exactly
// the way that matters most, so the announcement is as much a requirement as
// the fallback itself, and is checked as one.
const cloudSrc = readFileSync('src/main/cloud.ts', 'utf8')
const defaultsSrc = readFileSync('src/shared/defaults.ts', 'utf8')

check('a limit is answerable elsewhere', /kind: 'limit', elsewhere: true/.test(cloudSrc), true)
check('a rejected key is not', /kind: 'auth',[\s\S]{0,40}elsewhere: false/.test(cloudSrc), true)
check("a provider's own 5xx is", /elsewhere:[^\n]*res\.status >= 500/.test(cloudSrc), true)
// A model the provider will not generate with at all - 400 or 404, which
// three listed Gemini models answer - is worth stepping away from too.
check('and so is a model that cannot generate', cloudSrc.includes('const unusableModel ='), true)
check('a dropped connection is', /kind: 'network', elsewhere: true/.test(cloudSrc), true)

check('the fallback announces itself', main.includes('answering on ${fallback} instead'), true)
check(
  'naming both models',
  /\$\{model\} \$\{fallbackWhy\}[\s\S]{0,40}\$\{fallback\}/.test(main),
  true
)
check(
  'it fires only when nothing was streamed',
  /failure\?\.elsewhere &&[\s\S]{0,80}!streamed/.test(main),
  true
)
// Sideways, not down. The daily cap is per model, so when one is out another
// on the same key usually is not - measured, in the same minute. With the
// local path gone this is the only step left, which makes it the whole of the
// fallback rather than the first half of it.
check(
  'and only to a sibling the key can reach',
  /siblingModel\(on, spentToday\)[\s\S]{0,120}cloud\.ready\(sibling\)\.ok/.test(main),
  true
)
check('there is nothing local to step down to', /backgroundModel\(req/.test(main), false)
check('it can be switched off', /settings\.get\('apiFallback'\)/.test(main), true)
check('and is on by default', defaultsSrc.includes('apiFallback: true'), true)
check('the second attempt is counted too', (main.match(/usage\.add\(\{/g) ?? []).length >= 2, true)

/* --------------------------------- learning a cap by walking into it */

// The published caps contradict each other and reality - one source had
// gemini-3.8-flash at 1500 requests a day, another at 20, and it ran out
// after about 25 here. The figure this machine observed is the only one worth
// showing, so it is recorded the moment a model says it is out.
let learn = { date: 'd', models: {} }
for (let i = 0; i < 12; i++) learn = U.record(learn, { model: 'gemini-9-x', via: 'google' })
learn = U.record(learn, {
  model: 'gemini-9-x',
  via: 'google',
  error: true,
  limited: true,
  exhausted: true
})
const learned = U.summarise(learn)[0]
check('the cap is the count when it ran out', learned.exhaustedAt, 12)
check('so the day reads as spent', learned.usedFraction, 1)
check('and the note says where that came from', learned.note.includes('measured here'), true)
check('naming the count', learned.note.includes('12'), true)

// Hitting the same wall again must not move the figure.
const again = U.record(learn, { model: 'gemini-9-x', via: 'google', error: true, exhausted: true })
check('a second refusal does not change it', U.summarise(again)[0].exhaustedAt, 12)

// A throttle is not a spent day; only the stronger signal teaches anything.
const throttled = U.record(
  { date: 'd', models: {} },
  { model: 'm', via: 'google', error: true, limited: true }
)
check('a plain rate limit teaches nothing', U.summarise(throttled)[0].exhaustedAt, undefined)
check('and leaves the cap unknown', U.summarise(throttled)[0].usedFraction, null)

// What was seen here beats what was published.
let beats = { date: 'd', models: {} }
for (let i = 0; i < 8; i++) beats = U.record(beats, { model: 'gemini-3.8-flash', via: 'google' })
beats = U.record(beats, { model: 'gemini-3.8-flash', via: 'google', error: true, exhausted: true })
check('an observed cap overrides the table', U.summarise(beats)[0].exhaustedAt, 8)

/* ------------------------- a stopped command has not finished */

// Observed: an install was cut off on the time limit and the model answered
// "I have successfully installed the official Spotify app" while winget was
// still working. The closing line said the command was done, whatever had
// actually happened to it.
/**
 * Asserted against what the function produces, not against the source text
 * of whatever file happens to hold it. These five checks were matching
 * strings in App.tsx and broke the moment the report moved into shared -
 * where it had to go, so bench-ceiling could grade the second turn against
 * the real report rather than a copy of it. The behaviour never changed.
 */
const result = (over) => ({
  command: 'winget install --id Spotify.Spotify -e',
  shell: 'powershell',
  cwd: 'C:/Users/me',
  stdout: 'Found Spotify [Spotify.Spotify]',
  stderr: '',
  exitCode: 0,
  durationMs: 600_000,
  timedOut: false,
  truncated: false,
  readOnly: false,
  ...over
})

const killed = P.commandFeedback(result({ timedOut: true, exitCode: -1 }))
check(
  'a killed command is reported as stopped',
  killed.text.includes('Wumpy STOPPED that command'),
  true
)
check(
  'and said to be possibly still running',
  killed.text.includes('still be running in the background'),
  true
)
check(
  'with success and failure both forbidden',
  /Do NOT say it succeeded, and do not say it failed/.test(killed.text),
  true
)
// The ordinary closing line belongs only to a command that really finished.
const finished = P.commandFeedback(result({}))
check(
  '"that command is done" is only for one that is',
  finished.text.includes('That command is done') && !killed.text.includes('That command is done'),
  true
)
/**
 * The quiet path - a change that succeeded silently, answered without
 * spending a model turn - must never swallow a timeout. "Succeeded, no
 * output" about something still running is the worst sentence available.
 */
const quiet = P.commandFeedback(result({ stdout: '', stderr: '' }))
const quietTimeout = P.commandFeedback(result({ stdout: '', stderr: '', timedOut: true }))
check('the quiet path exists for a silent change', quiet.kind, 'notice')
check('the quiet path excludes a timeout', quietTimeout.kind, 'report')
// And a read that printed nothing is an answer, so it always goes back.
const quietRead = P.commandFeedback(result({ stdout: '', stderr: '', readOnly: true }))
check('a silent read still reaches the model', quietRead.kind, 'report')

// Two minutes killed real installs; nothing is blocked while one runs.
check(
  'the ceiling allows an install to finish',
  readFileSync('src/main/shell.ts', 'utf8').includes('TIMEOUT_MS = 600_000'),
  true
)
check(
  'and the model is told an install is not done on return',
  T.OPEN_PROMPT.includes('INSTALLING SOMETHING IS NOT FINISHED'),
  true
)

console.log(failures ? `\n${failures} usage checks FAILED` : '\nall usage checks')
process.exitCode = failures ? 1 : 0
