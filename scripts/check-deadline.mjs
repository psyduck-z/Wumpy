/**
 * Checks reading a stop time out of what the user said (src/shared/deadline.ts).
 *
 * Two ways to get it wrong, and both matter: a limit that is missed means
 * Wumpy runs on past the time it was told, and a limit read into an ordinary
 * sentence ("the meeting is at 10:30") stops work nobody asked to stop.
 *
 * Run with: node scripts/check-deadline.mjs
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.deadline-check.mjs')
await build({ entryPoints: ['src/shared/deadline.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const { deadlineIn, nextClock, spanText } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what.padEnd(64)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`     ${''.padEnd(64)} expected ${JSON.stringify(want)}`)
}

// Friday 20 November 2026, 16:10 local.
const now = new Date(2026, 10, 20, 16, 10).getTime()
const at = (h, m, day = 20) => new Date(2026, 10, day, h, m).getTime()
const when = (text, base = now) => {
  const d = deadlineIn(text, base)
  return d === null ? null : d.kind === 'clear' ? 'clear' : new Date(d.at).toTimeString().slice(0, 5) + (new Date(d.at).getDate() !== 20 ? ' +1' : '')
}
const MIN = 60_000

/* ---------------------------------------------------------- what they said */

/* Sentences with a time in them that are not a limit on the work. Each of
   these used to set a stop time, and Wumpy would have halted at it. */
for (const said of [
  'I worked until 5pm yesterday, can you summarise my notes',
  'the shop runs until 10:30 tonight, find me its address',
  'the meeting runs till 3pm',
  'fix the login bug, the build ran fine until 11:45',
  'the script loops until 10:30 and then exits, why?',
  'remind me to stop at 5pm',
  'what time does the gym stop at 10pm on sundays',
  'it took no more than 20 minutes',
  'I keep forgetting things for an hour after waking',
  'I do not work past 6pm, so plan my day'
]) check(`not a limit: ${said.slice(0, 50)}`, when(said), null)
check('said to it: please keep going until 10:30', when('please keep going until 10:30'), '22:30')
check('said to it: can you work on it for half an hour', when('can you work on it for half an hour'), '16:40')
check('said to it: spend no more than 20 minutes', when('spend no more than 20 minutes on it'), '16:30')
check('said to it: I want you to stop at 5pm', when('I want you to stop at 5pm'), '17:00')
check('the request itself', when('if I say do not continue past 10:30, it stops'), '22:30')
check("don't go past 10:30", when("Don't go past 10:30 ok?"), '22:30')
check('curly apostrophe', when('don’t continue past 10:30'), '22:30')
check('stop at 10:20', when('stop at 10:20 ok? until then, keep crunching'), '22:20')
check('in the morning that is the morning', when('stop at 10:20', at(9, 0)), '10:20')
check('pm says which', when('stop by 10:30pm'), '22:30')
check('am says which, tomorrow', when('stop by 10:30 am'), '10:30 +1')
check('24-hour clock', when('finish by 17:45'), '17:45')
check("o'clock", when("stop at 6 o'clock"), '18:00')
check('keep crunching until', when('keep crunching and refining until 16:40, then report'), '16:40')
check('work till', when('work on it till 5pm'), '17:00')
check('wrap up by', when('wrap it up by 4:55'), '16:55')
check('dotted time', when('stop at 10.30'), '22:30')
check('stop after you hit 2 hours', when('Stop after you hit 2 hours.'), '18:10')
check('stop after 2 hours', when('stop after 2 hours'), '18:10')
check('keep going for half an hour', when('keep on crunching and fixing this for like half an hour'), '16:40')
check('for an hour and a half', when('keep working for an hour and a half'), '17:40')
check('2.5 hours', when('keep refining for 2.5 hours'), '18:40')
check('2 and a half hours', when('crunch for 2 and a half hours'), '18:40')
check('20 minutes', when('stop in 20 minutes'), '16:30')
check('no more than 45 min', when('spend no more than 45 min on it'), '16:55')
check('time limit', when('time limit of 30 minutes'), '16:40')
check('you have an hour', when("you've got an hour"), '17:10')
check('the last one said wins', when('stop at 10, no wait, stop at 10:45'), '22:45')

/* ------------------------------------------------------ and what they didn't */

check('a fact about a meeting', when('the meeting is at 10:30, remind me'), null)
check('a timer is a different job', when('set a timer for 5 minutes'), null)
check('wait for is not a limit', when('wait for 10 minutes then check'), null)
check('a bare number is not a time', when('stop at 3'), null)
check('a version is not a time', when('update it to 10.30 of the library'), null)
check('a game that ends', when('make the game end at 10:30 on the clock'), null)
check('a duration is not a clock', when('keep going until 2 hours have passed'), null)
check('the fix for a bug', when('fix the bug for me in a minute'), null)

/* ----------------------------------------------------------- taking it back */

check('no time limit', when('no time limit, just keep going'), 'clear')
check('forget the deadline', when('forget the deadline'), 'clear')
check("don't stop at 10:30", when("actually don't stop at 10:30"), 'clear')
check('a new limit after clearing', when('ignore the time limit. stop at 11pm'), '23:00')

/* -------------------------------------------------------------- the clock */

check('10:30 at 16:10 is tonight', nextClock(now, 10, 30) === at(22, 30), true)
check('4:20 at 16:10 is in ten minutes', nextClock(now, 4, 20) === at(16, 20), true)
check('4:00 at 16:10 is 4 tomorrow morning', nextClock(now, 4, 0) === at(4, 0, 21), true)
check('25:00 is no time', nextClock(now, 25, 0), null)
check('more than a day away is not now', deadlineIn('keep going for 30 hours', now), null)

check('span text', [spanText(25 * MIN), spanText(65 * MIN), spanText(360 * MIN)], ['25 minutes', '1 hour 5 minutes', '6 hours'])

/* ------------------------------------------------------------ the wiring */

import { readFileSync } from 'node:fs'
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const chat = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
check('what the user types is read for a stop time', /heardDeadline\(text\)/.test(app), true)
check('and anything they say lifts a stop', /deadline\.halt\(false\)/.test(app), true)
check('when it comes, the answer stops', /deadline\.halt\(true\)[\s\S]{0,200}chatRef\.current\.stop\(\)/.test(app), true)
check('and so do the agents', /agents\.stop\(a\.id\)/.test(app), true)
check('no hand-back goes out after it', /automatic && deadline\.halted\(\)/.test(chat), true)
check('the model is told the time it has', /deadlineFact\(stopAt/.test(main), true)

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} deadline checks`)
process.exit(failed === 0 ? 0 : 1)
