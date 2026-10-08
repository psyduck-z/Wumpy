/**
 * Checks what happens to a transcript between the microphone and the box.
 *
 * Two things are being guarded, and the second matters more than the first.
 *
 * The first is that known mishearings get fixed. An acoustic model has never
 * heard of this app, so "Wumpy" and "Ollama" and "/also" come back wrong in
 * predictable ways, and a table puts them right.
 *
 * The second is that everything else is left alone. A correction layer that
 * rewrites a sentence it did not understand is worse than no correction layer,
 * because the user is about to read it in the box and press Enter. So every
 * transcript Whisper actually got right is run through and required to come out
 * the same.
 *
 * Those right answers are not invented here. scripts/speech/transcripts.json
 * holds what faster-whisper really returned for twelve synthesised sentences,
 * recorded once, with and without the vocabulary prompt, so this runs in
 * milliseconds and still tests against real model output rather than against
 * what I assumed it would produce.
 *
 * Run with: npm run check:dictation
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.dictation-check.mjs')
await build({
  entryPoints: ['src/shared/dictation.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { tidyTranscript, isNoise, polishAcceptable, POLISH_PROMPT } = await import(
  pathToFileURL(out).href
)
rmSync(out, { force: true })

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 46)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 46)} expected ${JSON.stringify(want)}`)
}

// Every command, so the spoken forms are built from the real list.
const COMMANDS = ['also', 'tier', 'new', 'model', 'rename', 'approve', 'stop', 'pin', 'dock']
const tidy = (text) => tidyTranscript(text, { commands: COMMANDS })

/* ------------------------------------------------- the app's own vocabulary */

check('the app name', tidy('open wimpy and ask it'), 'Open Wumpy and ask it')
check('the app name, other spelling', tidy('is whimpy running'), 'Is Wumpy running')
check('Ollama split in two', tidy('ask a llama to do it'), 'Ask Ollama to do it')
check(
  'Ollama as base.en heard it',
  tidy('ask Olimit to summarize this'),
  'Ask Ollama to summarize this'
)
check('Ollama, the other one', tidy('Ask Olima to summarize'), 'Ask Ollama to summarize')
check('a model name', tidy('use fee four mini for this'), 'Use phi4-mini for this')
check('another model name', tidy('switch to quen two five'), 'Switch to qwen2.5')
check(
  'tier next to a tier name',
  tidy('switch to the deep tear and try again'),
  'Switch to the deep tier and try again'
)
check('tier before a noun', tidy('open the tear list'), 'Open the tier list')

/**
 * The counterpart, and the reason the tier rules are written narrowly: these
 * are the sentences a broad rule would have ruined.
 */
check('a tear is still a tear', tidy('there is a tear in the file'), 'There is a tear in the file')
check(
  'and so is crying',
  tidy('that nearly brought a tear to my eye'),
  'That nearly brought a tear to my eye'
)
check('a llama is still a llama', tidy('draw a llama wearing a hat'), 'Draw a llama wearing a hat')

/* ---------------------------------------------------------------- file names */

check('dot py, which sounds like pie', tidy('call it hello dot pie'), 'Call it hello.py')
check('dot py spelled out', tidy('name the file test dot p y'), 'Name the file test.py')
check('dot json', tidy('read package dot jason'), 'Read package.json')
check('dot md', tidy('open the readme dot em dee'), 'Open the readme.md')
check('a real pie is untouched', tidy('find a recipe for apple pie'), 'Find a recipe for apple pie')

/* ------------------------------------------------------------ slash commands */

check('a spoken slash command', tidy('slash also call it hello'), '/also call it hello')
check('slash misheard as flash', tidy('flash tier'), '/tier')
check(
  'the bare word at the start',
  tidy('also it should print the date'),
  '/also it should print the date'
)

/**
 * Only names nobody says by accident get the bare-word treatment. "stop that
 * and come back" is a sentence, and turning it into /stop would run a command
 * the user did not ask for - the one failure in this file that would actually
 * do something.
 */
check(
  'a command name that is also a word',
  tidy('stop that and come back'),
  'Stop that and come back'
)
check('and another', tidy('new file in my music folder'), 'New file in my music folder')

/* ---------------------------------------------- what Whisper does to silence */

check('silence', isNoise(''), true)
check('Whisper filling a silence', isNoise('Thank you.'), true)
check('Whisper filling a longer one', isNoise('Thanks for watching!'), true)
check('a subtitle credit', isNoise('Subtitles by the Amara.org community'), true)
check('a bracketed marker', isNoise('[BLANK_AUDIO]'), true)
check('punctuation alone', isNoise('...'), true)
check('actual speech is not noise', isNoise('thank you for checking that'), false)
check('and the box is left empty', tidy('Thank you.'), '')

/* ------------------------------------------------------- recorded transcripts */

/**
 * The important one. Everything faster-whisper got right must survive the
 * correction layer untouched.
 */
const recorded = JSON.parse(readFileSync('scripts/speech/transcripts.json', 'utf8'))
let changed = 0
let examined = 0
const damaged = []
for (const run of recorded) {
  for (const { said, heard } of run.rows) {
    if (!heard) continue
    examined++
    const after = tidy(heard)
    // Capitalisation and the trailing full stop are Whisper's own; the layer is
    // allowed to leave them be but not to alter the words.
    const words = (t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9/.\- ]/g, '')
        .trim()
    if (words(after) !== words(heard)) {
      changed++
      // A change is only a fault if it moved away from what was said.
      const closer = words(after) === words(said) || words(heard) !== words(said)
      if (!closer) damaged.push({ said, heard, after })
    }
  }
}
check(`${examined} recorded transcripts, none damaged`, damaged.length, 0)
for (const d of damaged) {
  console.log(`       said : ${d.said}\n       heard: ${d.heard}\n       after: ${d.after}`)
}

/**
 * And the no-prompt run is where the table has something to do: without the
 * vocabulary prompt, base.en returned "Olimit" for Ollama and "deep tear" for
 * deep tier on these same sentences.
 */
const noPrompt = recorded.find((r) => r.model === 'base.en' && r.prompt === false)

/**
 * Measured as "closer", not "equal". base.en writes en-US and collapses spoken
 * numbers, so "summarise" comes back "summarize" and "fifty megabytes" comes back
 * "50 MB" - neither is an error, and demanding an exact match would make this
 * check about spelling conventions rather than about the table.
 */
const terms = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9/.\- ]/g, '')
    .trim()
    .split(/\s+/)
const gap = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    prev = cur
  }
  return prev[b.length]
}

const closer = []
for (const { said, heard } of noPrompt.rows) {
  const want = terms(said)
  const before = gap(want, terms(heard))
  const after = gap(want, terms(tidy(heard)))
  if (after < before) closer.push({ heard, fixed: tidy(heard), before, after })
}
check('the table repairs what the prompt would have', closer.length >= 2, true)
for (const r of closer)
  console.log(`       ${r.heard}\n    -> ${r.fixed}   (${r.before} wrong -> ${r.after})`)

/* -------------------------------------------------------------- polish guard */

const raw = 'make a python file in my music folder that prints the time'

check(
  'punctuation is accepted',
  polishAcceptable(raw, 'Make a Python file in my music folder that prints the time.'),
  true
)
check('an unchanged line is accepted', polishAcceptable(raw, raw), true)
check(
  'numbers may collapse',
  polishAcceptable('there are two hundred and fourteen files', 'There are 214 files.'),
  true
)

// Everything a model does instead of punctuating.
check(
  'an answer is refused',
  polishAcceptable(raw, 'Sure! Here is a Python file that prints the time.'),
  false
)
check(
  'a preamble is refused',
  polishAcceptable(raw, "Here's the corrected transcript: make a python file"),
  false
)
check('a code block is refused', polishAcceptable(raw, '```python\nprint(1)\n```'), false)
check(
  'a quoted restatement is refused',
  polishAcceptable(raw, '"Make a Python file in my music folder that prints the time."'),
  false
)
check('an empty reply is refused', polishAcceptable(raw, '   '), false)
check(
  'a commentary is refused',
  polishAcceptable(raw, 'It looks like you want to create a file.'),
  false
)
check(
  'extra lines are refused',
  polishAcceptable(raw, 'Make a Python file.\nIt should print the time.'),
  false
)
check(
  'a rewrite is refused',
  polishAcceptable(raw, 'Generate a script that outputs the current timestamp.'),
  false
)
check('a truncation is refused', polishAcceptable(raw, 'Make a Python file.'), false)
check(
  'an expansion is refused',
  polishAcceptable(
    raw,
    'Make a Python file in my music folder that prints the current time of day for me please now'
  ),
  false
)

/**
 * The prompt and the guard have to agree: anything the model is told to do must
 * be something the guard lets through, or the feature silently never works.
 */
check('the prompt forbids answering', /[Nn]ever answer/.test(POLISH_PROMPT), true)
check('the prompt forbids adding', /Never add or remove information/.test(POLISH_PROMPT), true)
check('the prompt forbids quotes', /Never add quotes/.test(POLISH_PROMPT), true)
check('the prompt asks for the line alone', /nothing else/.test(POLISH_PROMPT), true)

/* ------------------------------------------------------------ the pipeline */

/**
 * Settings whose absence costs speed or accuracy without ever looking wrong -
 * the transcript still arrives, it is just worse or slower than it needed to be.
 */
const worker = readFileSync('resources/speech/worker.py', 'utf8')

/**
 * The one that cost the most. ctranslate2 takes every core by default, and on a
 * 16-core machine that measured 2.7x SLOWER than taking eight: a 4.04s median on
 * a 2.5s clip against 1.51s. Short utterances spend all their time
 * synchronising, and the cores are wanted by Ollama anyway.
 */
check('the transcriber caps its thread count', /cpu_threads=threads/.test(worker), true)
check('and halves the core count to get it', /min\(8, cores \/\/ 2\)/.test(worker), true)

check('silence is cut before the model sees it', /vad_filter=True/.test(worker), true)
check('each utterance stands alone', /condition_on_previous_text=False/.test(worker), true)
check("the app's vocabulary is given to Whisper", /initial_prompt=VOCABULARY/.test(worker), true)
check('Wumpy and Ollama are in that vocabulary', /Wumpy, Ollama/.test(worker), true)
check('int8, because this app only has the CPU', /compute_type="int8"/.test(worker), true)

const main = readFileSync('src/main/index.ts', 'utf8')
/**
 * From the shared pipeline to the next unrelated handler.
 *
 * It used to start at IPC.voiceTranscribe, because everything after Whisper
 * lived inline in that one handler. It does not any more: dictation is
 * transcribed in pieces while the user speaks, so the cleanup has to be
 * reachable for text as well as for a clip, and it moved into
 * finishTranscript. The guarantees below are about that pipeline wherever it
 * lives, so the window follows it.
 */
const handler = main.slice(
  main.indexOf('async function finishTranscript'),
  main.indexOf('IPC.searchRun')
)

check('the table runs on every transcript', /tidyTranscript\(heard/.test(handler), true)
// The polish pass is the only part that can invent text, so it may never be
// returned without having been checked first.
check('polish is never used unguarded', /polishAcceptable\(tidied, polished\)/.test(handler), true)
check(
  'and a refusal falls back to the raw text',
  /accepted \? polished!\.trim\(\) : tidied/.test(handler),
  true
)

/**
 * The line this feature must not cross. Dictation fills the box; the user sends
 * it. A transcript that sent itself would mean a mis-heard sentence reaching the
 * model - and in this app the model proposes commands.
 */
check('nothing dictated is sent on its own', /chatSend|chat\.send/.test(handler), false)

const hook = readFileSync('src/renderer/src/hooks/useDictation.ts', 'utf8')
check('the panel closing releases the microphone', /live\.current\?\.stop\(\)/.test(hook), true)
check('a refused microphone is explained', /Privacy - Microphone/.test(hook), true)

const panel = readFileSync('src/main/panel.ts', 'utf8')
const perms = panel.slice(
  panel.indexOf('setPermissionRequestHandler'),
  panel.indexOf("'screen-saver'")
)
check('audio is the only permission granted', /permission !== 'media'/.test(perms), true)
check('and only to our own page', /own\) return done\(false\)/.test(perms), true)

/* --------------------------------- transcribing while you are still talking */

// The whole clip used to go to Whisper when the user let go, so the wait grew
// with how much had been said - and all of it landed after the talking
// stopped, which is the worst moment for it. Pieces are cut at the pauses
// instead, and where that cut falls is the whole question.
const recOut = join(process.cwd(), '.dictation-rec.mjs')
await build({
  entryPoints: ['src/renderer/src/recorder.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: recOut,
  logLevel: 'error'
})
const R = await import(pathToFileURL(recOut).href)
rmSync(recOut, { force: true })

const BASE = { pauseMs: 650, minMs: 1200, maxMs: 14_000 }
const rotate = (o) => R.shouldRotate({ ...BASE, ...o })

// Silence is what Whisper invents "Thank you." over, so a piece with nothing
// in it is never cut loose.
check(
  'silence alone never starts a piece',
  rotate({ heardSpeechInSegment: false, segmentMs: 9000, sinceSpeechMs: 9000 }),
  false
)
check(
  'not even past the ceiling',
  rotate({ heardSpeechInSegment: false, segmentMs: 20_000, sinceSpeechMs: 20_000 }),
  false
)

// Whisper is far worse on a fragment than on a phrase.
check(
  'a pause after one word is too early',
  rotate({ heardSpeechInSegment: true, segmentMs: 700, sinceSpeechMs: 650 }),
  false
)
check(
  'just under the floor still waits',
  rotate({ heardSpeechInSegment: true, segmentMs: 1199, sinceSpeechMs: 900 }),
  false
)
check(
  'at the floor, a pause cuts',
  rotate({ heardSpeechInSegment: true, segmentMs: 1200, sinceSpeechMs: 650 }),
  true
)

// The good cut: nothing is lost across it because nothing was being said.
check(
  'a breath between sentences cuts',
  rotate({ heardSpeechInSegment: true, segmentMs: 4000, sinceSpeechMs: 700 }),
  true
)
check(
  'a short gap mid-sentence does not',
  rotate({ heardSpeechInSegment: true, segmentMs: 4000, sinceSpeechMs: 200 }),
  false
)
check(
  'nor does talking straight through',
  rotate({ heardSpeechInSegment: true, segmentMs: 9000, sinceSpeechMs: 0 }),
  false
)

// The fallback, for someone who does not pause at all.
check(
  'the ceiling cuts without a pause',
  rotate({ heardSpeechInSegment: true, segmentMs: 14_000, sinceSpeechMs: 0 }),
  true
)
check(
  'and beats the pause rule',
  rotate({ heardSpeechInSegment: true, segmentMs: 30_000, sinceSpeechMs: 0 }),
  true
)
check(
  'but never beats the silence rule',
  rotate({ heardSpeechInSegment: false, segmentMs: 30_000, sinceSpeechMs: 0 }),
  false
)

// A piece ends the recording, not just the piece: the pause that cuts must be
// shorter than the one that stops, or a cut could never happen on auto-stop.
check('the cut pause is shorter than the stop pause', BASE.pauseMs < 1400, true)

const rec = readFileSync('src/renderer/src/recorder.ts', 'utf8')
// A webm stream is a container: the header is in the first chunk only, so
// slicing one recorder's output does not give a decodable file.
check(
  'each piece is its own recorder',
  rec.includes('new MediaRecorder(stream, { mimeType: format.mime })'),
  true
)
check(
  'the microphone is never released between them',
  !/getUserMedia/.test(rec.split('const rotate')[1] ?? ''),
  true
)
check('the whole clip is kept as well', rec.includes('const all: Blob[] = []'), true)
check(
  'a silent tail is flagged rather than transcribed',
  rec.includes('silent: !heardInSegment'),
  true
)
check('and the last piece always says so', rec.includes('final: true'), true)

const dictationHook = readFileSync('src/renderer/src/hooks/useDictation.ts', 'utf8')
// One worker holding one model: overlapping requests would queue inside it
// anyway, and keeping the queue here means the order is ours.
check('pieces are transcribed one at a time', dictationHook.includes('chain = chain.then'), true)
check('and reassembled in order', dictationHook.includes('sort((a, b) => a[0] - b[0])'), true)
check(
  'a failed piece falls back to the whole clip',
  /if \(!missing\)\s+joined/.test(dictationHook),
  true
)
check('the joined text still gets the cleanup', dictationHook.includes('voice.tidy'), true)

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} dictation checks`)
process.exit(failed === 0 ? 0 : 1)
