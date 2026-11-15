/**
 * A voice turn you can see and hear working.
 *
 * Asked for in these words: "it isn't responding or anything. Make the
 * process something I can see, not a background process." And: "after I
 * send it, sometimes the AI takes some time... like the three dots
 * loading... tut, tut, tut... at least it gives me active feedback that I
 * know it's thinking and it's working."
 *
 * What was found first: eight gestures reached Wumpy and nothing after that
 * was ever logged. The recorder's speech detection ran on animation frames
 * whenever the page said it was visible - and on Wayland a window on another
 * workspace is "visible" but gets no frames, so nothing said was noticed and
 * the turn gave up after eight seconds, silently.
 *
 * The store is run; the rest is wiring, since a check has no microphone.
 *
 * Run with: node scripts/check-voicebar.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.voicebar-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    external: ['react']
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
const read = (f) => readFileSync(f, 'utf8')

/* ----------------------------------------------------------- the store */

const V = await load('src/renderer/src/voiceview.ts', 'view')
check('idle to begin with', V.voiceView().stage, 'idle')
V.showVoice({ stage: 'listening', level: 0.5 })
check('a stage is shown', V.voiceView().stage, 'listening')
V.showVoice({ level: 0.7 })
check('the level moves without changing the stage', [V.voiceView().stage, V.voiceView().level], ['listening', 0.7])
V.showVoice({ stage: 'thinking', heard: 'slash model' })
check('what it heard is kept', V.voiceView().heard, 'slash model')
check('a finished stage fades', ['done', 'nothing', 'cancelled', 'error'].every((s) => V.FINISHED.has(s)), true)
check('a working stage does not', ['listening', 'thinking', 'speaking'].some((s) => V.FINISHED.has(s)), false)
let stopped = 0
V.setVoiceStopper(() => stopped++)
V.stopVoice()
check('the bar’s Stop reaches the turn', stopped, 1)

/* ---------------------------------------------- the bug that hid it all */

const recorder = read('src/renderer/src/recorder.ts')
check('speech detection never waits on animation frames', /requestAnimationFrame\(/.test(recorder), false)
check('it runs on a timer, wherever the window is', /id: window\.setTimeout\(cb, 40\)/.test(recorder), true)

/* --------------------------------------------------------------- seeing */

const main = read('src/main/index.ts')
const turn = read('src/renderer/src/hooks/useVoiceTurn.ts')
const app = read('src/renderer/src/App.tsx')
const bar = read('src/renderer/src/components/VoiceTurnBar.tsx')
const css = read('src/renderer/src/styles.css')

/* It brought the window up while the faults were being found, and runs in
   the background again now that it works - asked for both ways. */
check('a voice turn runs in the background', /function startVoiceTurn[\s\S]{0,400}panel\.show\(/.test(main), false)
check('the bar is on the page', app.includes('<VoiceTurnBar />'), true)
check('it shows the mic level while listening', /stage === 'listening' && \(\s+<span className="voice-turn-meter"/.test(bar), true)
check('and has a Stop', bar.includes('onClick={stopVoice}'), true)
check('and is styled', css.includes('.voice-turn {'), true)
for (const stage of ['starting', 'listening', 'hearing', 'thinking', 'speaking', 'done', 'nothing', 'cancelled', 'error']) {
  check(`the turn reaches "${stage}"`, turn.includes(`stage: '${stage}'`), true)
}
check('silence says whether the mic heard anything', /lastPeak < lastBar/.test(turn), true)
check('a mic that will not open says so', /The microphone could not be opened/.test(turn), true)

/* -------------------------------------------------------------- hearing */

/* The sounds moved to earcons.ts; how loud they are is check-speakahead's. */
const earcons = read('src/renderer/src/earcons.ts')
check('it ticks while it works', /export function startTicks\(\)/.test(earcons) && /startTicks/.test(turn), true)
check('from the moment it has the recording', /showVoice\(\{ stage: 'hearing', level: 0 \}\)[\s\S]{0,600}await chime\('heard'\)\s+startTicks\(\)/.test(turn), true)
check('and while the answer is coming', /runningCount\(\) > 0\) \{\s+quietSince = 0[\s\S]{0,400}\) startTicks\(\)/.test(turn), true)
check('never while the mic is open', /micDead = false\s+stopTicks\(\)/.test(turn), true)
check('nor over a chime', /async function chime[^{]*\{\s+stopTicks\(\)/.test(earcons), true)
check('and stops once the answer is actually playing', /audio\.onplaying = \(\) => \{\s+started = true\s+stopTicks\(\)/.test(turn), true)

/* ------------------------------------------------------------ the answer */

/* The first whole turn heard "What's one plus one?", got the answer, and
   said nothing: the page's policy had no media-src, so the blob: WAV was
   refused as "no supported source". */
const html = read('src/renderer/index.html')
check('the page lets a spoken answer play', /media-src 'self' blob:/.test(html), true)
check('and if the element refuses, Web Audio plays it', /if \(\(await playWebAudio\(wav\)\) \|\| cancelled\) return/.test(turn), true)
check('the element is tried first, for the faster lists', /if \(\(await playElement\(wav, quick\)\) \|\| cancelled\) return/.test(turn), true)
check('the answer stays on the bar after it is said', /stage: 'done', detail: text/.test(turn), true)
/* 1.8s of quiet before reading the answer was the biggest wait measured
   between the answer arriving and hearing it; a card registers in a frame. */
check('the answer is read without a long pause first', /export const QUIET_AFTER_MS = 600\b/.test(turn), true)
check('and when the turn ends, however it ends', /\.finally\(\(\) => \{\s+stopTicks\(\)/.test(turn), true)

/* ------------------------------------------------------------- the mic */

/*
 * "Sometimes the mic takes time to like get picked up." The default mic was
 * the earbuds', which only exists in headset mode: opening it switched them
 * out of A2DP, taking seconds and sometimes failing ("Failure in Bluetooth
 * audio transport"), while the chime had already told the person to talk.
 */
const micMain = read('src/main/mic.ts')
const micPage = read('src/renderer/src/mic.ts')
const recorderSrc = read('src/renderer/src/recorder.ts')
const dictation = read('src/renderer/src/hooks/useDictation.ts')
check('auto prefers this computer’s mic over a Bluetooth headset’s', /current\.startsWith\('bluez_'\)/.test(micMain) && /!s\.name\.startsWith\('bluez_'\)/.test(micMain), true)
check('never a speaker monitor', /!s\.name\.endsWith\('\.monitor'\)/.test(micMain), true)
check('/microphone earbuds is the system default', /pick === 'default'\) return \{ label: null/.test(micMain), true)
check('the page opens the chosen device', /deviceId: \{ exact: opts\.deviceId \}/.test(recorderSrc), true)
check('a dead mic is exact zeros, a live one any sound', /level > 1e-5/.test(recorderSrc), true)
check('the chime waits until the mic is live', /recording\.live, sleep\(LIVE_WAIT_MS\)[\s\S]{0,900}await chime\('listen'\)[\s\S]{0,200}recording\.arm\(\)/.test(turn), true)
check('no chime plays before the mic is open any more', /await chime\('listen'\)\s+const \w+ = await listen\(/.test(turn), false)
check('the chime is not heard as speech', /if \(!armed\) return/.test(turn) && /armed: false/.test(turn), true)
/* "Nothing worth sending" twice while talking: this MacBook's mic hears a
   room at 0.00005 and a voice at 0.009, under a fixed bar of 0.02. */
{
  const R = await load('src/renderer/src/recorder.ts', 'recorder')
  const W = await load('src/renderer/src/wav.ts', 'wav')
  check('a mic that was fine before is judged as before', R.speechThreshold(0.01), 0.02)
  check('a quiet laptop mic: speech is well above its room', R.speechThreshold(0.00005) < 0.009, true)
  check('but never down at the noise itself', R.speechThreshold(0.00005), R.MIN_SPEECH_LEVEL)
  check('no room heard yet: the old bar', R.speechThreshold(Infinity), 0.02)
  check('the voice turn and dictation use it', /if \(rms >= speech\) spoke = true/.test(turn) && /if \(raw > speech\) spokeRef/.test(read('src/renderer/src/hooks/useListening.ts')), true)
  check('and the recorder gates on it', /if \(armed && level > speech\)/.test(recorderSrc), true)
  const quiet = Float32Array.from({ length: 100 }, (_, i) => 0.009 * Math.sin(i))
  const peak = (a) => Math.max(...a.map(Math.abs))
  check('a quiet clip is brought up for the transcriber', +peak(W.louder(quiet.slice())).toFixed(2), 0.28)
  check('by no more than 30 dB', peak(W.louder(quiet.slice())) / peak(quiet) <= 31.7, true)
  const loud = Float32Array.from({ length: 100 }, (_, i) => 0.7 * Math.sin(i))
  check('a normal one is left alone', peak(W.louder(loud.slice())), peak(loud))
}
check('a mic that never wakes says so', /The microphone gave no sound at all/.test(turn), true)
check('dictation uses the same mic', /const mic = await chosenMic\(\)\s+recording = await record\(\{\s+deviceId: mic\.deviceId/.test(dictation), true)
check('the virtual "default" is not offered as a mic', /VIRTUAL = new Set\(\['default', 'communications'\]\)/.test(micPage), true)

/* -------------------------------------------------------------- the log */

for (const line of ['started', 'microphone: ', 'listened ', 'heard "', 'speaking ', 'stopped', 'failed: ']) {
  check(`the log says "${line.trim()}"`, turn.includes(line), true)
}

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} voice bar checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
