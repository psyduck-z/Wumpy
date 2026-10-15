/**
 * Sending the instructions the turn is about, and not the other 4,700 tokens.
 *
 * The preamble is 13,341 tokens into a 32,768 window, on every request, on a
 * tier counted per minute and per day. Two sections of it - opening pages and
 * apps (3,182) and clicking on the screen (1,546) - are about capabilities
 * most turns never touch. "What is my key percentage" paid for both.
 *
 * The risk is entirely one-sided, which is what these checks are about. A
 * section sent needlessly costs tokens on one turn. A section MISSING costs
 * an answer, or worse, a model that concludes it cannot do something it can -
 * so the stub always names the capability, and anything that looks remotely
 * like the capability expands it. The false-stub cases are the ones worth
 * writing down.
 *
 * Run with: npm run check:needs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const needsOut = '.needs-check.mjs'
const promptOut = '.needs-prompt.mjs'
for (const [entry, outfile] of [
  ['src/shared/needs.ts', needsOut],
  ['src/shared/assistant.ts', promptOut]
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
}
const N = await import(pathToFileURL(needsOut).href)
const A = await import(pathToFileURL(promptOut).href)
rmSync(needsOut, { force: true })
rmSync(promptOut, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const said = (content, role = 'user', images) => ({ role, content, images })
const needs = (...texts) => N.needsFor(texts.map((t) => (typeof t === 'string' ? said(t) : t))).sort()
const FULL = { scope: 'full', search: true, screen: true, browser: true, quota: true }
const tokensFor = (list) => A.preambleTokens({ ...FULL, needs: list })

/* ------------------------------------------------------------ what it saves */

/* 13,341 until the credential rules were rewritten to allow typing a value
   the user handed over; that added 236 tokens, all of it inside the two
   gated sections, so a plain turn stayed at 7,841.

   Then the fast-route rules - ask the index before walking the disk - which
   are in the shell section and so go out on every turn: 305 added, 71
   recovered by dropping the "search my whole computer" example and the
   folder-picking advice the new rule supersedes, for a net 7,841 -> 8,075.
   Bought deliberately: a turn that spends two minutes scanning C: for a
   filename Everything already has indexed costs more than 234 tokens of
   anybody's day, and the rule has to be present on the turn the question is
   asked - which is any turn, so it cannot be gated.

   8,075 -> 8,145 for the other half of that rule, which was missing and
   cost a wrong answer. es is not on this machine, and the fallback said to
   name the likely folders and ask - so asked where PD.cap was, Wumpy
   searched Downloads, Documents and the Desktop and reported that it was
   not there. It was in C:\DRIVERS\WIN. The whole-drive search by name is
   now written out where the decision is made, twice: once in the scope
   table and once with what it costs (74 seconds, measured). Paid for in
   part by deleting the claim that Wumpy raises a native dialog on any
   drive-wide scan, which is not true of this one - the risk pattern wants a
   bare drive root, and `dir C:\PD.cap /s /b` has a filename after it.

   The quiz rule - check an anagram before you answer, and read whether the
   options are words or meanings - cost 256 and a plain turn did not pay a
   token of it. It went in as a third picture paragraph rather than with the
   voice rules, because the turn it was written for had a photograph of the
   question in it, and a photograph is what brings that topic in. Written
   where it is cheap, it can afford to carry the whole observed failure.

   8,145 -> 8,182 for two lines of it that could not be gated: the reply is
   the conclusion, not the search. The quiz arrived as a photograph, but the
   analogy question that did the same thing was typed, so the general half
   has to be present on turns with no picture in them. Two lines is what the
   25% ceiling in check-ask had room for, and the worked example stays in
   the gated paragraph where it is free. */
check('everything, as it was', A.preambleTokens(FULL), 14175)
check('a turn about nothing in particular', tokensFor([]), 8182)
check('which is a third of it gone', A.preambleTokens(FULL) - tokensFor([]) > 4500, true)
check('a turn about the screen', tokensFor(['desktop']) < A.preambleTokens(FULL), true)
check('a turn about a website', tokensFor(['open']) < A.preambleTokens(FULL), true)

/* ------------------------------------------------- what must still be sent */

/*
 * Shell and screen are never reduced. Not for lack of savings - shell is the
 * second biggest section - but because the failure is invisible: a model that
 * has not been told it can look at the machine answers from memory instead.
 */
{
  const lean = A.assemblePrompt({ ...FULL, needs: [] })
  check('the shell rules always go', /does this depend on what is on THIS computer/.test(lean), true)
  check('so does how to take a screenshot', /wumpy-screen/.test(lean), true)
  check('and the voice', /You are Wumpy/.test(lean), true)
  check('and when to ask instead of guessing', /genuinely ambiguous/.test(lean), true)
  /*
   * The fast route is in the always-sent half on purpose. "Where is this
   * file on my C:" is a plain shell turn - it expands no capability - so a
   * rule that only arrived with the browser or desktop sections would be
   * absent on exactly the question it exists for.
   */
  check('the fast route is never gated away', /A FASTER ROUTE TO THE SAME ANSWER/.test(lean), true)
  check('with the index named', /Get-Command es -EA SilentlyContinue/.test(lean), true)
  /* Guarded, because es is NOT on PATH on this machine: Everything is
     installed and its service is running, but the CLI ships separately.
     An unguarded `es notes.txt` is a command that fails for nothing. */
  check('and guarded, not assumed', /It may not be/.test(lean), true)
  check('and a fallback in the same block', /else \{ Get-ChildItem/.test(lean), true)
  /* The limit that keeps it honest. A shortcut that returns something else
     is not a shortcut, it is a wrong answer arriving sooner. */
  check('the same answer, or it is not a shortcut', /faster and nearly right is just/.test(lean), true)
  /* The stub has to NAME the capability. This is the whole safety argument:
     the model may be short of detail, never short of knowing it can. */
  check('the browser capability is still named', /wumpy-open/.test(lean), true)
  check('and so is the desktop one', /wumpy-do/.test(lean), true)
  check('the stub says to look before clicking', /never attempt a click without one/.test(lean), true)
  /* But the long detail is gone. */
  check('the site-search table is not sent', /youtube\.com\/results/.test(lean), false)
  /* Get-StartApps itself is in the shell section too, which always goes; it
     is the app-versus-CLI RULE that belongs to the browser section. */
  check('nor the app-versus-CLI rule', /ASKING ABOUT AN APP IS NOT ASKING YOU TO OPEN IT/.test(lean), false)
  /* The Get-StartApps example sits inside the install paragraph, so it goes
     with it; the app-versus-CLI rule is the browser section's and is already
     gone. Both come back the moment a turn is about either. */
  check('the install example goes with the install rules', /Get-StartApps/.test(lean), false)
  check('nor the aiming rules', /A CLICK IS NOT AIM/.test(lean), false)
}

/* ------------------------------------- the stretches inside the shell rules */

/*
 * Three subjects live inside the shell section and go out on every turn: what
 * winget prints, that a picture in a message is a screenshot, and the format
 * of a wumpy-write block. 921 tokens for three things a given turn is almost
 * never about.
 *
 * They are picked out by their own first lines rather than by cutting up the
 * literal, so the text is untouched - and the invariant that makes that safe
 * is checked rather than hoped for.
 */
const ALL = ['open', 'desktop', 'install', 'picture', 'write']
check('with everything on it is the same string', A.shellFor(ALL) === A.SHELL_PROMPT, true)
check('and so is no list at all', A.shellFor(undefined) === A.SHELL_PROMPT, true)
{
  const tok = (s) => Math.ceil(s.length / 4)
  /* These drift by a token each time the always-sent sections change length,
     because the estimate is ceil(chars / 4) and the difference of two
     ceilings moves with the absolute length. The text of the three topics
     has not changed since they were written. */
  const cost = (topic) => tok(A.shellFor(ALL)) - tok(A.shellFor(ALL.filter((t) => t !== topic)))
  check('the install rules cost 206', cost('install'), 206)
  check('the picture rules cost 499', cost('picture'), 499)
  /* 471 of format, less the one line of rule that stays behind in its place. */
  check('the write format costs 429', cost('write'), 429)
  check('all three together', cost('install') + cost('picture') + cost('write'), 1134)
}
{
  /* The prohibition has to outlive the section it starts: dropping the write
     block must not drop "never use a shell command for a file". */
  const lean = A.shellFor([])
  check('the write rule survives without its format', /never use a shell command/.test(lean), true)
  check('but the format itself is gone', /```wumpy-write/.test(lean), false)
  check('and it is said only once', lean.split('never use a shell command').length - 1, 1)
  check('winget narration is gone', /Successfully verified installer hash/.test(lean), false)
  check('and so is the picture pair', /THEY CAN SHOW YOU THINGS/.test(lean), false)
  /* And the third of them, which is the one that costs the most. */
  check('and the quiz rule with them', /A QUESTION IN A PICTURE/.test(lean), false)
  /* What must never go, however little the turn looks like it needs it. */
  check('but proposing is still not doing', /NEVER SAY IT IS DONE IN THE SAME BREATH/.test(lean), true)
  check('and a huge scope is still a misunderstanding', /A HUGE SCOPE IS A MISUNDERSTANDING/.test(lean), true)
  check('and keys still cannot be read', /CANNOT READ THEIR API KEYS/.test(lean), true)
  check('and folders are still not where you think', /THEIR FOLDERS ARE NOT WHERE YOU THINK/.test(lean), true)
}

check('installing', needs('install spotify').includes('install'), true)
check('downloading', needs('download the latest node').includes('install'), true)
check('updating', needs('update winget packages').includes('install'), true)
check('a picture they sent', needs(said('what is this', 'user', [1])).includes('picture'), true)
check('a picture they want', needs('draw me a diagram of this').includes('picture'), true)
/* Which is the whole argument for where the quiz rule lives: a photographed
   question carries its own instructions in, and a turn without a picture
   pays nothing for them. */
check(
  'and a photographed question brings the quiz rule with it',
  A.shellFor(needs(said('which of these is it', 'user', [1]))).includes('A QUESTION IN A PICTURE'),
  true
)
check('saving a file', needs('save that as notes.txt').includes('write'), true)
check('making one', needs('make a python script that prints the time').includes('write'), true)
check('a plain question needs none of the three', needs('what is my key percentage'), [])

/* ----------------------------------------------------- when it expands them */

check('a plain question needs neither', needs('what is my key percentage'), [])
check('nor an explanation', needs('why does this throw a TypeError'), [])
/* "write me a poem" brings the write rules, which is the generous trigger
   doing what it is set to do. 430 tokens is the cheap half of the trade. */
check('a poem costs the write rules', needs('write me a poem about rain'), ['write'])
check('nor a summary', needs('summarise what we decided'), [])

/* Launching an app is the browser section's business, not the aiming
   rules': nothing is being clicked yet. "open the file menu" is the other
   case and reaches desktop through "menu", not through "open". */
check('opening an app', needs('open spotify'), ['open'])
/* "open the file menu" reaches desktop through "menu" and browser through
   "open", and gets both - which is the design working, not failing: the
   expensive mistake is the section that does not arrive. */
check('but opening a menu is clicking too', needs('open the file menu'), ['desktop', 'open', 'write'])
check('a website', needs('take me to vocabulary.com'), ['open'])
check('a search on a site', needs('search youtube for lofi'), ['open'])
check('asking what is installed', needs('do I have ffmpeg installed'), ['install', 'open'])
check('clicking', needs('click the blue button'), ['desktop'])
check('typing somewhere', needs('type my email in the box'), ['desktop'])
check('a window', needs('switch to the chrome window'), ['desktop', 'open'])
check('signing in', needs('sign in to my account for me'), ['desktop'])
check('composing mail', needs('compose a gmail to my teacher'), ['desktop', 'open'])

/* A picture in the window is the strongest signal there is: desktop work
   always begins by looking, so the rules arrive with the screenshot. */
check('a screenshot expands the aiming rules', needs(said('now what', 'user', [1])), [
  'desktop',
  'picture'
])
check('even with nothing in the words', needs(said('', 'user', [1])), ['desktop', 'picture'])

/* A sequence must not lose its instructions halfway through. */
check(
  'a plan in flight keeps them',
  needs(said('```wumpy-do' + NL + 'press "Send"' + NL + '```', 'assistant'), 'ok'),
  ['desktop']
)
check(
  'and so does an open in flight',
  needs(said('```wumpy-open' + NL + 'search: x' + NL + '```', 'assistant'), 'thanks'),
  ['open']
)

/*
 * Wumpy's own prose must not trigger on itself. Its answers are full of the
 * words in these tables - "I clicked the button" - and if an assistant turn
 * counted, every capability would stay expanded for the rest of the chat.
 */
check('an answer describing a click does not count', needs(said('I clicked the Send button', 'assistant')), [])
check('nor one about opening a site', needs(said('I opened vocabulary.com for you', 'assistant')), [])

/* It forgets, so one mention does not expand it forever. */
{
  const long = [said('click the button'), said('ok', 'assistant'), said('thanks'), said('and now'), said('what time is it')]
  check('it looks back only so far', N.needsFor(long), [])
  check('and the window is four turns', N.LOOKBACK, 4)
}

/* ------------------------------------------------------- the shape contract */

check('no list at all means everything', A.preambleTokens({ ...FULL }), 14175)
check('an empty list is a real answer, not everything', tokensFor([]) < 14175, true)
check('one capability is not the other', tokensFor(['open']) !== tokensFor(['desktop']), true)
check('every topic together is everything', tokensFor(ALL), 14175)

/* --------------------------------------------------------------- the wiring */

const main = readFileSync('src/main/index.ts', 'utf8')
check('the sender works it out from what it sends', /needsFor\(sent\)/.test(main), true)
check('and the messages are built once', /const sending = withContext\(req\)/.test(main), true)
check('and reused for the attempt', /\bon,\s*sending,/.test(main), true)

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('the meter uses the same decision', /needs: needsFor\(/.test(app), true)

console.log(`${NL}${count - failed}/${count} needs checks passed`)
if (failed) process.exit(1)
