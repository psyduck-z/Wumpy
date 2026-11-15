/**
 * Self-reflection (src/shared/reflect.ts and the key it reviews on): what the
 * mentor is shown, how its verdict is read, what the worker is told, and that
 * the review goes out on the other key when there is one.
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.reflect-check-${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const R = await load('src/shared/reflect.ts', 'reflect')
const P = await load('src/shared/pool.ts', 'pool')

let failed = 0
let count = 0
function check(name, actual, expected) {
  count++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(actual)}`)
}

/* The verdict, read leniently but never generously. */
check('ACCEPT is a pass', R.parseReview('VERDICT: ACCEPT\nNOTES: It does what was asked.')?.verdict, 'accept')
check('with its reason', R.parseReview('VERDICT: ACCEPT\nNOTES: It does what was asked.')?.notes, 'It does what was asked.')
check('REVISE is not', R.parseReview('VERDICT: REVISE\nNOTES:\n1. The loop is off by one.')?.verdict, 'revise')
check('and keeps the list', R.parseReview('VERDICT: REVISE\nNOTES:\n1. The loop is off by one.')?.notes, '1. The loop is off by one.')
check('bold and case do not matter', R.parseReview('**Verdict:** accept\n**Notes:** fine')?.verdict, 'accept')
check('the verdict on the next line', R.parseReview('VERDICT:\nREVISE\nNOTES: fix it')?.verdict, 'revise')
check('no label but a bare ACCEPT', R.parseReview('ACCEPT - all good')?.verdict, 'accept')
check('anything unclear is a REVISE', R.parseReview('Looks mostly fine, but the test is missing.')?.verdict, 'revise')
check('"not acceptable" is not ACCEPT', R.parseReview('This is not acceptable yet.')?.verdict, 'revise')
check('nothing at all is no review', R.parseReview('   '), null)

/* Where the task starts, and whether there is anything to review. */
const task = [
  { role: 'user', content: 'old question' },
  { role: 'assistant', content: 'old answer' },
  { role: 'user', content: 'Write a function that adds two numbers.' },
  { role: 'assistant', content: 'Here it is: add(a, b).' },
  { role: 'user', content: 'output of the command', automatic: true },
  { role: 'assistant', content: 'It ran and printed 3.' },
  { role: 'assistant', content: 'Mentor reviewing…', local: true }
]
check('the task is the newest thing the user wrote', R.taskStart(task), 2)
check('a finished answer can be reviewed', R.reviewable(task), true)
check('an answer that failed cannot', R.reviewable([...task.slice(0, 6), { role: 'assistant', content: '', error: 'x' }]), false)
check('nor a task with no answer yet', R.reviewable(task.slice(0, 3)), false)
check('nor nothing', R.reviewable([]), false)
const shown = R.mentorTranscript(task)
check('the mentor sees the task', shown.includes('### USER\nWrite a function'), true)
check('and the work, labelled', shown.includes('### WORKER\nIt ran and printed 3.'), true)
check('and what the app handed back', shown.includes('### APP (automatic'), true)
check('but not earlier tasks', shown.includes('old question'), false)
check('nor the app’s own notes', shown.includes('Mentor reviewing'), false)
const huge = [{ role: 'user', content: 'go' }, ...Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: `step ${i} `.repeat(400) }))]
const cut = R.mentorTranscript(huge, 24000)
check('a long task is cut to fit', cut.length < 26000, true)
check('keeping where it started', cut.startsWith('### USER\ngo'), true)
check('and where it ended', cut.includes('step 29'), true)

/* What the worker is told. */
const back = R.handBack('1. Handle negative numbers.', 1, 3)
check('it says it is automatic', back.startsWith('[Automatic: self-reflection, review 1 of 3.'), true)
check('it carries the notes', back.includes('1. Handle negative numbers.'), true)
check('and asks for the whole answer again', /complete, final/.test(back), true)
check('rounds are kept sensible', [R.clampRounds(0), R.clampRounds(3), R.clampRounds(50), R.clampRounds(NaN)], [1, 3, 8, 3])

/* The other key. */
const pool = P.emptyPool('2026-11-15', 2)
check('without a preference, the usual choice', P.chooseKey(pool, 'm', Date.now(), 0), 0)
check('told to avoid key 0, key 1', P.chooseKey(pool, 'm', Date.now(), 0, 0), 1)
check('told to avoid key 1, key 0', P.chooseKey(pool, 'm', Date.now(), 0, 1), 0)
const one = P.emptyPool('2026-11-15', 1)
check('with one key, that key anyway', P.chooseKey(one, 'm', Date.now(), 0, 0), 0)
const resting = P.emptyPool('2026-11-15', 2)
resting.spend[1] = { ...resting.spend[1], restUntil: Date.now() + 60_000 }
check('the other resting: same key beats no review', P.chooseKey(resting, 'm', Date.now(), 0, 0), 0)

/* Wiring, by shape: the mentor asks for the other key; the loop waits for
   the task to finish and counts as running work while it reviews. */
const main = readFileSync('src/main/index.ts', 'utf8')
const hook = readFileSync('src/renderer/src/hooks/useReflect.ts', 'utf8')
check('the review asks for the other key', /otherKey: true/.test(main), true)
check('and uses the mentor prompt', /MENTOR_PROMPT/.test(main), true)
check('the loop waits for approvals and commands', /pendingCount\(\) > 0 \|\| runningCount\(\) > 0/.test(hook), true)
check('a review in flight counts as running', /startedRunning\(\)/.test(hook), true)
check('a new task drops a stale review', /a new task started/.test(hook), true)

console.log(`\n${count - failed}/${count} self-reflection checks correct`)
process.exit(failed === 0 ? 0 : 1)
