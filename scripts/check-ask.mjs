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

// The stripped variant, loaded the same way so the checks below measure the
// real thing rather than a copy of its wording.
const leanOut = join(process.cwd(), '.ask-lean.mjs')
await build({
  entryPoints: ['src/shared/lean.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: leanOut,
  logLevel: 'error'
})
const LEAN = await import(pathToFileURL(leanOut).href)
rmSync(leanOut, { force: true })
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
 * It asked the right question and filled it with answers it had invented -
 * first full paths, then bare filenames guessed from the word "old". Two
 * phrasings of the prohibition changed nothing; the worked example below it
 * took five samples out of five to a one-line question and no block.
 */
check(
  'options must be things it has seen',
  prompt.includes('EVERY OPTION MUST BE SOMETHING YOU HAVE SEEN'),
  true
)
check('never an unlisted path', prompt.includes('Never a path you have not listed'), true)
check('nothing real means no block', prompt.includes('DO NOT USE A BLOCK'), true)
check('ask in prose instead', prompt.includes('Which file do you mean?'), true)
check(
  'and the invented list is shown as wrong',
  prompt.includes('NOT a block offering old.txt'),
  true
)
check('because guessed options are still guessing', /still guessing/.test(prompt), true)

/* ------------------------------ the lean variant covers the contract ----- */

/**
 * The stripped prompt must still carry the app's contract, whatever it
 * drops of the coaching.
 *
 * The full prompt is 9,483 tokens, almost all of it remediation aimed at
 * one model, and at that size Groq rejects every request outright - its
 * free tier caps a minute at 8,000. The lean variant is 1,507 and says each
 * rule once. What it may NOT drop is anything the app itself depends on:
 * the four block formats, the places a write is refused, and the fact that
 * keys cannot be read. Dropping a piece of coaching is a measurement;
 * dropping a piece of the contract is a bug.
 *
 * The reduced scopes were missing from the first draft, which would have
 * broken /shell read and /shell off the moment it was used.
 */
{
  const lean = LEAN.LEAN_PROMPT
  for (const [what, needle] of [
    ['a run block', '```wumpy-run'],
    ['an ask block', '```wumpy-ask'],
    ['a write block', '```wumpy-write'],
    ['a search block', '```wumpy-search'],
    ['the path: line', 'path:'],
    ['the refused write folders', 'Startup, the Start Menu, Windows, Program Files'],
    ['that keys cannot be read', 'cannot read their API keys'],
    ['the app’s own slash commands', '/rename, /new, /resume, /compact'],
    ['that only the first block runs', 'FIRST runnable block'],
    ['that a question is not an instruction', 'A QUESTION IS NOT AN INSTRUCTION']
  ]) {
    check(`the lean prompt keeps ${what}`, lean.includes(needle), true)
  }
  check('and has a read-only scope', LEAN.LEAN_READ_ONLY.length > 80, true)
  check('and a no-shell scope', LEAN.LEAN_NO_SHELL.length > 80, true)
  // The whole point of it.
  const leanTokens = Math.round(lean.length / 4)
  check(`the lean prompt is ~${leanTokens} tokens, under Groq's 8000/min cap`, leanTokens < 3000, true)
}

/* ------------------------------ the middle prompt is really composed ----- */

/**
 * The middle prompt extracts its sections from the live prompt by heading,
 * so the two cannot drift apart. The cost of that is a silent failure mode:
 * reword a heading and the extraction returns an empty string, the section
 * vanishes, and the safety it was carrying goes with it without anything
 * complaining.
 *
 * So every heading must still be found, every extracted section must be
 * substantial rather than a stub, and the result must be meaningfully
 * larger than the lean prompt it is built from.
 */
{
  const sources = { voice: T.VOICE_PROMPT, shell: T.SHELL_PROMPT, ask: T.ASK_PROMPT }
  for (const { from, heading, rungs } of LEAN.LOAD_BEARING) {
    const found = sources[from]
      .split(String.fromCharCode(10))
      .some((l) => l.trim().startsWith(heading))
    check(`"${heading.slice(0, 34)}" still exists (${rungs})`, found, true)
  }

  const middle = LEAN.middlePrompt(T.VOICE_PROMPT, T.SHELL_PROMPT, T.ASK_PROMPT)
  const leanTokens = Math.round(LEAN.LEAN_PROMPT.length / 4)
  const midTokens = Math.round(middle.length / 4)
  // Every section carried real text, not an empty extraction.
  check(
    `the middle prompt is ~${midTokens} tokens, up from ${leanTokens}`,
    midTokens > leanTokens + 800,
    true
  )
  // And it still fits the tightest free tier worth caring about.
  check('and fits the 8000-token minute Groq allows, with room to talk', midTokens < 5000, true)
  // It must contain the lean base, not replace it.
  check('it keeps the lean base', middle.startsWith(LEAN.LEAN_PROMPT), true)
}

/* ------------------------------ what the instructions cost ---------------- */

/**
 * The instructions must not eat the conversation.
 *
 * Everything Wumpy sends before the first word the user types is part of the
 * context, and compaction fires at 65% of the window - so a large preamble
 * does not just cost tokens, it shortens how much conversation fits before
 * older turns start being summarised away. The preamble grew from roughly
 * 3,400 tokens to 9,400 over one session of adding measured rules, which cut
 * conversation headroom from about 17,900 tokens to about 11,900.
 *
 * Every one of those rules was earned by a failing measurement, so this is
 * not a ban on growth. It is a ceiling that makes the next addition a
 * decision rather than a surprise, and tripping it means trimming something
 * or raising it on purpose. This has now been raised on purpose, once, and
 * what follows is the reason - because a raised ceiling with no argument
 * behind it is not a ceiling.
 *
 * A flat sum of the section literals was the right measure when every one
 * of them went out on every turn. They do not any more: `needs` gates the
 * browser and desktop rules behind a turn that is about browsing or
 * clicking, so the number that matters is what `preambleTokens` returns for
 * a given turn, not what the file adds up to. Those come out as:
 *
 *   a plain turn           8,075   24.6%   <- what most turns pay
 *   every capability on   13,811   42.1%   <- a turn about all of it
 *
 * So the common case is comfortably inside the old third, and the worst
 * case is a turn that really is about browsing and the desktop and
 * installing at once, which is the one turn that cannot do without any of
 * it. The flat sum is kept as a trend line with a looser bound, since it is
 * still the thing that grows when nobody is looking.
 *
 * Four characters per token is the rough rate for English prose with code
 * fragments in it. Exactness is not the point; the trend is.
 */
{
  const sections = [
    T.VOICE_PROMPT,
    T.APP_PROMPT,
    T.SHELL_PROMPT,
    T.SEARCH_PROMPT,
    T.OPEN_PROMPT,
    T.ASK_PROMPT
  ]
  const tokens = Math.round(sections.join(' ').length / 4)
  const share = tokens / T.CONTEXT_TOKENS
  check(
    `the literals add up to ~${tokens} tokens, ${(share * 100).toFixed(0)}% of the window`,
    share <= 0.4,
    true
  )

  /*
   * What a turn actually pays, which is the figure the old flat sum was
   * standing in for. The plain-turn bound is deliberately tight: it is the
   * one most turns pay, so anything added to the always-sent half has to be
   * argued for here rather than absorbed.
   *
   * 25% -> 26% and 45% -> 46%, once, and here is the argument.
   *
   * Both bounds were round numbers that the real figures happened to sit a
   * tenth of a percent under - 8,170 against 8,192, and 14,701 against
   * 14,745. That is not headroom, it is luck, and it meant the next true
   * sentence anybody added to the prompt would break them whatever it said.
   *
   * What was added: 41 tokens saying that on how Wumpy itself works these
   * instructions are the evidence and the user's guess is not, and 25 saying
   * which search engine a `search:` opens. Wumpy had told a user the second
   * one wrong - "`search:` in Wumpy goes to DuckDuckGo specifically" - after
   * first getting it right and then being contradicted. The engine half is
   * in OPEN_PROMPT, so a plain turn does not pay for it; the general half
   * cannot be gated, because the turn where somebody contradicts the app
   * looks like any other turn.
   *
   * The bounds are still bounds: a point of the window is 328 tokens, and
   * this spent 41 of them. The next thing added to the always-sent half
   * should buy its room by gating something, not by moving these again.
   */
  /*
   * quota: true although NVIDIA turns that section off (see promptShape:
   * there is no daily allowance to run out, and a 429 is absorbed by
   * rotation before the model hears about it). Deliberately the worst case -
   * the bound has to hold for the configuration that sends the most, not for
   * the one in use today, or adding a Google key back would quietly push a
   * plain turn past a ceiling that had been measured without it.
   */
  const FULL = { scope: 'full', search: true, screen: true, browser: true, quota: true }
  const plain = T.preambleTokens({ ...FULL, needs: [] })
  const everything = T.preambleTokens(FULL)
  check(
    `a plain turn pays ~${plain}, ${((plain / T.CONTEXT_TOKENS) * 100).toFixed(0)}% of the window`,
    plain / T.CONTEXT_TOKENS <= 0.26,
    true
  )
  check(
    `every capability on pays ~${everything}, ${((everything / T.CONTEXT_TOKENS) * 100).toFixed(0)}%`,
    everything / T.CONTEXT_TOKENS <= 0.46,
    true
  )
  /* And the gating has to be worth having, or the two numbers above are the
     same number and this suite is measuring nothing. */
  check('gating saves a third of it', everything - plain > everything * 0.3, true)
  // And the optional half really is optional, since /browser off is the
  // lever a user has if they want the room back.
  const withoutBrowser = Math.round(
    sections.filter((x) => x !== T.OPEN_PROMPT).join(' ').length / 4
  )
  check(
    `/browser off saves ~${tokens - withoutBrowser} tokens`,
    tokens - withoutBrowser > 1000,
    true
  )
}

/* ------------------------------ wrong answers are not scripted ----------- */

/**
 * The prompt must never spell out a wrong answer as a line of dialogue.
 *
 * A worked example for "are you sure" laid the bad exchange out as a
 * transcript, with the assistant saying "Spotify is installed." and "I can
 * see the machine." It fixed that case and broke two others: the model
 * started emitting both lines verbatim, because an example reads as output
 * whichever half of it you meant. Quoting a wrong answer teaches it.
 *
 * Checked against the prompt the app really sends, line by line, because
 * the danger is a short standalone line that looks like a reply - not a
 * mention inside a sentence, which is how the lesson itself is recorded.
 */
{
  const FORBIDDEN_LINES = [
    'Spotify is installed.',
    'I can see the machine.',
    'I can see your machine.',
    'Yes.',
    'Docker is not installed.'
  ]
  const everything = [T.VOICE_PROMPT, T.SHELL_PROMPT, T.OPEN_PROMPT, T.ASK_PROMPT].join(
    String.fromCharCode(10)
  )
  const lines = everything.split(String.fromCharCode(10)).map((l) => l.trim())
  for (const bad of FORBIDDEN_LINES) {
    // A line that IS the wrong answer, with or without an example indent.
    const scripted = lines.some((l) => l === bad || l === `  ${bad}`)
    check(`does not script "${bad}"`, scripted, false)
  }
  // And the lesson is written down where the next person will look.
  check(
    'and says why, so it is not re-added',
    /describe the mistake, do not script it/i.test(everything),
    true
  )
}

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
