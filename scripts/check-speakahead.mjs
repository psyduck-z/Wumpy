/**
 * Speaking sooner, and the sounds around it.
 *
 * Asked for in these words: "once the AI starts to write down things,
 * quickly begin to [speak], because if you wait for it... that's already 18
 * seconds for a response, which is terrible", and of the voice itself: "it
 * outputs it, but it takes like 1 Mississippi, 2 Mississippi, and then it
 * says it." Also the sounds: a chime "a bit more distinguishable... a titchy
 * bit louder", and typing "like the soft typing of creamy keyboards... 1 2 3,
 * 1 2 3", cut the moment the answer starts.
 *
 * The sentence rules, the model hand-over and the loudness are run; the
 * streaming itself is checked as wiring, since it needs NVIDIA and a sound
 * card.
 *
 * Run with: node scripts/check-speakahead.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.speakahead-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    alias: { '@shared': './src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

const S = await load('src/shared/speakahead.ts', 'speak')
const Q = await load('src/shared/voicequick.ts', 'quick')
const C = await load('src/shared/cloud.ts', 'cloud')
const E = await load('src/renderer/src/earcons.ts', 'earcons')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(62)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
const read = (f) => readFileSync(f, 'utf8')

/* ------------------------------------------------------------ sentences */

check('split at a stop and a space', S.sentences('Five. It is odd! Why? Because.'), ['Five.', 'It is odd!', 'Why?', 'Because.'])
check('not inside a number', S.sentences('It costs 3.50 today.'), ['It costs 3.50 today.'])
check('a closing quote stays with its sentence', S.sentences('He said "go." Then left.'), ['He said "go."', 'Then left.'])
check('nothing is nothing', S.sentences('   '), [])

/* ---------------------------------------------- while it is being written */

const ready = (text, done) => S.readyToSay(text, done)
check('nothing until a sentence is finished', ready('The answer is', false), [])
check('the last sentence waits while it is written', ready('Five. It is', false), ['Five.'])
check('even when it ends in a stop: "3." may be "3.50"', ready('Five. It costs 3.', false), ['Five.'])
check('all of it once it is done', ready('Five. It costs 3.', true), ['Five.', 'It costs 3.'])
check('a command block half written is never read', ready('Let me check. ```bash\ndf -h', false), ['Let me check.'])
check('nor once it is closed', ready('Let me check.\n\n```bash\ndf -h\n```\n\nThat one.', true), ['Let me check.', 'That one.'])
check(
  'the note about which model answered is not read',
  ready('_nvidia/nemotron-x had not started after 5s — answering on nvidia/y instead._\n\nFive.', true),
  ['Five.']
)
check('an italic word inside a sentence still is', ready('That is _really_ big.', true), ['That is really big.'])
{
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ')
  const live = ready(long, false)
  const final = ready(long, true)
  check('while written, never past what the answer is held to', live.join(' ').length <= 600, true)
  check('and what was said early is what the finished answer starts with', final.slice(0, live.length), live)
}

/* --------------------------------------------------------- the batching */

check('the first request is one sentence, for the first sound', S.nextBatch(['A.', 'B.', 'C.'], true), ['A.'])
check('after that, what is ready, in one go', S.nextBatch(['A.', 'B.', 'C.'], false), ['A.', 'B.', 'C.'])
check('up to a few sentences', S.nextBatch(['x'.repeat(200), 'y'.repeat(200)], false).length, 1)

/* ---------------------------------------- a voice turn does not wait on a stall */

const ids = C.CLOUD_MODELS.map((m) => m.id)
const [a, b, c] = ids
const lat = (ms, ok = true) => ({ ms, runs: 1, on: '2026-11-16', ok })
check('five seconds of silence, then the quicker one', Q.VOICE_FIRST_TOKEN_MS, 5000)
check('the fastest that answered', Q.quickerModel(a, { [a]: lat(900), [b]: lat(1200), [c]: lat(800) }, () => true), c)
check('never the same model', Q.quickerModel(c, { [c]: lat(800) }, () => true), null)
check('never one that failed its check', Q.quickerModel(a, { [b]: lat(500, false) }, () => true), null)
check('never one that cannot be used now', Q.quickerModel(a, { [b]: lat(500) }, (id) => id !== b), null)
check('never one slower than half the wait', Q.quickerModel(a, { [b]: lat(2600) }, () => true), null)
check('never one no longer offered', Q.quickerModel(a, { 'z-ai/glm-5.3': lat(300) }, () => true), null)

/* ------------------------------------------------------------ the sounds */

/*
 * Rendered here as Web Audio would make them, and compared by A-weighted
 * energy (how loud a short sound is to an ear, roughly): the new against
 * the old, which were a 520Hz blip at 0.055 and two 0.11s sines at 0.12.
 */
const SR = 48000
function ramp(points) {
  return (t) => {
    if (t < points[0][0]) return 0
    for (let i = 1; i < points.length; i++) {
      const [t0, v0] = points[i - 1]
      const [t1, v1] = points[i]
      if (t <= t1) return v0 * Math.pow(v1 / v0, (t - t0) / (t1 - t0))
    }
    return 0
  }
}
function render(seconds, voices) {
  const n = Math.round(seconds * SR)
  const out = new Float64Array(n)
  for (const v of voices) {
    let phase = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      phase += (2 * Math.PI * v.hz(t)) / SR
      out[i] += (v.noise ? v.noise[i] : Math.sin(phase)) * v.gain(t)
    }
  }
  return out
}
function lowpass(x, f0, q) {
  const w = (2 * Math.PI * f0) / SR
  const al = Math.sin(w) / (2 * q)
  const cs = Math.cos(w)
  const [b0, b1, b2, a0, a1, a2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al]
  const y = new Float64Array(x.length)
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    ;[x2, x1, y2, y1] = [x1, x[i], y1, v]
    y[i] = v
  }
  return y
}
function weightA(f) {
  const f2 = f * f
  return (1.2589 * (12194 ** 2 * f2 * f2)) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
}
function energyA(x) {
  let e = 0
  const n = x.length
  for (let k = 1; k < n / 2; k += 2) {
    const f = (k * SR) / n
    if (f > 8000) break
    let re = 0
    let im = 0
    for (let i = 0; i < n; i += 2) {
      const p = (2 * Math.PI * k * i) / n
      re += x[i] * Math.cos(p)
      im -= x[i] * Math.sin(p)
    }
    e += (re * re + im * im) * weightA(f) ** 2
  }
  return e
}
const dB = (a, b) => +(10 * Math.log10(energyA(a) / energyA(b))).toFixed(1)
let seed = 11
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const T = E.TYPING
const oldTick = render(0.12, [{ hz: () => 520, gain: ramp([[0, 0.0001], [0.008, 0.055], [0.07, 0.0001]]) }])
const press = render(0.12, [
  { hz: () => 0, noise: lowpass(Float64Array.from({ length: 0.12 * SR }, rnd), T.lowpass, 0.8), gain: ramp([[0, 0.0001], [0.002, T.click], [0.035, 0.0001]]) },
  { hz: (t) => 210 * Math.pow(120 / 210, Math.min(1, t / 0.04)), gain: ramp([[0, 0.0001], [0.003, T.knock], [0.05, 0.0001]]) }
])
const typing = dB(press, oldTick)
check(`each key press a little louder than the old tick (${typing} dB)`, typing >= 0.5 && typing <= 3, true)
check('in threes, then a rest', T.cycle > 3 * T.gap * 1.6, true)
check('soft: nothing clacky above 2kHz', T.lowpass <= 2000, true)

const oldNote = render(0.45, [{ hz: () => 660, gain: ramp([[0, 0.0001], [0.015, 0.12], [0.11, 0.0001]]) }])
const peak = E.CHIME_PEAK
const newNote = render(0.45, [
  { hz: () => 587.33, gain: ramp([[0, 0.0001], [0.006, peak], [0.2, 0.0001]]) },
  { hz: () => 587.33 * 2, gain: ramp([[0, 0.0001], [0.006, peak * 0.15], [0.12, 0.0001]]) },
  { hz: () => 587.33 * 4, gain: ramp([[0, 0.0001], [0.006, 0.02], [0.05, 0.0001]]) }
])
const chimeUp = dB(newNote, oldNote)
check(`each chime note a titchy bit louder (${chimeUp} dB)`, chimeUp >= 0.5 && chimeUp <= 3, true)

/* --------------------------------------------------------------- wiring */

const nv = read('src/main/nvspeech.ts')
const main = read('src/main/index.ts')
const turn = read('src/renderer/src/hooks/useVoiceTurn.ts')
const speaker = read('src/renderer/src/speaker.ts')
const earcons = read('src/renderer/src/earcons.ts')

check('one connection per service, kept between turns', /const clients = new Map/.test(nv), true)
check('no call closes it any more', /function call<[\s\S]{0,900}client\.close\(\)/.test(nv), false)
check('a failed channel is replaced', /dropClient\(Client, err\.code\)/.test(nv), true)
check('speech streams as it is made', /SynthesizeOnline\(metadata/.test(nv), true)
check('and falls back to one piece where it cannot', /onlineRefused = true/.test(nv), true)
check('connections open when the gesture comes', /function startVoiceTurn[\s\S]{0,700}warmSpeech\(\)/.test(main), true)
check('the pieces go to the panel as they come', /e\.sender\.send\(IPC\.voiceAudio/.test(main), true)
check('wumpy --speech-check measures it from here', /argv\.includes\('--speech-check'\)/.test(main), true)
check('a voice turn has a first-token watchdog', /quickerModel\(on, settings\.get\('latencies'\)/.test(main), true)
check('only on the first try', /attempt\(model, null, false\)/.test(main), true)
check('and the aborted try does not end the turn', /onDone: \(stats\) => \{[\s\S]{0,200}if \(gaveUp\) return/.test(main), true)

check('sentences are spoken while the answer is written', /while \(!cancelled && Date\.now\(\) < deadline\) \{\s+speakAhead\(since\)/.test(turn), true)
check('and the rest once it is finished', /const spokeAnswer = speakAhead\(started\)/.test(turn), true)
check('the mic waits until the voice has finished', /if \(cancelled\) return null\s+await speaker\?\.drain\(\)/.test(turn), true)
check('pieces play back to back on one clock', /Math\.max\(this\.at, context\.currentTime \+ \(quiet \? CUSHION_S : 0\.03\)\)/.test(speaker), true)

/* "Sometimes it jitters." */
check('a cushion before each stretch rides out a late piece', /export const CUSHION_S = 0\.2/.test(speaker), true)
check('the next batch is asked for while this one plays', /if \(running\.length >= 2\) await running\.shift\(\)/.test(speaker), true)
check('and held until everything before it is scheduled', /await after\s+released = true/.test(speaker), true)
check('speech never waits on the key spacing', /await pace\(provider, index, 0, this\.separate\(provider\), true\)/.test(read('src/main/cloud.ts')), true)
check('but is still counted towards it', /const gap = urgent \? 0 : PROVIDERS\[provider\]\.minGapMs/.test(read('src/main/cloud.ts')), true)
check('larger output buffers, so a busy page is not a click', /latencyHint: 'playback'/.test(earcons), true)
check('the bar says the wait is the earbuds, not a model loading', /Waiting for the earbuds’ microphone/.test(turn), true)
check('the typing stops at the first sound', /new Speaker\(\{ onSound: stopTicks, note \}\)/.test(turn), true)
check('and not between sentences', /if \(!speaker\?\.busy\(\) && \(speaker\?\.idleFor\(\) \?\? Infinity\) > TYPING_AGAIN_MS\) startTicks\(\)/.test(turn), true)
check('a stopped turn is silent at once', /speaker\?\.stop\(\)\s+note\('stopped'\)/.test(turn), true)
check('typing is scheduled on the audio clock', /while \(next < context\.currentTime \+ 1\)/.test(earcons), true)
check('a pause of a second ends what was said', /export const END_PAUSE_MS = 1000/.test(turn) && /listen\(END_PAUSE_MS, 8000, 45_000\)/.test(turn), true)

/* The output. "There was no chime, so I thought it didn't work": the
   chime played into Bluetooth earbuds that were still waking up. */
check('a turn opens one output and keeps it awake', /wakeOutput\(\)\s+speaker = new Speaker/.test(turn), true)
check('except while the earbuds switch their mic on', /await chime\('opening'\)\s+releaseOutput\(\)/.test(turn), true)
check('with a signal far below hearing', /\(Math\.random\(\) \* 2 - 1\) \* 1e-4/.test(earcons), true)
check('and lets it sleep when the turn ends', /speaker = null\s+releaseOutput\(\)/.test(turn), true)
check('a chime waits for the output to be awake', /const context = await awake\(\)/.test(earcons), true)
check('so does the first typing', /WAKE_MS - \(Date\.now\(\) - out\.woke\)\) \/ 1000/.test(earcons), true)
check('the voice goes through the same output', /const current = output\(\)/.test(speaker), true)
check('and follows it when it is opened again', /if \(current !== this\.context\) \{/.test(speaker), true)
check('no sound opens an output of its own', /new AudioContext\(/.test(speaker) || (earcons.match(/new AudioContext\(/g) ?? []).length !== 1, false)

/* "Also add a chime after the recording of my voice finished." */
check('a chime when it stops recording', /await chime\('heard'\)\s+startTicks\(\)/.test(turn), true)
check('while the words are already being transcribed', /const transcribing = clipForSpeech[\s\S]{0,300}await chime\('heard'\)[\s\S]{0,60}await transcribing/.test(turn), true)
/* "Remove the one when it sent it, because there's no need for that." */
check('no chime when the words are sent', /chime\('sent'\)/.test(turn) || 'sent' in E.CHIMES, false)

/* "Naturally just distinct... going upwards, it's ready for me to speak...
   going downwards, it means it's finished." */
{
  const K = E.CHIMES
  const rises = (c) => c.notes.length > 1 && c.notes.every((hz, i) => i === 0 || hz > c.notes[i - 1])
  const falls = (c) => c.notes.length > 1 && c.notes.every((hz, i) => i === 0 || hz < c.notes[i - 1])
  check('five cues', Object.keys(K).join(' '), 'opening listen heard done cancel')
  check('"talk now" goes up', rises(K.listen), true)
  check('"got it" goes down', falls(K.heard), true)
  check('and is "talk now" backwards', [...K.heard.notes].reverse().join(), K.listen.notes.join())
  check('"finished" goes down too', falls(K.done), true)
  check('but as one rolled chord, not two notes', K.done.notes.length === 3 && K.done.step < 0.05, true)
  check('"stopped" goes nowhere: one low note, twice', new Set(K.cancel.notes).size === 1 && K.cancel.notes.length === 2 && K.cancel.notes[0] < 300, true)
  check('"felt the pinch" is a single note', K.opening.notes.length, 1)
  check('every cue a different shape', new Set(Object.values(K).map((c) => `${c.notes.join()}@${c.step}`)).size, 5)

  /* Rendered the way strike() makes them, for how loud each is to an ear. */
  const voices = (c) =>
    c.notes.flatMap((hz, i) => {
      const at = i * c.step
      const part = (f, peak, ring) => ({ hz: () => f, gain: ramp([[at, 0.0001], [at + 0.006, peak], [at + ring, 0.0001]]) })
      const p = E.CHIME_PEAK * c.level
      return [part(hz, p, 0.2), part(hz * 2, p * 0.15, 0.12), part(hz * 4, 0.02 * c.level, 0.05)]
    })
  const loud = Object.fromEntries(Object.entries(K).map(([name, c]) => [name, render(0.4, voices(c))]))
  const quietest = Object.keys(K).filter((n) => n !== 'opening').map((n) => dB(loud[n], loud.opening))
  check(`"felt the pinch" the quietest, so not taken for "talk now" (${Math.min(...quietest)} dB under the next)`, Math.min(...quietest) >= 2, true)
  const chord = dB(loud.done, loud.heard)
  check(`the chord no louder than the rest (${chord} dB against "got it")`, Math.abs(chord) <= 2, true)
}

/* The gesture. */
check('a double report of one pinch is one pinch', /if \(after < SAME_GESTURE_MS\) \{/.test(turn), true)
check('within 1.2s', /export const SAME_GESTURE_MS = 1200/.test(turn), true)
check('a pinch while it talks interrupts and listens', /stage === 'speaking' \|\| stage === 'thinking'\)\) \{\s+note\('interrupted: listening again'\)\s+again = true/.test(turn), true)
check('and stops the answer being written', /if \(depsRef\.current\.streaming\(\)\) depsRef\.current\.stop\(\)/.test(turn), true)
check('but not while asking yes or no', /if \(!asking && \(stage/.test(turn), true)
check('then a new turn begins', /if \(again\) \{\s+again = false\s+begin\(\)/.test(turn), true)

/* The tone. */
check('one line of character, on screen and in the ear', /TONE =\s+'- Tone: a sharp, easygoing friend/.test(main), true)
check('and the answer first, since it is spoken while written', /Lead with the answer itself/.test(main), true)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} speak-ahead checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
