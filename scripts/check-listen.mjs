/**
 * `/listen`: hearing the machine, and the three promises that go with it.
 *
 * Asked for as meeting notes - "allow the AI to listen to computer audio...
 * during meetings, it's able to get the summary, notes, specific details".
 *
 * The feature itself cannot be checked without a meeting, but the three
 * things it promises can, and each of them is a promise that would be
 * expensive to break quietly:
 *
 *   NO PICTURE IS EVER TAKEN. `getDisplayMedia` is a video API and refuses a
 *   request with no video in it, so a screen source has to be named to get
 *   at the loopback audio. The video track is stopped before a frame can be
 *   decoded. If that line is ever removed, this app starts capturing the
 *   screen on a command whose name says audio - so it is pinned here, from
 *   both directions.
 *
 *   NO AUDIO IS KEPT. What accumulates is text and a clock. An hour of
 *   meeting is tens of kilobytes rather than thirty megabytes of Opus in
 *   temp, and nothing survives the session to be found later.
 *
 *   IT DOES NOT SAY WHO SPOKE. The microphone and the loopback tap are
 *   summed into one channel, so there is no way to tell them apart - and a
 *   model handed an unattributed transcript will happily write "Alice said".
 *   The prompt forbids it in words, because that is the only place it can be
 *   forbidden.
 *
 * Run with: node scripts/check-listen.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.listen-check.mjs')
await build({
  entryPoints: ['src/shared/meeting.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const M = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  const shown = JSON.stringify(got)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(what).padEnd(52)} ${shown?.length > 44 ? `${shown.slice(0, 44)}…` : shown}`)
  if (!ok) console.log(`     expected ${JSON.stringify(want)}`)
}

const read = (f) => readFileSync(f, 'utf8')
const loopback = read('src/renderer/src/loopback.ts')
const panel = read('src/main/panel.ts')
const hook = read('src/renderer/src/hooks/useListening.ts')
const recorder = read('src/renderer/src/recorder.ts')
const app = read('src/renderer/src/App.tsx')

/* ------------------------------------------------- no picture is ever taken */

check('main answers the request with loopback audio', /audio: 'loopback'/.test(panel), true)
check('and only for our own page', /!request\.frame\.url\.startsWith\('file:'\)/.test(panel), true)
check('the renderer stops the video track', /track\.stop\(\)/.test(loopback), true)
check('and removes it from the stream', /stream\.removeTrack\(track\)/.test(loopback), true)
/* Before anything can decode a frame: the stop must come before the function
   hands the stream to anyone. */
check(
  'before the stream leaves the function',
  loopback.indexOf('stream.removeTrack(track)') < loopback.indexOf('return stream'),
  true
)
/* Nothing reads pixels. A canvas, a video element or a frame grab appearing
   in this file would mean the command quietly grew a screenshot. */
for (const forbidden of ['createElement', 'canvas', 'drawImage', 'getVideoTracks()[0].clone']) {
  check(`nothing in loopback does ${forbidden}`, loopback.includes(forbidden), false)
}
/* And sound with no picture is still a failure worth naming rather than a
   silent empty recording. */
check('no audio is reported, not ignored', /no sound/.test(loopback), true)

/* ------------------------------------------------------ no audio is kept */

check('pieces are transcribed, not stored', /voice\.transcribe\(/.test(hook), true)
check('and what is kept is text and a clock', /piecesRef\.current\.push\(\{ at/.test(hook), true)
/* Nothing writes a file. A meeting that left an hour of Opus in temp would
   be a different feature from the one described. */
for (const forbidden of ['saveAs', 'writeFile', 'createObjectURL', 'download']) {
  check(`nothing in the session does ${forbidden}`, hook.includes(forbidden), false)
}

/* ---------------------------------------- a meeting is not a dictation */

/**
 * The recorder is shared and the timings are not. Dictation ends 1.4s after
 * you stop talking; doing that to a meeting would end the session every time
 * somebody thought about an answer.
 */
check('listening never ends by itself', /silenceMs: null/.test(hook), true)
check('and has a ceiling so a forgotten session cannot run for ever', /maxMs: MAX_MS/.test(hook), true)
check('four hours of it', /4 \* 60 \* 60 \* 1000/.test(hook), true)
/* Longer pieces: nobody is waiting, and Whisper is markedly better on a
   whole sentence than on a fragment. */
check('pieces are cut at a longer pause', /segmentPauseMs: 1_200/.test(hook), true)
check('and are allowed to be half a minute', /maxSegmentMs: 30_000/.test(hook), true)
/* The recorder only closes a stream it opened: the mixing graph has more to
   tear down than tracks, and the caller owns it. */
check('a supplied stream is not closed by the recorder', /if \(ours\) for \(const track of stream\.getTracks/.test(recorder), true)
check('and the graph is closed by whoever built it', /void ctx\.close\(\)/.test(loopback), true)

/*
 * The last piece is still inside Whisper when the recording stops, and it is
 * usually the one that matters - what was said just before somebody reached
 * for the keyboard.
 */
check('stopping waits for the piece in flight', /await chain\.current/.test(hook), true)

/* Two full-scale sources summed into one channel clip, and clipping is the
   one distortion Whisper handles badly. */
check('the two sources are halved before mixing', /gain\.gain\.value = 0\.5/.test(loopback), true)

/* ------------------------------------------------------ the transcript */

const session = {
  startedAt: 0,
  pieces: [
    { at: 0, text: 'Right, shall we start.' },
    { at: 30_000, text: 'The deadline moved to the fourteenth.' },
    { at: 95_000, text: 'Sam is picking up the migration.' }
  ]
}

check('mm:ss while it is short', M.stamp(95_000), '1:35')
check('and h:mm:ss once there is an hour', M.stamp(3_725_000), '1:02:05')
check('the transcript carries the words', M.transcriptText(session).includes('fourteenth'), true)
/* Stamps are what make a detail findable afterwards, but one per piece would
   be a stamp every few seconds. One per minute of elapsed audio. */
check('stamped at the start', M.transcriptText(session).startsWith('[0:00]'), true)
check('and again a minute later', M.transcriptText(session).includes('[1:35]'), true)
check('but not for the piece 30s in', M.transcriptText(session).includes('[0:30]'), false)

check('words are counted', M.countWords('the deadline moved'), 3)

/*
 * Below the threshold there is nothing to summarise, and saying so beats a
 * paragraph of invention: a model given ten seconds of speech and asked for
 * "the key decisions" will produce key decisions.
 */
check('ten seconds of speech is not a meeting', M.wordCount({ startedAt: 0, pieces: [{ at: 0, text: 'hello is this thing on' }] }) < M.ENOUGH_WORDS, true)
check('and the panel checks before asking', /wordCount\(heard\) < ENOUGH_WORDS/.test(app), true)

/* ------------------------------------------- what the model is told not to do */

check('no speaker may be invented', /cannot tell who is speaking/.test(M.NOTES_PROMPT), true)
check('no name or number may be repaired', /Never repair a name or a number/.test(M.NOTES_PROMPT), true)
check('no action item may be invented to fill a heading', /Never invent an action item/.test(M.NOTES_PROMPT), true)
check('garbled things are quoted, not guessed', /quote it as heard/.test(M.NOTES_PROMPT), true)

/* The question form shares the prompt rather than having its own, so the
   guard-rails cannot drift apart. */
check('a question carries the transcript too', M.notesRequest(session, 'what moved?').includes('fourteenth'), true)
check('and says what was asked', M.notesRequest(session, 'what moved?').startsWith('Answer this about the transcript'), true)
check('while bare asks for the notes', M.notesRequest(session).startsWith('Write the notes.'), true)

/* ------------------------------------------------------- what is said out loud */

/*
 * This opens a tap on everything the machine is playing and, by default, on
 * the microphone too - which in a call is every other person in it. Saying so
 * once, in plain words, at the moment it starts is the whole of the consent
 * story this app can offer, so it is not allowed to disappear in a tidy-up.
 */
check('starting says what it is listening to', /Listening\*\* to \$\{what\}/.test(app), true)
check('and that nothing is saved', /no audio is saved/.test(app), true)
check('and that it cannot say who spoke', /cannot say who said what/.test(app), true)
check('and whose permission is not Wumpy’s to give', /consent where you are/.test(app), true)

console.log(`\n${failed === 0 ? `all ${0 + 1 ? '' : ''}listen checks correct` : `${failed} listen checks FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
