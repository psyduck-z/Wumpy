/**
 * The rules of a spoken turn (src/shared/spoken.ts): only yes or no answers
 * an approval, "slash" makes a command, questions read like questions, and
 * code is never read aloud.
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.voiceturn-check.mjs')
await build({ entryPoints: ['src/shared/spoken.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const S = await import(pathToFileURL(out).href)
rmSync(out, { force: true })
const outI = join(process.cwd(), '.voiceturn-interrupt.mjs')
await build({ entryPoints: ['src/shared/interrupt.ts'], bundle: true, platform: 'node', format: 'esm', outfile: outI, logLevel: 'error' })
const I = await import(pathToFileURL(outI).href)
rmSync(outI, { force: true })

let failed = 0
let count = 0
function check(name, actual, expected) {
  count++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(actual)}`)
}

for (const said of ['Yes', 'yes.', 'Yeah', 'Yep!', 'Okay', 'yes please', 'Do it', 'go ahead', 'Sure.'])
  check(`"${said}" approves`, S.yesNo(said), 'yes')
for (const said of ['No', 'no.', 'Nope', 'Cancel', "Don't", 'no thanks', 'Stop'])
  check(`"${said}" refuses`, S.yesNo(said), 'no')
for (const said of ['', 'maybe', 'what does it do', 'yes but first check the folder', 'yes no', 'hmm', 'the weather'])
  check(`"${said}" is ignored`, S.yesNo(said), null)

/* Talked over an answer: a cough or an "mm-hm" carries on, "stop" stops
   and sends nothing, anything else is the next question. */
for (const said of ['', 'Mm-hmm.', 'Hmm.', 'Uh-huh', 'Mhm', 'um', 'Oh.', 'mm mm'])
  check(`"${said}" over an answer: it carries on`, I.interruption(said), 'nothing')
for (const said of ['Stop.', 'Wait', 'Okay, stop.', 'Never mind', 'stop talking', 'Hold on.', 'Stop please', "That's enough", 'Stop, Ray.', 'Stop, Jason.'])
  check(`"${said}" over an answer: it stops`, I.interruption(said), 'stop')
for (const said of ['Stop the music', 'Wait, what about tomorrow?', 'Actually make it three', 'Hmm, what about Paris?', 'okay', 'yes'])
  check(`"${said}" over an answer: the next question`, I.interruption(said), 'words')

/* A pause to think is not the end: "...how it kind of like" was answered
   half asked. Finished sentences, the way the transcriber writes them, are
   not waited on any longer. */
for (const said of [
  "Give me a 2nd. Can you describe to me what neuroscience is, how it affects our mental life, um, and how it kind of like ",
  'What is the weather like in,',
  'Open my downloads and.',
  'Can you check if the',
  'Tell me about um.',
  'So what I want is...',
  'I need you to look at the'
])
  check(`"${said.trim()}" is mid-thought`, I.unfinished(said), true)
for (const said of [
  "What's one plus one?",
  'Okay then, what\'s four plus two?',
  'Yeah, why not?',
  'Hold on a sec. Hold on a 2nd. I mentioned, but let\'s talk about topography, define topography.',
  'Can you turn it on?',
  'Turn the music on.',
  'I think so.',
  'Yes',
  'no',
  'Leo',
  'Yes please',
  'Stop!',
  ''
])
  check(`"${said}" is finished`, I.unfinished(said), false)
{
  const hook = (await import('node:fs')).readFileSync('src/renderer/src/hooks/useVoiceTurn.ts', 'utf8')
  check('the conversation waits longer on a thought trailing off', /unfinished\(heardSoFar[\s\S]{0,200}r\.setPause\(UNFINISHED_PAUSE_MS\)/.test(hook), true)
  check('and only on the recording it guessed at, still unchanged', /r !== ear \|\| r\.spokeAt\(\) !== at/.test(hook), true)
}

check('slash makes a command', S.spokenSlash('Slash remember I like tea.'), '/remember I like tea')
check('with punctuation after it', S.spokenSlash('Slash. Remember, I like tea'), '/remember I like tea')
check('a written slash too', S.spokenSlash('/clear'), '/clear')
check('a command alone', S.spokenSlash('slash new'), '/new')
check('slash mid-sentence is just a word', S.spokenSlash('what is a slash command'), null)
check('ordinary speech is not a command', S.spokenSlash('remember I like tea'), null)

check('a # line becomes the question', S.approvalQuestion({ command: '# Check whether git is installed\ncommand -v git' }), 'Can I check whether git is installed?')
check('a card can describe itself', S.approvalQuestion({ command: '/home/x/notes.md', spoken: 'write notes.md' }), 'Can I write notes.md?')
check('and a bare command still asks', S.approvalQuestion({ command: 'ls ~' }), 'Can I run that command?')

const FENCE = '```'
check('code is not read aloud', S.speakable(`Here you go.\n${FENCE}wumpy-run-bash\n# Check\nls\n${FENCE}\nIt will list them.`), 'Here you go. It will list them.')
check('nor markup or links', S.speakable('**Done.** See [the docs](https://x.y/z) or https://a.b/c.'), 'Done. See the docs or a link.')
const long = 'One sentence here. '.repeat(60)
const spoken = S.speakable(long, 200)
check('long answers stop at a sentence', spoken.length <= 200 && spoken.endsWith('.'), true)

/* Earbuds or screen: the voice turn says so for its whole length, every
   request carries it, and the model is told both ways round. */
{
  const { readFileSync } = await import('node:fs')
  const turn = readFileSync('src/renderer/src/hooks/useVoiceTurn.ts', 'utf8')
  const chat = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const on = turn.indexOf('setHandsFree(true)')
  const off = turn.indexOf('setHandsFree(false)')
  check('a conversation is hands-free from its start', on > 0 && on < turn.indexOf('void conversation()'), true)
  check('until it ends, however it ends', off > turn.indexOf('.finally('), true)
  check('every request says which', /handsFree: handsFree\(\)/.test(chat), true)
  check('and the message is marked', /spoken: true/.test(chat), true)
  check('the model hears about the earbuds', /ON THEIR EARBUDS/.test(main), true)
  check('and about the screen otherwise', /at the screen, reading/.test(main), true)
  check('the facts are given the flag', /req\.context\.handsFree === true/.test(main), true)
}

console.log(`\n${count - failed}/${count} voice-turn checks correct`)
process.exit(failed === 0 ? 0 : 1)
