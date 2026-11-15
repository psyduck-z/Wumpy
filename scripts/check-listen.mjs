/**
 * Hearing the machine, and the three promises that go with it.
 *
 * Asked for as meeting notes - "allow the AI to listen to computer audio...
 * during meetings, it's able to get the summary, notes, specific details".
 *
 * There is no `/listen` any more: "remove the command, i like it when i ask
 * it directly". So the way in is a sentence, and the sentence is checked by
 * running the matcher rather than reading its regex - a pattern that
 * compiles and matches nothing would pass a source assertion and fail a
 * user, which is exactly how this was reported.
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

/* --------------------------------------- the gate in front of that handler */

/**
 * THE PERMISSION RULE, WHICH REFUSED THE WHOLE FEATURE.
 *
 * Reported as a panel saying "Could not start listening." and nothing else.
 * The handler above was never reached: Chromium asks the embedder first, and
 * the rule there was written when the microphone was all there was.
 *
 * The three shapes, measured on Electron 44 rather than assumed - a probe
 * that logged the request and refused it, so nothing was captured to find
 * them out:
 *
 *   getUserMedia({ audio })   mediaTypes ['audio']   allowed
 *   getUserMedia({ video })   mediaTypes ['video']   refused, and should be
 *   getDisplayMedia(...)      mediaTypes []          REFUSED, and should not
 *
 * `length === 1` excluded the empty list, and the empty list is the only
 * shape getDisplayMedia arrives in. So this is pinned from both sides: the
 * empty one goes through, the camera does not.
 */
{
  /* From the call, not from the comment above it - the doc block names
     setDisplayMediaRequestHandler, so an indexOf from the top of the file
     found the mention and sliced backwards into nothing. */
  const from = panel.indexOf('session.setPermissionRequestHandler')
  const rule = panel.slice(from, panel.indexOf('session.setDisplayMediaRequestHandler', from))
  check('the rule was found at all', rule.length > 100, true)
  check('an empty mediaTypes is granted', /types\.length === 0\) return done\(true\)/.test(rule), true)
  check('and absent still is', /types === undefined \|\|/.test(rule), true)
  check('audio alone is granted', /types\.length === 1 && types\[0\] === 'audio'/.test(rule), true)
  /* Which leaves ['video'] - the camera - as the one shape this gate can
     see and refuses. It is not allowed to become "anything our page asks". */
  check('nothing grants a bare video request', /types\[0\] === 'video'/.test(rule), false)
  check('and a page that is not ours gets nothing', /if \(!own\) return done\(false\)/.test(rule), true)
}

/*
 * And refusing the display request is a thing that THROWS, so it may only
 * happen once. `callback({})` raises "Video was requested, but no video
 * stream was provided"; inline in the `.then` that threw into the `.catch`,
 * which refused again - "One-time callback was called more than once", an
 * unhandled rejection, with the renderer still waiting.
 */
check('a refusal is answered once', /const refuse = \(why: string\)/.test(panel), true)
check('and says why into the log', /console\.warn\(`\[listen\] \$\{why\}`\)/.test(panel), true)
check('the renderer stops the video track', /track\.stop\(\)/.test(loopback), true)
check('and removes it from the stream', /stream\.removeTrack\(track\)/.test(loopback), true)
/* Before anything can decode a frame: the stop must come before the function
   hands the stream to anyone. */
/* Sliced out first, rather than indexOf over the whole file: `return stream`
   also begins `return stream.getAudioTracks()` in the labels helper, which
   sits above this and made the comparison pass on the wrong line. */
{
  const from = loopback.indexOf('async function systemAudio')
  const fn = loopback.slice(from, loopback.indexOf('\n}', from))
  check('the function was found at all', fn.length > 100, true)
  check(
    'before the stream leaves the function',
    fn.indexOf('stream.removeTrack(track)') < fn.indexOf('\n  return stream'),
    true
  )
}
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
/* ------------------------------------------- and a failure says which one */

/**
 * THE REASON IS RETURNED, NOT READ BACK OFF A RENDER.
 *
 * `start` used to answer true or false, and the caller read
 * `listening.error` on the next line. That is React state, and the
 * `listening` object the caller holds is the one from the render still on
 * screen - so it held what was there BEFORE the call: null. Every failure,
 * whatever it was, printed the fallback "Could not start listening." and
 * threw the real reason away one line after working it out.
 *
 * Which is how a permission rule refusing the loopback request went
 * unexplained for as long as it did. A reason that is returned cannot be
 * stale, and the log gets a copy either way.
 */
check('start hands back the reason', /start\(source: AudioSource\): Promise<string \| null>/.test(hook), true)
check('and the panel prints what it was handed', /const why = await listening\.start\(want\)/.test(app), true)
check('not what the last render happened to hold', /listening\.error \?\?/.test(app), false)
/* Including the silent one: already listening used to return false with no
   reason set at all, which is the only way the fallback was ever honest. */
check('every refusal has words on it', /return failed\('Already listening\.'\)/.test(hook), true)
check('and every one of them reaches the log', /console\.warn\(`\[listen\] \$\{why\}`\)/.test(hook), true)
/* A NotAllowedError here is not Windows saying no - there is no per-app
   permission for loopback and no privacy toggle for it. Sending the reader
   to the Windows settings was sending them away from the bug. */
check('a refusal does not blame Windows', /Windows did not allow/.test(hook), false)
check('it names what threw', /The capture was refused \(\$\{name/.test(hook), true)

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

/* ------------------------------------- the mix, and the silence it caused */

/**
 * CLIPPING IS LIMITED, NOT PAID FOR IN ADVANCE.
 *
 * Two full-scale sources summed into one channel clip, and clipping is the
 * one distortion Whisper handles badly. The first answer was a gain of 0.5
 * on each, which is arithmetically sound and was the bug: the recorder's
 * speech gate is an ABSOLUTE threshold calibrated on an un-halved
 * microphone, so in `both` - the default - it effectively sat at 0.04,
 * inside the band its own comment calls ordinary speech. Under it nothing
 * is cut, nothing reaches Whisper, and a transcribed meeting reports that
 * it heard nothing but silence.
 *
 * So the halving is pinned OUT as well as the limiter in. A future tidy-up
 * that "simplifies" the limiter back to a pair of gains would restore a
 * fault whose only symptom is an empty transcript.
 */
check('nothing scales a source down to pay for the sum', /gain\.value = 0\.5/.test(loopback), false)
check('a limiter sits in front of the destination', /createDynamicsCompressor\(\)/.test(loopback), true)
check('and the destination is behind it', /limiter\.connect\(mixed\)/.test(loopback), true)
check('both sources go through it', /\.connect\(limiter\)/.test(loopback), true)
/* Only the top of the range, and hard, or it is a compressor rather than a
   limiter - and a compressor with a soft knee quietens ordinary speech
   again, which is the whole fault this replaced. */
check('it only acts near full scale', /threshold\.value = -3\b/.test(loopback), true)
check('with no knee', /knee\.value = 0\b/.test(loopback), true)
check('at a limiting ratio', /ratio\.value = 20\b/.test(loopback), true)
/* DynamicsCompressorNode has no makeup gain of its own, so nothing quiet is
   lifted either and the noise floor stays where the gate expects it. A gain
   node reappearing in this file is how that would be undone - in either
   direction, since the fault being pinned out was also a gain node. */
check('and no gain node is left in the graph', /createGain\(\)/.test(loopback), false)

/* -------------------------------------- and it says what it is hearing */

/**
 * A LONG LISTEN WROTE NOTHING ANYWHERE.
 *
 * Every `[listen]` line in the codebase was on a failure path, so a session
 * that started cleanly and transcribed nothing left a log identical to one
 * that was never started - and that was the whole of the evidence available
 * when a meeting was reported as having been heard as silence. Three facts
 * fix it, and each is pinned because each would be easy to drop in a tidy-up
 * and impossible to miss the absence of until the next time.
 */
const types = read('src/shared/types.ts')
const main = read('src/main/index.ts')
const preload = read('src/preload/index.ts')
check('there is a channel for it', /listenLog: 'listen:log'/.test(types), true)
check('the renderer can send on it', /ipcRenderer\.send\(IPC\.listenLog/.test(preload), true)
/* One way. A heartbeat that can wait on the main process is a heartbeat
   that can stall the session it is reporting on. */
check('and cannot wait on it', /invoke\(IPC\.listenLog/.test(preload), false)
check('main writes it to the log file', /ipcMain\.on\(IPC\.listenLog/.test(main), true)
/* Renderer text straight into a log file: a newline would forge a
   timestamped line, and an unbounded string could put the meeting in it. */
check('flattened before it is written', /replace\(\/\\s\+\/g, ' '\)/.test(main), true)
check('and capped', /\.slice\(0, 300\)/.test(main), true)

check('the session says what devices it opened', /started \(\$\{want\}\) on /.test(hook), true)
check('and what it got, every so often', /const BEAT_MS = 30_000/.test(hook), true)
check('on a timer that starts with the session', /setInterval\(beat, BEAT_MS\)/.test(hook), true)
/* An hour-long interval outliving the panel is the one leak this hook can
   have, so it is cleared from stop AND from an unmount. */
check('and is cleared when it stops', /stopBeat\(\)/.test(hook), true)
check('and on unmount', /useEffect\(\(\) => stopBeat/.test(hook), true)
/* The line this was all for: a peak that never reaches the gate means
   nothing was ever cut, which is indistinguishable from an empty room
   everywhere else. */
check(
  'a session under the gate says so in those words',
  /never once above the \$\{SPEECH_LEVEL\} speech gate/.test(hook),
  true
)
check('against the same constant the gate uses', /export const SPEECH_LEVEL/.test(recorder), true)
check('and the hook reads that one', /SPEECH_LEVEL/.test(hook), true)
/* No audio is kept, and that goes for the log too: it carries levels,
   counts and device names, never a transcript. */
for (const forbidden of ['transcriptText', 'piece.text', 'part.text']) {
  check(`the log never carries ${forbidden}`, new RegExp(`say\\([^)]*${forbidden}`).test(hook), false)
}

/* ------------------------------------------------- and it is on screen */

/**
 * A meter, because an open microphone showing nothing is a thing you have
 * to take on faith for an hour. Dictation has had one from the beginning;
 * this ran for hours with none, and `onLevel` was simply never passed.
 */
check('the recorder reports the raw level too', /onLevel\?\.\(Math\.min\(1, Math\.sqrt\(level \* 8\)\), level, speech\)/.test(recorder), true)
check('and the session asks for it', /onLevel: \(shown, raw, speech\)/.test(hook), true)
/* Quantised before it reaches state: the level arrives on every animation
   frame, and a meeting is an hour of them. */
check('quantised before it becomes state', /const BARS = 16/.test(hook), true)
check('and only set when the step changes', /if \(step === stepRef\.current\) return/.test(hook), true)

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
 *
 * THE WRITE-UP IS ALL IT GATES. It used to gate everything, and that is the
 * bug behind "allow it to answer while its listening": eleven seconds into a
 * session, "what are we doing" - the question this whole feature is for -
 * was sent with no transcript attached, because eight words was under
 * thirty. A question cannot invent a summary; it can only be answered badly
 * without the thing it is about.
 */
const thin = { startedAt: 0, pieces: [{ at: 0, text: 'hello is this thing on' }] }
check('ten seconds of speech is not a meeting', M.wordCount(thin) < M.ENOUGH_WORDS, true)
check('the write-up still waits for enough', /wantsNotes\(text\) && wordCount\(heard\) < ENOUGH_WORDS/.test(app), true)
check('and so does the chip that asks for it', /!heard \|\| wordCount\(heard\) < ENOUGH_WORDS/.test(app), true)
/* But a question gets what there is, however little that is. */
check('a question on a thin transcript still carries it', M.meetingTurn(thin, 'what are we doing').includes('is this thing on'), true)
check('and says how little there is', M.meetingTurn(thin, 'what are we doing').includes('5 words'), true)

/* ------------------------------------------- what the model is told not to do */

/**
 * THE RULES ARE IN THE REQUEST, not merely in a constant.
 *
 * These four were asserted against `NOTES_PROMPT` for a day, and
 * `NOTES_PROMPT` reached no model: `notesRequest` built a head and a
 * transcript and left the rules sitting in the file. Four green checks over
 * a prompt nothing sent, which is the exact failure a source assertion is
 * supposed to catch.
 *
 * So they are checked on the string that actually goes out, and on BOTH
 * shapes of it - the write-up and an ordinary question - because the
 * transcript now rides along on every message and the guard-rails have to
 * ride with it.
 */
for (const [shape, text] of [
  ['the notes', M.meetingTurn(session)],
  ['a question', M.meetingTurn(session, 'what moved?')]
]) {
  check(`${shape}: no speaker may be invented`, /cannot tell who is speaking/.test(text), true)
  check(`${shape}: no name or number repaired`, /Never repair a name or a number/.test(text), true)
  check(`${shape}: nothing invented to fill a heading`, /Do not invent detail/.test(text), true)
  check(`${shape}: garbled things are quoted`, /quote it as heard/.test(text), true)
  check(`${shape}: and the transcript is there`, text.includes('fourteenth'), true)
}

/* The write-up asks for the headings; a question does not. */
check('the notes ask for a summary', M.meetingTurn(session).includes('**Summary**'), true)
check('a question does not', M.meetingTurn(session, 'what moved?').includes('**Summary**'), false)
check('and is passed through as typed', M.meetingTurn(session, 'what moved?').includes('what moved?'), true)

/*
 * THE TRANSCRIPT IS ON EVERY MESSAGE, so it is also on "what is the
 * weather". The model is told, in as many words, that a message which is
 * not about the meeting is an ordinary message - without that line this
 * feature answers unrelated questions out of somebody's standup.
 */
check('an off-topic message may ignore it', /ignore the transcript entirely/.test(M.meetingTurn(session, 'what is the weather')), true)

/*
 * "notes" is the one word anyone was told to remember, and it arrives as an
 * ordinary message like everything else. It has to land on the write-up
 * rather than being passed through as a question.
 */
check('notes means the write-up', M.wantsNotes('notes'), true)
check('so does a recap', M.wantsNotes('Recap'), true)
check('and it reaches the headings', M.meetingTurn(session, 'notes').includes('**Decisions**'), true)
/* But a SENTENCE with the word in it is a sentence. */
check('a question about notes is a question', M.wantsNotes('what notes did they take'), false)

/* --------------------------------------------- nothing to remember */

/**
 * NOTHING TO REMEMBER, and by now that is literal.
 *
 * The complaint, in the user's words: "/listen what did they say about the
 * deadline... that's too long. How am I supposed to remember this?" The
 * argument went first, then the word: "remove the command, i like it when i
 * ask it directly."
 *
 * So there is no command, and nothing may quietly put one back - a slash
 * command that exists is a slash command the help, the palette and the
 * clickable chips all start teaching again.
 */
const commands = read('src/renderer/src/commands.ts')
check('there is no listen command', /name: 'listen'/.test(commands), false)
check('nor one hiding under another name', /aliases: \[[^\]]*'(?:meeting|call)'/.test(commands), false)
check('and nothing offers it as a button', /^\s*'listen',$/m.test(commands), false)
/* The ACTION stays: the status bar's one button and the intents below both
   build it, and App.tsx still has the whole of the session in it. */
check('but the action it built is still there', /kind: 'listen'; what:/.test(commands), true)
check('and the panel still runs one', /kind: 'listen', what: listening\.on/.test(app), true)

/* Run the matcher rather than reading its regex: a pattern that compiles
   and matches nothing would pass a source assertion and fail a user. */
await build({
  entryPoints: ['src/renderer/src/intents.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.listen-intents.mjs',
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const { matchIntent } = await import(pathToFileURL(join(process.cwd(), '.listen-intents.mjs')).href)
rmSync('.listen-intents.mjs', { force: true })

/*
 * THE SENTENCE THAT WAS REPORTED, first.
 *
 * "listen and summarise content in this meeting" reached the model, which
 * said "I can't listen to audio directly" - a flat denial of a feature that
 * was running in the same window. The old pattern wanted the object to come
 * straight after the verb, so four words in the middle of it were enough to
 * miss. Words between the two are now anything at all; the object is still
 * required.
 */
for (const said of [
  'listen and summarise content in this meeting',
  'listen to the meeting',
  'start listening to this call',
  'take notes of this meeting',
  'please start listening to the call',
  'listen to this call and take notes',
  'can you listen to this meeting'
]) {
  const got = matchIntent(said)
  check(`"${said}" starts it`, got && got.kind === 'listen' && got.what === 'toggle', true)
}
/*
 * And it starts what was actually named.
 *
 * "listen to my speakers" used to build the same toggle as everything else,
 * which opens the microphone too - in a call, every other person in the
 * room, from a sentence that asked for one side of it. Naming a source was
 * the one argument `/listen` had that was worth keeping, so it is kept, in
 * words.
 */
for (const [said, want] of [
  ['listen to my speakers', 'system'],
  ['listen to the system audio', 'system'],
  ['listen to my microphone', 'mic'],
  ['take notes from my mic', 'mic']
]) {
  const got = matchIntent(said)
  check(`"${said}" opens that one`, got && got.what === 'source' && got.ask === want, true)
}
/* A meeting is both halves of a meeting, and so is naming neither. */
check('a meeting is both', matchIntent('listen to the meeting')?.what, 'toggle')

for (const said of ['stop listening', 'stop taking notes', 'end the meeting']) {
  const got = matchIntent(said)
  check(`"${said}" ends it`, got && got.kind === 'listen' && got.what === 'stop', true)
}
/* And an ordinary sentence is still an ordinary sentence. A bare "listen"
   is a thing people say mid-conversation, which is why the object is
   required - short-circuiting the model is only free when the phrasing
   cannot mean anything else. */
for (const said of ['listen', 'listen to what I am telling you', 'can you listen to this file']) {
  check(`"${said}" is not a command`, matchIntent(said)?.kind ?? null, null)
}
/*
 * And the thing to listen to can be a THING, which is not this feature.
 *
 * Each of these reaches an object word and none of them means open a live
 * tap on the speakers. They go to the model, which handles a file well: it
 * can be pointed at one.
 */
for (const said of [
  'can you listen to this audio file',
  'listen to the recording of the meeting',
  'take notes from this call recording',
  'listen to this mp3'
]) {
  check(`"${said}" is for the model`, matchIntent(said)?.kind ?? null, null)
}

check('an ordinary message carries the transcript', /chat\.send\(meetingTurn\(heard, text\), text, images\)/.test(app), true)
/*
 * FROM THE FIRST WORD, and while it is live even from none.
 *
 * The thirty-word gate used to stand here too, so the first half-minute of
 * every session answered questions about the meeting without the meeting -
 * which is what "allow it to answer while its listening" was reporting. An
 * empty transcript is still worth sending while the tap is open: it is the
 * honest answer to "what are we doing" in the first few seconds, and
 * `meetingTurn` says so in words rather than sending an empty heading.
 */
check('while it is listening, every message carries it', /heard && \(listening\.on \|\| wordCount\(heard\) > 0\)/.test(app), true)
check('an empty transcript says it is empty', M.meetingTurn({ startedAt: 0, pieces: [] }, 'what are we doing').includes('Nothing has been transcribed yet'), true)
/* And claims no duration it cannot measure: `elapsed` is where the last
   piece sat, and with no pieces there is no "about 1 minute" to invent. */
check('and claims no length', /minute/.test(M.meetingTurn({ startedAt: 0, pieces: [] }, 'what are we doing')), false)
check('a transcript is timed by its audio', M.meetingTurn(session, 'what moved?').includes('1:35 in, '), true)
/* And it belongs to this conversation: left behind, an hour of somebody's
   standup would ride along on an unrelated chat with no sign of it. */
check('a new chat forgets it', /listening\.forget\(\)/.test(app), true)

/*
 * And it is on screen while it is on, which is the other half of having
 * nothing to remember: a session you can see is one you cannot forget is
 * running, or forget is being attached to what you type.
 */
const status = read('src/renderer/src/components/StatusBar.tsx')
check('the panel shows that it is listening', /className=\{`listening/.test(status), true)
check('with how much it has', /\$\{listening\.words\} words/.test(status), true)
check('and says the transcript is being sent', /carries the transcript/.test(status), true)

/**
 * AND IT SHOWS WHILE IT IS ON, NOT ONLY ONCE IT HAS WORDS.
 *
 * The gate was `wordCount > 0`, which hid the pill for exactly the case the
 * pill exists for: a live session that has heard nothing, attaching an empty
 * transcript to every turn with nothing on screen to say so. A finished
 * transcript still needs words to be worth a chip; a live one does not.
 */
check('a live session shows even at nothing', /listening\.on \|\| wordCount\(listening\.session\) > 0/.test(app), true)
check('and the meter rides along with it', /level: listening\.level/.test(app), true)
check('drawn only while live', /listening\.live && \(\s*<span className="listening-meter"/.test(status), true)
/* Scaled rather than resized: composited, and it moves for as long as the
   meeting does. */
check('and scaled, not re-laid-out', /transform: `scaleX\(/.test(status), true)
/* Never a bar of nothing: a meter pinned at zero reads as broken rather
   than as quiet. */
check('with a floor so it is visibly present', /Math\.max\(0\.02, listening\.level\)/.test(status), true)
check('the title says so when there is nothing yet', /nothing transcribed yet/.test(status), true)
const css = read('src/renderer/src/styles.css')
check('the meter has a width to be seen in', /\.listening-meter \{[^}]*width: 20px/.test(css), true)

/* ------------------------------------------------------- what is said out loud */

/*
 * This opens a tap on everything the machine is playing and, by default, on
 * the microphone too - which in a call is every other person in it. Saying so
 * once, in plain words, at the moment it starts is the whole of the consent
 * story this app can offer, so it is not allowed to disappear in a tidy-up.
 */
check('starting says what it is listening to', /Listening\*\* to \$\{what\}/.test(app), true)
check('and that nothing is saved', /no audio/.test(app), true)
check('and that it cannot say who spoke', /cannot say who spoke/.test(app), true)
check('and whose permission is not Wumpy’s to give', /consent where you are/.test(app), true)

console.log(`\n${failed === 0 ? `all ${0 + 1 ? '' : ''}listen checks correct` : `${failed} listen checks FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
