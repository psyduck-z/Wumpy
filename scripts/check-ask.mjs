/**
 * Questions Wumpy puts back to the user.
 *
 * Three things the user drove out of it, all in one exchange:
 *
 *   1. They clicked "No thanks" and Wumpy opened the website anyway. Asking
 *      and then ignoring the answer is worse than never asking - it spends
 *      their click and teaches them the question is decoration.
 *   2. The card could not be driven from the keyboard, which made a question
 *      the one place in the app where the keyboard ran out.
 *   3. One question per block was a limit from the local-model days. Four
 *      answered together is one trip instead of four.
 *
 * Run with: node scripts/check-ask.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.ask-check.mjs')
await build({
  entryPoints: ['src/renderer/src/components/Markdown.tsx'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  external: ['react', 'react/jsx-runtime', 'react-markdown', 'remark-gfm']
})
const M = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

const NL = String.fromCharCode(10)
const block = (...lines) => lines.join(NL)

/* ------------------------------------------------------------- one question */

const one = M.readAskGroups(block('Which folder?', '- Downloads', '- Documents'))
check('one question parses', one.length, 1)
check('with its text', one[0].question, 'Which folder?')
check('and both options', one[0].options, ['Downloads', 'Documents'])

/* ------------------------------------------------------- several questions */

// A line without a dash starts a new question and claims the options under it.
const two = M.readAskGroups(
  block('Which folder?', '- Downloads', '- Documents', 'Overwrite?', '- Yes', '- Pick another name')
)
check('two questions parse', two.length, 2)
check('the first keeps its own options', two[0].options, ['Downloads', 'Documents'])
check('and the second gets the rest', two[1].options, ['Yes', 'Pick another name'])
check('without stealing from the first', two[1].question, 'Overwrite?')

// Four is the cap: past that it is a form, not a question.
const many = M.readAskGroups(
  block(
    'Q1?',
    '- a',
    '- b',
    'Q2?',
    '- a',
    '- b',
    'Q3?',
    '- a',
    '- b',
    'Q4?',
    '- a',
    '- b',
    'Q5?',
    '- a',
    '- b'
  )
)
check('four questions at most', many.length, 4)
check('and the fifth is dropped, not merged', many[3].question, 'Q4?')

/* ------------------------------------------------------------- what is not a question */

// A question with one option is not a choice; it renders as prose instead.
check('a single option is not a question', M.readAskGroups(block('Sure?', '- Yes')), [])
check('nor is a bare line', M.readAskGroups('Just a sentence'), [])
check('an empty block parses to nothing', M.readAskGroups(''), [])
// An option before any question belongs to nothing. Dropping it beats
// inventing a question to hang it on.
const orphan = M.readAskGroups(block('- stray', 'Real question?', '- a', '- b'))
check('an orphan option is dropped', orphan.length, 1)
check('and the real question survives intact', orphan[0].options, ['a', 'b'])
// Five options each, so a block cannot become a menu.
const wide = M.readAskGroups(block('Pick', '- 1', '- 2', '- 3', '- 4', '- 5', '- 6', '- 7'))
check('five options at most', wide[0].options.length, 5)
// Blank lines are layout, not structure.
check(
  'blank lines do not split a question',
  M.readAskGroups(block('Which?', '', '- a', '', '- b'))[0].options,
  ['a', 'b']
)

/* --------------------------------------------------------------- the card */

const card = readFileSync('src/renderer/src/components/AskCard.tsx', 'utf8')
// Wumpy opens on a hotkey and every other card is keyboard-drivable; this
// one was not, which made a question the place the keyboard ran out.
check('arrows move between options', card.includes('arrowNavigate('), true)
check(
  'the first option takes focus',
  card.includes("querySelector<HTMLButtonElement>('.ask-option')"),
  true
)
check('without yanking the transcript', card.includes('preventScroll: true'), true)
check(
  'and not on an already-answered one',
  /if \(done \|\| grabbed\.current\) return/.test(card),
  true
)
check('Enter sends a filled-in form', /e\.key === 'Enter' && ready/.test(card), true)
// One question still answers on the click: a Send button there would be a
// second step that does nothing.
check(
  'one question answers immediately',
  /if \(!multi\) \{[\s\S]{0,60}onAnswer\(option\)/.test(card),
  true
)
check('several wait for all of them', card.includes('const ready = multi &&'), true)
check('and say how many are left', card.includes('more`'), true)
// Answers go back one per line, so the model does not have to pair them up
// with the questions by position.
check('answers are sent with their questions', card.includes('${g.question} ${picked[i]}'), true)

/* ------------------------------------------- obeying the answer, and uninstalling */

// The built value, not the source file: a rule split across two string
// literals is still one sentence to the model, and matching the source finds
// `'...the thing', 'anyway...'` instead.
const promptOut = join(process.cwd(), '.ask-prompt.mjs')
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: promptOut,
  logLevel: 'error'
})
const T = await import(pathToFileURL(promptOut).href)
rmSync(promptOut, { force: true })
const prompt = [T.VOICE_PROMPT, T.ASK_PROMPT, T.OPEN_PROMPT].join(' ').replace(/\s+/g, ' ')
/**
 * Assuming the small step and asking about the big one.
 *
 * The user's own framing, and the sharpest description of the failure so
 * far: "the worst part is that it doesn't know what it doesn't know." They
 * are explicit that filling in the obvious is wanted - "open it" after
 * talking about Spotify is Spotify, do not ask - and that the problem is
 * confidence beyond that, where it behaves as though it knows them.
 *
 * So the rule is not "ask more". It is a test for which kind of guess this
 * is: a wrong guess about WHICH thing costs a sentence, a wrong guess about
 * WHAT TO DO costs an action they never asked for.
 */
check('small steps are assumed', /ASSUME THE SMALL STEP/.test(prompt), true)
check('with the Spotify example', /that is Spotify/.test(prompt), true)
check('and the assumption said out loud', /Name what you assumed/.test(prompt), true)
// Naming it is what makes a wrong guess cheap to correct.
check(
  'because a correction is cheaper than a question',
  /faster than they can answer a question/.test(prompt),
  true
)
// The test itself, which is about cost rather than confidence.
check('the test is what a mistake costs', /have I already done something/.test(prompt), true)
check(
  'a wrong WHAT TO DO is the expensive one',
  /costs them an action they did not ask for/.test(prompt),
  true
)
// When to ask instead.
check('two plausible readings means ask', /two readings are both plausible/.test(prompt), true)
check('so does an unseen target', /something you have not seen on this machine/.test(prompt), true)
check('so does an untold preference', /a preference you were never told/.test(prompt), true)
check(
  'and an inferred destructive target',
  /inferred the target rather than being given it/.test(prompt),
  true
)
// The overconfidence itself, named.
check('it does not know this person', /You do not know this person/.test(prompt), true)
check('and not knowing is ordinary', /Not knowing is the ordinary/.test(prompt), true)

check(
  'the answer is an instruction',
  prompt.includes('THE ANSWER TO YOUR OWN QUESTION IS AN INSTRUCTION'),
  true
)
check('declining means do nothing', prompt.includes('means DO NOTHING'), true)
check('not do it anyway', prompt.includes('Do not do the thing anyway'), true)
check(
  'nor argue the point',
  prompt.includes('do not explain why it would have been a good idea'),
  true
)
check('ignoring it is worse than not asking', prompt.includes('worse than never asking'), true)
check(
  'and up to four may be asked at once',
  prompt.includes('up to FOUR questions in one block'),
  true
)

/**
 * Running an uninstaller was classified "not risky", so the native
 * confirmation never fired for it. That had to be true before the prompt
 * could be told to go ahead and propose one.
 */
const shell = readFileSync('src/main/shell.ts', 'utf8')
check('an uninstaller is destructive', /unins\(tall\)\?/.test(shell), true)
check('so is msiexec /x', shell.includes('msiexec'), true)
check(
  'and winget uninstall',
  shell.includes('winget\\s+uninstall') || shell.includes('winget'),
  true
)
check('and removing an Appx package', shell.includes('Remove-Appx'), true)

console.log(failures ? `\n${failures} ask checks FAILED` : '\nall ask checks')
process.exitCode = failures ? 1 : 0
