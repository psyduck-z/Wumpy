/**
 * Accept-all means accept all, and the thing that replaced the dialog.
 *
 * Said three times, narrowed twice, and still asking:
 *
 *   "in accept all, I literally mean accept EVERYTHING, no matter whether
 *    its seeing my screen, or clicking buttons."
 *   "I SAID ALLOW EVERYTHING! So when I try to run the command, even when
 *    it's red, don't pop up the stupid confirmation."
 *
 * Each time the fix was to narrow what counts as risky, which is the wrong
 * axis: there is always one more category. This pins the mode itself, so the
 * next well-meant exception fails here instead of in front of the user.
 *
 * The other half is the consequence. With no gate left, the only thing
 * between a wrong guess and the machine is the command the model proposes -
 * and the first command to run under the ungated mode force-killed Ollama's
 * tray icon and model server when the user had asked to close a window. So
 * the close rule is pinned with the same seriousness the dialog used to get.
 *
 * Run with: npm run check:acceptall
 */
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(60)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const main = readFileSync('src/main/index.ts', 'utf8')
const judge = main.slice(main.indexOf('function judge('), main.indexOf('IPC.shellRisk'))

/* ------------------------------------------------- nothing stops accept-all */

/*
 * The verdict is read rather than re-implemented: a test that restates the
 * rule passes whatever the rule says. This asserts the one thing that must
 * be true of the expression - that `mode === 'all'` is what switches the
 * stop off, not a risk level inside it.
 */
/* judge() hands the decision to decide() in shell.ts, which check-approval.mjs also runs. */
const shellSrc = readFileSync('src/main/shell.ts', 'utf8')
const decideSrc = shellSrc.slice(shellSrc.indexOf('export function decide('), shellSrc.indexOf('export type RiskLevel'))
check('judge() decides with decide()', /decide\(\{ readOnly, level, scope, mode/.test(judge), true)
check('decide() has a risky test', /const risky =/.test(decideSrc), true)
const risky = decideSrc.match(/const risky = (.*)/)?.[1] ?? ''
check('accept-all is what turns it off', /mode !== 'all'/.test(risky), true)
check('no risk level survives in accept-all', /level === 'severe'/.test(risky), false)
check('confirmRisky cannot re-enable it', /mode === 'all' \? /.test(risky), false)

/*
 * And the native dialog, which is a second decision in a second place and
 * is how this broke the last two times: judge() said run it, and the
 * handler asked anyway.
 */
const runner = main.slice(main.indexOf('IPC.shellRun'), main.indexOf('showMessageBox'))
check('the dialog is skipped in accept-all', /approvalMode'\) === 'all'/.test(runner), true)
check('and when the verdict already said auto', /verdict\.auto/.test(runner), true)

/*
 * The red label stays. Showing is not asking, and the user objected to being
 * stopped, not to being told.
 */
const card = readFileSync('src/renderer/src/components/CommandCard.tsx', 'utf8')
check('a risky command is still outlined red', /is-risky/.test(card), true)
check('and still says what it does', /cmd-risk/.test(card), true)

/* ------------------------------------------- the rule that replaced the gate */

const out = '.acceptall-check.mjs'
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const A = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const close = A.CLOSE_PROMPT
check('there is a close rule', typeof close === 'string' && close.length > 0, true)
check('it distinguishes closing from killing', /CLOSING AN APP IS NOT KILLING/.test(close), true)
check('it gives the graceful command', /CloseMainWindow\(\)/.test(close), true)
check('selected by owning a window', /MainWindowHandle -ne 0/.test(close), true)
check('-Force is tied to the words the user said', /frozen|not responding/.test(close), true)
check('a windowless app is asked about, not killed', /ask first/i.test(close), true)
check('it names the case that caused it', /Ollama/.test(close), true)
check('and forbids the name-prefix sweep', /name prefix/i.test(close), true)

/*
 * Wired on the same condition as the shell prompt. A rule about commands
 * that is absent whenever commands are on is worse than no rule, because
 * the file says it exists.
 */
/*
 * Read where the assembly actually lives, which is no longer main.
 *
 * It moved into @shared/assistant when the panel had to be able to measure the
 * preamble it was about to send, and this check went on reading main - so it
 * failed for a week without saying anything true. It stayed quiet because
 * `npm run typecheck` chains on && and the hook-staleness gate above it halts
 * the run, which is its own lesson: a check this far down the chain is only
 * ever seen when everything before it passes.
 */
const prompts = readFileSync('src/shared/assistant.ts', 'utf8')
check('it is wired into the system prompt', /CLOSE_PROMPT/.test(prompts), true)
const assembly = prompts.slice(
  prompts.indexOf('export function promptSections'),
  prompts.indexOf('export function assemblePrompt')
)
check('and only with full shell scope', /scope === 'full' \? CLOSE_PROMPT/.test(assembly), true)
/* And main still has to be the thing that decides the scope from settings. */
check('main maps settings to that shape', /function promptShape/.test(main), true)

/*
 * What it costs, because the user asked for the preamble to come down and
 * this adds to it. ~4.01 chars per token, measured against countTokens.
 */
console.log(`\n     close rule: ${close.length} chars, about ${Math.round(close.length / 4.01)} tokens`)

console.log(`${count - failed}/${count} checks passed`)
if (failed) process.exit(1)
