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

/* "The moment it starts writing, make the text-to-speech start": the
   digits of pi came as one sentence of 600 characters, and nothing of a
   sentence was said until it ended - 45 seconds. Written a word at a time,
   as a model writes it. */
{
  const digits = 'three one four one five nine two six five three five eight nine seven nine three two three eight four six two six four three'.split(' ')
  const answer = `Sure, the first twenty five digits of pi are ${digits.join(', ')}.`
  const words = answer.split(' ')
  let firstAt = -1
  let steady = true
  let said = []
  for (let i = 1; i <= words.length; i++) {
    const now = ready(words.slice(0, i).join(' '), false)
    if (now.length && firstAt < 0) firstAt = words.slice(0, i).join(' ').length
    if (JSON.stringify(now.slice(0, said.length)) !== JSON.stringify(said)) steady = false
    said = now
  }
  const final = ready(answer, true)
  check(`a long run-on sentence starts being said early (after ${firstAt} of ${answer.length} characters)`, firstAt > 0 && firstAt < 120, true)
  check('and what was said stays said as the sentence goes on', steady, true)
  check('the finished answer is the same pieces, and all of them', final.slice(0, said.length), said)
  check('every word is said once', final.join(' ').replace(/\s+/g, ' '), answer)
  const runOn = 'word '.repeat(80).trim()
  check('with no commas at all, still in pieces', S.pieces(runOn).length > 1 && S.pieces(runOn).every((p) => p.length <= S.RUN_ON + 10), true)
  check('an ordinary sentence is left whole', S.pieces('Sure, it has sixteen gigabytes of memory, which is plenty for this.'), ['Sure, it has sixteen gigabytes of memory, which is plenty for this.'])
  check('a long one cut where a voice pauses anyway', S.pieces('The answer depends on what you mean by fast, since a laptop on battery, a laptop on power and a desktop all behave differently here.')[0], 'The answer depends on what you mean by fast, since a laptop on battery,')
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
/* A chime note as strike() makes it: a fundamental, its octave and a quick
   bright fourth harmonic, each with its own ring. */
const struck = (hz, at, { peak, attack, ring, bright }) => [
  { hz: () => hz, gain: ramp([[at, 0.0001], [at + attack, peak], [at + ring, 0.0001]]) },
  { hz: () => hz * 2, gain: ramp([[at, 0.0001], [at + attack, peak * 0.15], [at + ring * 0.6, 0.0001]]) },
  { hz: () => hz * 4, gain: ramp([[at, 0.0001], [at + attack, bright], [at + 0.05, 0.0001]]) }
]
/* "A titchy bit louder", the first time: 0.11 at the peak, 6ms in, 0.2s of ring. */
const titchy = render(0.45, struck(587.33, 0, { peak: 0.11, attack: 0.006, ring: 0.2, bright: 0.02 }))
const titchyUp = dB(titchy, oldNote)
check(`each chime note was a titchy bit louder (${titchyUp} dB)`, titchyUp >= 0.5 && titchyUp <= 3, true)
/* Then "smoother and more audible": louder again, longer, softer in. */
const L = E.CHIMES.listen
const now = render(0.45, struck(587.33, 0, { peak: E.CHIME_PEAK * L.level, attack: E.CHIME_ATTACK, ring: L.ring, bright: ((0.02 * E.CHIME_PEAK) / 0.11) * L.level }))
const audible = dB(now, titchy)
check(`and now more audible again (${audible} dB on that)`, audible >= 2 && audible <= 5, true)
check('and smoother: no note comes in faster than 10ms', E.CHIME_ATTACK >= 0.01, true)

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
/* The first request on a connection was 1.8-2.0s to hear 5.7s of speech;
   primed while the person talked, 0.9-1.3s. */
check('and each service is primed while the person talks', /function startVoiceTurn[\s\S]{0,900}void primeSpeech\(\)/.test(main), true)
check('only a service that has gone cold', /cold\.hear \? one\('hearing'/.test(main) && /cold\.talk \? one\('talking'/.test(main), true)
check('cold being a minute without an answer', /export const WARM_FOR_MS = 60_000/.test(nv) && /answered\(Client\)\s+resolve\(response\)/.test(nv), true)
check('a dropped connection is cold again', /clients\.delete\(Client\)\s+answeredAt\.delete\(Client\)/.test(nv), true)
/* "Can you set the voice to a male?" Every settings file named Aria. */
check('a male voice by default: Jason, neutral, as chosen', /export const DEFAULT_VOICE = 'Magpie-Multilingual\.EN-US\.Jason\.Neutral'/.test(nv) && /speakVoice: 'Magpie-Multilingual\.EN-US\.Jason\.Neutral'/.test(read('src/shared/defaults.ts')), true)
check('and whoever is still on an old default is moved to it, once', /'Magpie-Multilingual\.EN-US\.Aria',\s+'Magpie-Multilingual\.EN-US\.Jason',\s+'Magpie-Multilingual\.EN-US\.Ray\.Neutral'/.test(nv), true)
check('and a little faster again, from the old default speed', /DEFAULT_RATE = 1\.25/.test(nv) && /OLD_DEFAULT_RATES = \[1\.15\]/.test(nv) && /speakRate: 1\.25,/.test(read('src/shared/defaults.ts')), true)
check('a saved old default, voice or speed, moved to the choice, once', /if \(settings\.get\('voiceChoice'\) === VOICE_CHOICE\) return/.test(main) && /moveOffGoogle\(\)\s+moveToChosenVoice\(\)/.test(main), true)
check('wumpy --speech-check lists the voices on offer', /listVoices\(k\)/.test(main), true)
check('wumpy --speech-check measures what priming saves', /hearIt\('hearing it, primed'\)/.test(main), true)
check('the pieces go to the panel as they come', /e\.sender\.send\(IPC\.voiceAudio/.test(main), true)
check('wumpy --speech-check measures it from here', /argv\.includes\('--speech-check'\)/.test(main), true)
check('a voice turn has a first-token watchdog', /quickerModel\(on, settings\.get\('latencies'\)/.test(main), true)
check('only on the first try', /attempt\(model, null, false\)/.test(main), true)
check('and the aborted try does not end the turn', /onDone: \(stats\) => \{[\s\S]{0,200}if \(gaveUp\) return/.test(main), true)

check('sentences are spoken while the answer is written', /while \(!cancelled && !interrupted && Date\.now\(\) < deadline\) \{\s+speakAhead\(since\)/.test(turn), true)
check('and the rest once it is finished', /const spokeAnswer = speakAhead\(started\)/.test(turn), true)
check('listening waits until the voice has finished, or is talked over', /if \(cancelled \|\| !ear\) return null\s+await speaker\?\.drain\(\)/.test(turn), true)
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
check('an ended conversation is silent at once', /stopSound\?\.\(\)\s+speaker\?\.stop\(\)\s+ear\?\.stop\(\)/.test(turn), true)
check('typing is scheduled on the audio clock', /while \(next < context\.currentTime \+ 1\)/.test(earcons), true)
/* "Sometimes when I just take a pause to think... it just cuts it off...
   one and a half Mississippi." */
check('a pause of a second and a half ends what was said', /export const END_PAUSE_MS = 1500/.test(turn) && /listen\(END_PAUSE_MS, IDLE_END_MS,/.test(turn), true)

/* The output. "There was no chime, so I thought it didn't work": the
   chime played into Bluetooth earbuds that were still waking up. */
check('a conversation opens one output and keeps it awake', /wakeOutput\(\)\s+speaker = newSpeaker\(\)/.test(turn), true)
check('opened afresh once the earbuds have switched their mic on', /if \(liveMs < 0 \|\| liveMs >= NO_SWITCH_MS\) releaseOutput\(\)/.test(turn), true)
check('with a signal far below hearing', /\(Math\.random\(\) \* 2 - 1\) \* 1e-4/.test(earcons), true)
check('and lets it sleep when it ends', /\.finally\(\(\) => \{\s+releaseOutput\(\)/.test(turn), true)
check('a chime waits for the output to be awake', /const context = await awake\(\)/.test(earcons), true)
check('so does the first typing', /out\.wake - \(Date\.now\(\) - out\.woke\)\) \/ 1000/.test(earcons), true)
/* "Sometimes it doesn't work at the start": the first pinch after a quiet
   spell finds earbuds that have let their audio link go. */
check('longer to wake after a quiet spell', E.WAKE_COLD_MS > E.WAKE_MS && /const cold = Date\.now\(\) - closedAt > COLD_AFTER_MS/.test(earcons), true)
/* "Tick, tick, tick, tick" while the mic comes on: not the typing in threes
   that means thinking. */
check('the mic wait is one clicky key at a time', E.WAITING.every < E.TYPING.cycle && E.WAITING.lowpass > E.TYPING.lowpass * 2, true)
check('and softer than the typing', E.WAITING.click < E.TYPING.click, true)
check('the voice goes through the same output', /const current = output\(\)/.test(speaker), true)
check('and follows it when it is opened again', /if \(current !== this\.context\) \{/.test(speaker), true)
{
  /* Every output is opened in one place, openContext, called by wakeOutput alone. */
  const body = earcons.slice(earcons.indexOf('function openContext('), earcons.indexOf('export function wakeOutput('))
  const all = (earcons.match(/new AudioContext\(/g) ?? []).length
  const inside = (body.match(/new AudioContext\(/g) ?? []).length
  check('no sound opens an output of its own', /new AudioContext\(/.test(speaker) || all !== inside || (earcons.match(/openContext\(\)/g) ?? []).length !== 2, false)
  check('a chosen output that will not open falls back to the default', /catch \{\s+sink = null\s+\}\s+\}\s+return new AudioContext\(\{ latencyHint: 'playback' \}\)/.test(earcons), true)
}

/* "Also add a chime after the recording of my voice finished" - and then,
   in a conversation, "I feel like there's chimes everywhere", and one at a
   pause mid-sentence sounded like a false alarm. The typing says it now. */
check('no chime when it stops recording', /chime\('heard'\)/.test(turn) || 'heard' in E.CHIMES, false)
check('the typing starts instead, while the words are heard', /\/\* The typing is "got it": no chime for it\. \*\/\s+startTicks\(\)/.test(turn), true)
/* "Remove the one when it sent it, because there's no need for that." */
check('no chime when the words are sent', /chime\('sent'\)/.test(turn) || 'sent' in E.CHIMES, false)
check('one "talk now" in a conversation, at the start', (turn.match(/await chime\('listen'\)/g) ?? []).length, 1)
check('a yes is said, not chimed', /entry\.run\(\)[\s\S]{0,120}await say\('Okay\.'\)/.test(turn), true)

/* "Naturally just distinct... going upwards, it's ready for me to speak...
   going downwards, it means it's finished." */
{
  const K = E.CHIMES
  const rises = (c) => c.notes.length > 1 && c.notes.every((hz, i) => i === 0 || hz > c.notes[i - 1])
  const falls = (c) => c.notes.length > 1 && c.notes.every((hz, i) => i === 0 || hz < c.notes[i - 1])
  check('four cues', Object.keys(K).join(' '), 'opening listen done cancel')
  check('"talk now" goes up', rises(K.listen), true)
  check('"finished" goes down', falls(K.done), true)
  check('as one rolled chord', K.done.notes.length === 3 && K.done.step < 0.05, true)
  check('"it did not work" goes nowhere: one low note, twice', new Set(K.cancel.notes).size === 1 && K.cancel.notes.length === 2 && K.cancel.notes[0] < 300, true)
  check('"felt the hold" is a single note', K.opening.notes.length, 1)
  check('every cue a different shape', new Set(Object.values(K).map((c) => `${c.notes.join()}@${c.step}`)).size, 4)

  /* Rendered the way strike() makes them, for how loud each is to an ear. */
  const voices = (c) =>
    c.notes.flatMap((hz, i) =>
      struck(hz, i * c.step, {
        peak: E.CHIME_PEAK * c.level,
        attack: E.CHIME_ATTACK,
        ring: c.ring,
        bright: ((0.02 * E.CHIME_PEAK) / 0.11) * c.level
      })
    )
  const loud = Object.fromEntries(Object.entries(K).map(([name, c]) => [name, render(0.4, voices(c))]))
  /* "The initial time to tell me that it received the gesture... has to be
     a little louder, and make it just a single dot." It had been the
     quietest of them, a soft low note, so as not to be taken for "talk now". */
  const soft = render(0.4, struck(440, 0, { peak: 0.11 * 0.6, attack: 0.006, ring: 0.2, bright: 0.02 * 0.6 }))
  const dotUp = dB(loud.opening, soft)
  check(`the dot louder than the soft note it was (${dotUp} dB)`, dotUp >= 3, true)
  check('and short: a dot, not a note', K.opening.ring <= 0.15, true)
  const dotVsTalk = dB(loud.opening, loud.listen)
  check(`and about as loud as "talk now" (${dotVsTalk} dB)`, Math.abs(dotVsTalk) <= 3, true)
  const chord = dB(loud.done, loud.listen)
  check(`the chord no louder than the rest (${chord} dB against "talk now")`, Math.abs(chord) <= 2.5, true)
}

/* The gesture: hold to start, hold again to finish. */
check('a double report of one gesture is one gesture', /if \(now - startedAt < SAME_GESTURE_MS \|\| now - lastGesture < REPORTED_TWICE_MS\) \{/.test(turn), true)
/* Logged: a pinch at 5s cancelled a turn whose earbuds' mic had not come on,
   the turn waited out the mic until 9s, and the next pinch - 1.09s later,
   meant to start again - was taken as another cancel. */
check('ending stops the wait for the mic at once', /Promise\.race\(\[recording\.live, sleep\(LIVE_WAIT_MS\)\.then\(\(\) => -1\), stopped\]\)/.test(turn) && /stopTicks\(\)\s+stopWaiting\(\)/.test(turn), true)
check('and a gesture while it ends starts again', /if \(cancelled\) \{\s+note\('held again while it was ending[^']*'\)\s+again = true/.test(turn), true)
check('a deliberate second gesture is not a repeated report', Number(/export const REPORTED_TWICE_MS = (\d+)/.exec(turn)?.[1]) > 540 && Number(/export const REPORTED_TWICE_MS = (\d+)/.exec(turn)?.[1]) < 1090, true)
check('within 1.2s', /export const SAME_GESTURE_MS = 1200/.test(turn), true)
check('otherwise a gesture ends the conversation', /the conversation ends`\)\s+cancel\(\)/.test(turn), true)
check('then a new one can begin', /if \(again\) \{\s+again = false\s+begin\(\)/.test(turn), true)
check('with the chord, before the mic lets go', /if \(ending !== 'failed'\) await chime\('done'\)\s+await closeMic\(\)/.test(turn), true)
check('and nobody talking for two minutes ends it too', /export const IDLE_END_MS = 120_000/.test(turn) && /ending = 'idle'/.test(turn), true)

/* Silence in a conversation sounds like thinking: a failure is said. */
check('a sentence heard as no words is said to be missed', /missed\.failed \|\| missed\.talkedMs >= MISSED_SENTENCE_MS/.test(turn) && /'Sorry, I didn’t catch that\.'/.test(turn), true)
check('but a cough is left alone', /export const MISSED_SENTENCE_MS = 900/.test(turn), true)
check('hearing that broke is said too', /return \{ heard: '', text: '', failed: true \}/.test(turn) && /Sorry, I couldn’t hear that just now/.test(turn), true)
check('and an answer that failed', /\.find\(\(m\) => m\.role === 'assistant' && m\.error\)/.test(turn) && /Sorry, I couldn’t get an answer just then/.test(turn), true)

/* A yes-or-no nobody answers - walked away mid-conversation - is left on
   the screen after a few asks, not asked every eight seconds for good. */
check('an approval nobody answers is left on the screen', /if \(unanswered >= UNANSWERED_ASKS\) \{\s+leftUnanswered\.add\(entry\)/.test(turn) && /export const UNANSWERED_ASKS = 4/.test(turn), true)
check('counting only silence, not a wrong word', /unanswered = idled \? unanswered \+ 1 : 0/.test(turn), true)
check('and the answer moves on past it', /const waitingOn = newestPending\(\)\s+if \(waitingOn && !leftUnanswered\.has\(waitingOn\)\) \{/.test(turn), true)

/* "I'm allowed to interrupt this AI and tell it what to do." */
check('talking over an answer stops it', /stopSound\?\.\(\)\s+speaker\?\.stop\(\)\s+speaker = newSpeaker\(\)\s+if \(asking\) return\s+interrupted = true/.test(turn), true)
check('the answer goes on being written until what was said is heard', /interrupted = true\s+if \(!cut && answerSince\) cut = \{ since: answerSince, mark: answerMark, heard \}/.test(turn), true)
check('a question then stops it', /if \(depsRef\.current\.streaming\(\)\) depsRef\.current\.stop\(\)\s+if \(kind === 'stop'\)/.test(turn) && /async function answer[\s\S]{0,400}if \(depsRef\.current\.streaming\(\)\) depsRef\.current\.stop\(\)/.test(turn), true)
check('a cough or an "mm-hm" carries on from the first sentence not heard', /if \(kind === 'nothing'\) \{[\s\S]{0,200}await follow\(was\.since, was\.mark, was\.heard\)/.test(turn) && /const heard = spokenBase \+ \(speaker\?\.heard\(\) \?\? 0\)/.test(turn), true)
check('counted by what was heard to the end, not what was sent to be said', /return this\.finished\.filter\(\(f\) => f\.endsAt <= now \+ 0\.05\)/.test(speaker), true)
check('while it asks yes or no, talking is the answer', /if \(asking\) return\s+interrupted = true/.test(turn), true)
check('the mic stays open through the answer', /const endedAt = Date\.now\(\)[\s\S]{0,160}metering = false\s+await newEar\(\)/.test(turn), true)
check('a long wait is not a long clip', /if \(Date\.now\(\) - earSince > FRESH_EAR_MS\) await nextEar\(\)/.test(turn) && /clipForSpeech\(blob, extension, Math\.max\(0, onsetMs - PRE_ROLL_MS\)\)/.test(turn), true)

/* "I don't like the delay." The words are heard from the first half second
   of the pause, while the rest of it is waited out. */
{
  const recorderSrc = read('src/renderer/src/recorder.ts')
  const guessAt = Number(/export const GUESS_AFTER_MS = (\d+)/.exec(turn)?.[1])
  check(`hearing starts well before the pause is over (${guessAt}ms of ${1500})`, guessAt > 300 && guessAt <= 750, true)
  check('from what has been recorded so far, without stopping', /recorder\.requestData\(\)/.test(recorderSrc) && /new Blob\(all, \{ type: format\.mime \}\)/.test(recorderSrc), true)
  check('used only if nothing was said after it', /guess && guess\.at === r\.spokeAt\(\) \? await Promise\.race\(\[guess\.words, sleep\(GUESS_WAIT_MS\)\.then\(\(\) => null\)\]\) : null/.test(turn), true)
  check('and only if it heard words; otherwise the whole clip is heard', /const words = guessed\?\.heard \? guessed : await hearClip\(clip\.blob, clip\.extension, r\.onsetMs\(\)\)/.test(turn), true)
  check('a new guess after each pause, not one per frame', /if \(r\.quietMs\(\) >= GUESS_AFTER_MS && guess\?\.at !== r\.spokeAt\(\)\)/.test(turn), true)
  check('the log says how long after the pause the words were ready', /ms after the pause\$\{guessed\?\.heard \? ', from the guess' : ''\}/.test(turn), true)
}

/* "Can you make him speak a little bit faster?" Magpie ignores SSML's
   <prosody rate> (measured: 0.8 to 1.5 all came back 5.7-5.9s long), so the
   sound is time-stretched as it arrives. Run on a voice-like tone, fed in
   the fifth-of-a-second pieces Magpie sends. */
{
  const T = await load('src/shared/stretch.ts', 'stretch')
  const SR = 22050
  const n = SR * 3
  const voice = Float32Array.from({ length: n }, (_, i) => {
    const t = i / SR
    return 0.3 * Math.sin(2 * Math.PI * 140 * t) + 0.15 * Math.sin(2 * Math.PI * 280 * t + 1) + 0.08 * Math.sin(2 * Math.PI * 420 * t + 2)
  })
  const stretched = (speed) => {
    const s = new T.Stretcher(speed)
    const parts = []
    for (let i = 0; i < n; i += 4410) parts.push(s.push(voice.slice(i, i + 4410)))
    parts.push(s.flush())
    const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
    let o = 0
    for (const p of parts) {
      y.set(p, o)
      o += p.length
    }
    return y
  }
  const pitch = (y) => {
    const mid = y.subarray(Math.floor(y.length / 2), Math.floor(y.length / 2) + 2048)
    /* The first lag that lines up almost as well as the best one: the
       period, not a multiple of it. */
    const corr = []
    for (let L = 60; L < 400; L++) {
      let c = 0
      for (let i = 0; i < 1024; i++) c += mid[i] * mid[i + L]
      corr.push([L, c])
    }
    const top = Math.max(...corr.map(([, c]) => c))
    const lag = corr.find(([L, c], i) => c > 0.9 * top && c >= (corr[i - 1]?.[1] ?? 0) && c >= (corr[i + 1]?.[1] ?? 0))[0]
    return Math.round(SR / lag)
  }
  const rms = (y, from, to) => {
    let e = 0
    for (let i = from; i < to; i++) e += y[i] * y[i]
    return Math.sqrt(e / (to - from))
  }
  const quick = stretched(1.15)
  const ratio = +(n / quick.length).toFixed(2)
  check(`fifteen percent faster is fifteen percent shorter (${ratio})`, Math.abs(ratio - 1.15) < 0.03, true)
  check(`at the same pitch (${pitch(quick)}Hz, from ${pitch(voice)}Hz)`, Math.abs(pitch(quick) - pitch(voice)) <= 2 && Math.abs(pitch(voice) - 140) <= 2, true)
  const level = rms(quick, 2000, quick.length - 2000) / rms(voice, 0, n)
  check(`and the same loudness, with no gaps (${level.toFixed(2)})`, Math.abs(level - 1) < 0.08, true)
  let worst = 0
  for (let i = 1000; i < quick.length - 1000; i += 220) worst = Math.max(worst, Math.abs(rms(quick, i, i + 220) / rms(voice, 0, n) - 1))
  check(`no window comes out loud or hollow (${worst.toFixed(2)})`, worst < 0.25, true)
  {
    /* The speed now chosen: "can you make Jason speak a little faster?" */
    const quicker = stretched(1.25)
    const r = +(n / quicker.length).toFixed(2)
    check(`a quarter faster is a quarter shorter (${r})`, Math.abs(r - 1.25) < 0.03, true)
    check(`still at the same pitch (${pitch(quicker)}Hz)`, Math.abs(pitch(quicker) - pitch(voice)) <= 2, true)
    let worse = 0
    for (let i = 1000; i < quicker.length - 1000; i += 220) worse = Math.max(worse, Math.abs(rms(quicker, i, i + 220) / rms(voice, 0, n) - 1))
    check(`and still no window loud or hollow (${worse.toFixed(2)})`, worse < 0.25, true)
  }
  check('as made, it is left alone', new T.Stretcher(1).push(voice) === voice, true)
  check('it is on by default, a little', /speakRate: 1\.\d+,/.test(read('src/shared/defaults.ts')), true)
  check('every streamed piece goes through it', /this\.schedule\(stretch\.push\(floats\)\)/.test(speaker) && /if \(got\) this\.schedule\(stretch\.flush\(\)\)/.test(speaker), true)
  check('and the slower ways of speaking keep up', /audio\.playbackRate = quick \? Math\.max\(1\.2, currentSpeed\(\)\) : currentSpeed\(\)/.test(turn), true)
  check('the setting is read when a conversation starts', /setSpeed\(s\.speakRate \?\? 1\)/.test(turn), true)
}

/* The tone. */
check('one line of character, on screen and in the ear', /TONE =\s+'- Tone: a sharp, easygoing friend/.test(main), true)
check('and the answer first, since it is spoken while written', /Lead with the answer itself/.test(main), true)
/* Read aloud, "40%" and "20°C" are left to the voice to guess at, a misheard
   word is answered literally, and every question back costs a pinch. */
check('numbers as digits, which the voice reads right and are shorter to write', /Write numbers as digits/.test(main) && /never spelled out/.test(main), true)
check('but units in words, which it does not', /"64 gigabytes", not "64 GB"/.test(main), true)
check('and the voice\'s name is not part of the question', /Your voice is called Jason/.test(main), true)
check('how numbers are read is checked against the voice', /NUMBER_SENTENCES = \[/.test(main), true)
check('a misheard word answered as meant, read by how it sounds', /Read it by how it sounds and by what you were just talking about/.test(main) && /"a specie" for "a PC"/.test(main), true)
check('every recogniser can be compared, on sentences and on real speech', /async function hearingCheck\(\)/.test(main) && /if \(compareHearing\) void compareOn\(audio, hearer, heard\.text, heard\.ms\)/.test(main), true)
check('and the turn never waits on the comparison', /if \(compareHearing\) void compareOn\(audio, hearer, heard\.text, heard\.ms\)\s+return heard/.test(main), true)
/* "I need more accuracy, higher accuracy" - and it has to keep up with
   NVIDIA's 40 requests a minute a key. Whisper large-v3 makes a third fewer
   mistakes than Parakeet on real speech, on the same keys. */
check('a turn is heard by Whisper large-v3, on the NVIDIA keys', /export const HEARING: Hearer = HEARERS\.find\(\(h\) => h\.name === 'whisper-large-v3'\)!/.test(nv) && /hearer: Hearer = HEARING/.test(nv), true)
check('and by Parakeet when Whisper fails, then the local one', /for \(const hearer of \[HEARING, FALLBACK_HEARING\]\)/.test(main) && /export const FALLBACK_HEARING: Hearer = HEARERS\[0\]/.test(nv) && /return speech\.transcribe\(audio, extension\)\s+\}/.test(main), true)
check('Parakeet is still compared, now beside Whisper', /\{ name: 'parakeet-tdt-0\.6b', functionId: SPEECH_MODELS\.hear, language: 'en-US', compare: true \}/.test(nv) && /h\.compare && h !== by/.test(main), true)
/* "What text to speech models does the free NVIDIA API key allow... and
   compare them to my current one": every one the keys reach, side by side. */
check('the voice models on the keys can be compared', /async function compareVoices\(\)/.test(main) && /compare-voices\|/.test(main) && /ddacc747-1269-4fab-bfd9-8f593dead106/.test(nv), true)
check('and what one refuses is not held against the voice in use', /if \(onlineRefused && ours\)/.test(nv) && /UNIMPLEMENTED && ours\) onlineRefused = true/.test(nv), true)
check('a "Thank you." out of a cough is asked of Parakeet first', /mayBeInvented\(heard\.text\) && !\(await parakeetHearsWords\(audio\)\)/.test(main), true)
{
  const H = await load('src/shared/heard.ts', 'heard')
  for (const [said, invented] of [
    ['Thank you.', true], ['Thanks for watching!', true], ['you', true], ['Bye-bye.', true],
    ['Thank you so much for watching.', true], ['Subtitles by the Amara.org community', true], ['...', true],
    ['Thank you, can you open Spotify?', false], ['How much RAM does this PC have?', false],
    ['You know what, never mind.', false], ['Stop.', false], ['So what is the weather?', false]
  ]) check(`"${said}" ${invented ? 'is checked first' : 'is taken as said'}`, H.mayBeInvented(said), invented)
}
/* "no OOOOOOOO" for a lone O, and "I L L" for I’ll: what Magpie is given. */
{
  const V = await load('src/shared/voicetext.ts', 'voicetext')
  const P = await load('src/shared/spoken.ts', 'spoken')
  const K = await load('src/shared/kept.ts', 'kept')
  const said = (t) => V.forMagpie(P.speakable(t))
  for (const [t, want] of [
    ['No, O.', 'No, oh.'],
    ['_ _ O _', 'blank, blank, oh, blank'],
    ['The word: P _ A _ E T.', 'The word: pee, blank, ay, blank, ee, tee.'],
    ['I’ll leave you later.', "I'll leave you later."],
    ["I'LL BE BACK.", "I'll BE BACK."],
    ['Two O’s and an E.', 'Two ohs and an ee.'],
    ['Is there an A?', 'Is there an ay?'],
    ['A PC with a GPU.', 'A PC with a GPU.'],
    ['The U.S. sells T-shirts to O’Brien.', "The U.S. sells T-shirts to O'Brien."],
    ['Windows 11 24H2 is out.', 'Windows 11 24H2 is out.'],
    ['Use _italic_ here.', 'Use italic here.'],
    ['<keep>word: PLANET = P L A N E T</keep>Yes, there is an E!', 'Yes, there is an ee!'],
    ['<keep>word: PLAN', '']
  ]) check(`said as "${want}": ${t}`, said(t), want)
  check('the note is never shown', K.withoutKept('<keep>PLANET</keep>\n\nGuess a letter.'), 'Guess a letter.')
  check('a hangman board is not taken for an aside', S.withoutAsides('_ _ O _'), '_ _ O _')
  check('an aside still is', S.withoutAsides('_Nemotron had not started - answering on Ultra instead._').trim(), '')
  check('every word for Magpie goes through it, streamed or not', /text: asWritten \? text : forMagpie\(text\)/.test(nv) && /text: forMagpie\(text\),/.test(nv), true)
  check('and the voice test hears both versions', /const SAYING_SENTENCES = \[/.test(main) && /\['before', s\.before, true\]/.test(main), true)
}
/* The game memory: in the instructions on both channels, hidden on screen. */
check('a game keeps its secret in <keep>, on screen and in the ear', /const KEEP = \[/.test(main) && /TONE, \.\.\.KEEP\]/.test(main) && /made of it: it is not part of the question\.',\s+\.\.\.KEEP,/.test(main), true)
check('and checks a guess against it letter by letter', /Check a guess against',\s+'  the numbered letters, never from memory/.test(main) && /"1 P, 2 L, 3 A, 4 N, 5 E, 6 T"/.test(main), true)
check('letters heard as words, in a letter game', /"you" for U, "see" for C/.test(main), true)
{
  const msg = read('src/renderer/src/components/Message.tsx')
  check('the note is hidden on screen and from Copy', /const visible = isUser \? message\.content : withoutKept\(message\.content\)/.test(msg) && /useSmoothText\(visible,/.test(msg) && /copyText\(visible\)/.test(msg), true)
}
/* Lists said as they are made, and the models past the first five. */
{
  const turn2 = read('src/renderer/src/hooks/useVoiceTurn.ts')
  check('a list is streamed, not made whole first (the "..." after a command)', /async function say\(text: string, quick = false\): Promise<void> \{[\s\S]{0,300}if \(speaker\) \{/.test(turn2), true)
  check('a silence after the question reads the rest of the options', /const heard = await listen\(1100, reading \? MORE_AFTER_MS : 8000\)/.test(turn2) && /if \(!heard && reading && idled\)/.test(turn2), true)
  check('numbered on from the first ones', /numberedSpeech\(next\.map\(\(o\) => sayModel\(o\.label\)\), MORE_AT_ONCE, from\)/.test(turn2) && /numbered = \[\.\.\.numbered, \.\.\.next\]/.test(turn2), true)
  check('a model that is not there is said to be not there', /choice\.unavailable!\[Number\(gone\[0\]\)\]\.why/.test(turn2) && /isn't answering right now/.test(read('src/renderer/src/App.tsx')), true)
  check('a faint blip is not sent to be heard', /const faint = Boolean\(clip\) && talkedMs < FAINT_MS && stats\.peak < stats\.bar \* FAINT_TIMES/.test(turn2) && /if \(clip && !faint\)/.test(turn2), true)
  const SP = await load('src/shared/spokenpick.ts', 'spokenpick')
  check('the rest are numbered from six', SP.numberedSpeech(['Gemma 4', 'Kimi K3'], 5, 5), 'Six, Gemma 4. Seven, Kimi K3.')
  check('and past twelve', SP.countWord(21), 'Twenty one')
}
check('talked over, it answers the new thing and leaves the old', /they talked over you',\s+'  on purpose: answer the new thing/.test(main), true)
check('a conversation: short, and theirs to steer', /This is a back-and-forth conversation/.test(main) && /can talk',\s+'  over you to stop you/.test(main), true)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} speak-ahead checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
