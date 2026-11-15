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

check('a voice turn brings the window up', /console\.log\(`\[wumpy\] voice turn: \$\{why\}`\)\s+panel\.show\('voice turn'\)/.test(main), true)
check('the bar is on the page', app.includes('<VoiceTurnBar />'), true)
check('it shows the mic level while listening', /stage === 'listening' && \(\s+<span className="voice-turn-meter"/.test(bar), true)
check('and has a Stop', bar.includes('onClick={stopVoice}'), true)
check('and is styled', css.includes('.voice-turn {'), true)
for (const stage of ['starting', 'listening', 'hearing', 'thinking', 'speaking', 'done', 'nothing', 'cancelled', 'error']) {
  check(`the turn reaches "${stage}"`, turn.includes(`stage: '${stage}'`), true)
}
check('silence says whether the mic heard anything', /lastPeak < SPEECH_LEVEL/.test(turn), true)
check('a mic that will not open says so', /The microphone could not be opened/.test(turn), true)

/* -------------------------------------------------------------- hearing */

check('it ticks while it works', /function startTicks\(\)/.test(turn), true)
check('quietly - a third of the chime', /exponentialRampToValueAtTime\(0\.04,/.test(turn), true)
check('from the moment it has the recording', /showVoice\(\{ stage: 'hearing', level: 0 \}\)\s+startTicks\(\)/.test(turn), true)
check('and while the answer is coming', /runningCount\(\) > 0\) \{\s+quietSince = 0\s+startTicks\(\)/.test(turn), true)
check('never while the mic is open', /let peak = 0\s+stopTicks\(\)/.test(turn), true)
check('nor over a chime', /async function chime[^{]*\{\s+stopTicks\(\)/.test(turn), true)
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
check('and when the turn ends, however it ends', /\.finally\(\(\) => \{\s+stopTicks\(\)/.test(turn), true)

/* -------------------------------------------------------------- the log */

for (const line of ['started', 'microphone: ', 'listened ', 'heard "', 'speaking ', 'stopped', 'failed: ']) {
  check(`the log says "${line.trim()}"`, turn.includes(line), true)
}

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} voice bar checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
