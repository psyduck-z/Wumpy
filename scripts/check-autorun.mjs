/**
 * Checks what an automatic approval mode will run without a person present.
 *
 * This exists because of a real runaway: in "run everything", a delete was
 * proposed, run, reported back as "exit code 0, no output", proposed again by
 * the model, run again, and round it went — eight times in a couple of seconds.
 * A cap had been written for exactly that and was never passed down to the
 * cards, so the app printed "6 commands have run without you" and then kept
 * going. The cap is asserted here rather than assumed.
 *
 * Run with: npm run check:autorun
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.autorun-check.mjs')
await build({
  entryPoints: ['src/renderer/src/autorun.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { autoRunEligible, AUTO_RUN_LIMIT } = await import(pathToFileURL(out).href)

const DELETE = 'Remove-Item -Path "C:\\Users\\zecha\\Music\\test.txt" -Force'

const CASES = [
  ['first command of a turn', { command: DELETE, ranCommands: [], autoRuns: 0 }, true],
  [
    'a different second command',
    { command: 'ollama list', ranCommands: [DELETE], autoRuns: 1 },
    true
  ],
  // The loop, in one line: the model proposes what it just ran.
  ['the same command again', { command: DELETE, ranCommands: [DELETE], autoRuns: 1 }, false],
  [
    'the same command, reindented',
    { command: `  ${DELETE}  `, ranCommands: [DELETE], autoRuns: 1 },
    false
  ],
  [
    'run earlier in the turn',
    { command: DELETE, ranCommands: ['ollama list', DELETE, 'git status'], autoRuns: 3 },
    false
  ],
  // The cap, whatever the commands are.
  [
    'one below the cap',
    { command: 'git status', ranCommands: [], autoRuns: AUTO_RUN_LIMIT - 1 },
    true
  ],
  ['at the cap', { command: 'git status', ranCommands: [], autoRuns: AUTO_RUN_LIMIT }, false],
  ['past the cap', { command: 'git log', ranCommands: [], autoRuns: AUTO_RUN_LIMIT + 4 }, false],
  ['empty command', { command: '   ', ranCommands: [], autoRuns: 0 }, false]
]

let failed = 0
for (const [name, state, want] of CASES) {
  const got = autoRunEligible(state)
  const ok = got === want
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} ${got ? 'runs itself' : 'waits for a click'}` +
      (ok ? '' : `   (expected ${want ? 'runs itself' : 'waits for a click'})`)
  )
}

/**
 * The runaway, replayed: a model that answers every report by proposing the
 * same command. It must stop on the second one, not the seventh.
 */
let autoRuns = 0
const ranCommands = []
let ran = 0
for (let turn = 0; turn < 20; turn++) {
  if (!autoRunEligible({ command: DELETE, ranCommands, autoRuns })) break
  ran++
  autoRuns++
  ranCommands.push(DELETE)
}
const loopOk = ran === 1
if (!loopOk) failed++
console.log(
  `${loopOk ? 'ok  ' : 'FAIL'} a model proposing the same command 20 times runs it ${ran}x` +
    (loopOk ? '' : ' (expected 1x)')
)

rmSync(out, { force: true })

const total = CASES.length + 1
console.log(`\n${total - failed}/${total} unattended-run checks correct`)
process.exit(failed === 0 ? 0 : 1)
