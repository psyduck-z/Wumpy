/**
 * Checks the line under the last answer (src/shared/turnend.ts): grey only
 * when nothing is left, yellow while something is still working, red when
 * the turn ended without doing it - and the wiring that keeps a quick
 * command from flickering the card or the line.
 *
 * Run with: node scripts/check-turnend.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.turnend-check.mjs')
await build({ entryPoints: ['src/shared/turnend.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const { turnEnd } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const check = (what, ok, got) => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what.padEnd(60)} ${got === undefined ? '' : JSON.stringify(got)}`)
}

const none = { agents: [], failedAgents: [], running: 0, waiting: 0, error: false, cutOff: false }
const t = (more) => turnEnd({ ...none, ...more })

check('nothing left: done, no bubble', t({}).tone === 'done' && t({}).label === '', t({}))
check('an agent building Tetris: yellow', t({ agents: ['Tetris'] }).tone === 'going', t({ agents: ['Tetris'] }).label)
check('the agent is named in the hover', t({ agents: ['Tetris'] }).detail.includes('Tetris'))
check('two agents: counted', t({ agents: ['a', 'b'] }).label.includes('2 agents'), t({ agents: ['a', 'b'] }).label)
check('a command running: yellow', t({ running: 1 }).tone === 'going', t({ running: 1 }).label)
check('a command waiting for a click: yellow', t({ waiting: 1 }).tone === 'going', t({ waiting: 1 }).label)
check('an error: red', t({ error: true }).tone === 'stopped', t({ error: true }).label)
check('cut off: red', t({ cutOff: true }).tone === 'stopped', t({ cutOff: true }).label)
check('a failed agent: red', t({ failedAgents: ['Snake'] }).tone === 'stopped', t({ failedAgents: ['Snake'] }).label)
check('a failure outranks one still going', t({ failedAgents: ['x'], agents: ['y'] }).tone === 'stopped')
check('an agent outranks a waiting card', t({ agents: ['x'], waiting: 1 }).label.includes('agent'))
check('every bubble says not finished or waiting', [
  t({ agents: ['x'] }), t({ running: 2 }), t({ waiting: 2 }), t({ error: true }), t({ cutOff: true }), t({ failedAgents: ['x', 'y'] })
].every((e) => /^(not finished|waiting for you)/.test(e.label)))
check('a stop time still ahead: yellow, says carry on', t({ stopAt: Date.now() + 3600_000 }).tone === 'going' && t({ stopAt: Date.now() + 3600_000 }).label.includes('carry on'), t({ stopAt: Date.now() + 3600_000 }).label)
check('work still going outranks the stop time', t({ stopAt: Date.now() + 3600_000, agents: ['x'] }).label.includes('agent'))
check('three names: two shown and a count', t({ agents: ['a', 'b', 'c'] }).detail.includes('a, b and 1 more'))

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('App: the line takes the tone as a class', app.includes('className={`turn-end is-${ended.tone}`}'))
check('App: going to done waits END_GRACE_MS', /ending\.tone === 'done' && ended\.tone === 'going'[\s\S]{0,120}END_GRACE_MS/.test(app))
check('App: only cards in the latest answer count as waiting', app.includes('pendingIn(lastAnswerId)'))
check('App: a failed agent taken over by a later one is not red', app.includes('b.startedAt > a.startedAt && (b.thing ?? b.title) === (a.thing ?? a.title)'))
check('App: only agents of this chat count', /a\.chatId === chatId && \(a\.status === 'queued'/.test(app))
const card = readFileSync('src/renderer/src/components/CommandCard.tsx', 'utf8')
check('Card: live panel waits for LIVE_AFTER_MS', card.includes("state === 'running' && liveShown &&"))
check('Card: start time kept across a remount', card.includes('STARTED.get(ranKey)') && card.includes('STARTED.set(ranKey, now)'))
check('Card: start time dropped when it ends', card.includes('STARTED.delete(ranKey)'))
const css = readFileSync('src/renderer/src/styles.css', 'utf8')
check('Agent card: the doing line stays one line while it works', readFileSync('src/renderer/src/components/AgentCard.tsx', 'utf8').includes('agent-doing is-live') && css.includes('.agent-doing.is-live {'))
check('CSS: yellow and red bubbles', css.includes('.turn-end.is-going {') && css.includes('.turn-end.is-stopped {'))
check('CSS: bubble fades in late, so a blink never shows it', /\.turn-end-flag \{[\s\S]*?animation: turn-end-in 220ms ease-out 400ms both/.test(css))

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall turn-end checks pass')
