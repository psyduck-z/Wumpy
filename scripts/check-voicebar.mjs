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
for (const stage of ['starting', 'listening', 'hearing', 'thinking', 'speaking', 'done', 'cancelled', 'error']) {
  check(`a conversation reaches "${stage}"`, turn.includes(`stage: '${stage}'`), true)
}
check('a mic that will not open says so', /The microphone could not be opened/.test(turn), true)
check('nor one that never comes on', /The microphone never came on/.test(turn), true)
check('a mic that goes away mid-conversation ends it', /track\?\.addEventListener\('ended', \(\) => \{[\s\S]{0,200}ending = 'failed'\s+cancel\(\)/.test(turn), true)

/* -------------------------------------------------------------- hearing */

/* The sounds moved to earcons.ts; how loud they are is check-speakahead's. */
const earcons = read('src/renderer/src/earcons.ts')
check('it ticks while it works', /export function startTicks\(kind/.test(earcons) && /startTicks\(\)/.test(turn), true)
/* "Got it" was a chime, and one at a pause in the middle of a sentence
   sounded like a false alarm: the typing says it now. */
check('from the moment it has the words', /showVoice\(\{ stage: 'hearing', level: 0 \}\)[\s\S]{0,120}startTicks\(\)/.test(turn), true)
check('and while the answer is coming', /runningCount\(\) > 0\) \{\s+quietSince = 0[\s\S]{0,400}\) startTicks\(\)/.test(turn), true)
check('and stops the moment someone talks', /function heardSpeech\(r: Recording\): void \{\s+if \(r !== ear \|\| cancelled\) return\s+stopTicks\(\)/.test(turn), true)
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
/* 1.8s of quiet before reading the answer was the biggest wait measured
   between the answer arriving and hearing it; a card registers in a frame. */
check('the answer is read without a long pause first', /export const QUIET_AFTER_MS = 600\b/.test(turn), true)
check('and when it ends, however it ends, everything stops', /\.then\(async \(\) => \{\s+stopTicks\(\)\s+speaker\?\.stop\(\)/.test(turn), true)

/* ------------------------------------------------------------- the mic */

/*
 * "Sometimes the mic takes time to like get picked up." The default mic was
 * the earbuds', which only exists in headset mode: opening it switched them
 * out of A2DP, taking seconds and sometimes failing ("Failure in Bluetooth
 * audio transport"), while the chime had already told the person to talk.
 */
const recorderSrc = read('src/renderer/src/recorder.ts')
const dictation = read('src/renderer/src/hooks/useDictation.ts')
/* Then: "If I'm using Wumpy with the buds, the buds are the microphone.
   Don't overcomplicate it with extra commands." So there is no choosing:
   the system's default mic, which is the earbuds' when they are connected. */
check('no microphone is chosen: the system default', /audio: \{[^}]*deviceId/.test(turn) || /deviceId/.test(dictation), false)
check('no /microphone command', /name: 'microphone'/.test(read('src/renderer/src/commands.ts')), false)
check('the log names the mic that opened', /note\(`microphone: \$\{track\?\.label/.test(turn), true)
/* "It said it's listening, but then it doesn't pick up my microphone. And
   after like 5 seconds, then it picks up": the hiss of earbuds still
   switching was taken for sound. On Linux, PipeWire is asked as well. */
{
  const B = await load('src/shared/btmic.ts', 'btmic')
  const before = '5513\tbluez_input.2C:BE:EE:12:34:56\tPipeWire\tfloat32le 1ch 48000Hz\tRUNNING\n8139\tbluez_output.2C_BE_EE_12_34_56.1\tPipeWire\ts16le 2ch 48000Hz\tRUNNING'
  const during = `${before}\n9001\tbluez_input.2C_BE_EE_12_34_56.0\tPipeWire\ts16le 1ch 16000Hz\tSUSPENDED`
  const after = `${before}\n9001\tbluez_input.2C_BE_EE_12_34_56.0\tPipeWire\ts16le 1ch 16000Hz\tRUNNING`
  check('the stand-in running is not the earbuds’ mic', B.earbudsMic('bluez_input.2C:BE:EE:12:34:56', before), 'absent')
  check('nor their mic before it runs', B.earbudsMic('bluez_input.2C:BE:EE:12:34:56', during), 'switching')
  check('their mic running is', B.earbudsMic('bluez_input.2C:BE:EE:12:34:56', after), 'running')
  check('without a stand-in, the default itself', B.earbudsMic('bluez_input.2C_BE_EE_12_34_56.0', after.split('\n').slice(2).join('\n')), 'running')
  check('another pair’s mic is not these', B.earbudsMic('bluez_input.AA:BB:CC:DD:EE:FF', after), 'absent')
  check('their mic never listed: going by sound after a while', /if \(!seen && Date\.now\(\) - since > UNLISTED_MS\) \{[\s\S]{0,200}working = true/.test(turn), true)
  check('longer than any switch, shorter than the wait for one', /export const UNLISTED_MS = 7000/.test(turn) && /export const LIVE_WAIT_MS = 9000/.test(turn), true)
  /* On Omarchy the earbuds' own mic is internal, and pactl never lists it:
     PipeWire is asked by name. */
  const node = (state) => JSON.stringify([{ id: 103, type: 'PipeWire:Interface:Node', info: { state, props: { 'node.name': 'bluez_input.2C_BE_EE_12_34_56.0' } } }])
  check('their mic, from PipeWire: not there yet', B.nodeState('', 'bluez_input.2C_BE_EE_12_34_56.0'), 'absent')
  check('there, not running', B.nodeState(node('idle'), 'bluez_input.2C_BE_EE_12_34_56.0'), 'switching')
  check('running', B.nodeState(node('running'), 'bluez_input.2C_BE_EE_12_34_56.0'), 'running')
  check('another node of another name is not it', B.nodeState(node('running'), 'bluez_input.AA_BB_CC_DD_EE_FF.0'), 'absent')
  check('the stand-in names the real mic', B.realMicName('bluez_input.2C:BE:EE:12:34:56', 'bluez_input.2C_BE_EE_12_34_56.0'), 'bluez_input.2C_BE_EE_12_34_56.0')
  check('or it is worked out from the address', B.realMicName('bluez_input.2C:BE:EE:12:34:56'), 'bluez_input.2C_BE_EE_12_34_56.0')
  check('a real mic as the default is itself', B.realMicName('bluez_input.2C_BE_EE_12_34_56.0'), 'bluez_input.2C_BE_EE_12_34_56.0')
  check('asked by pw-dump, pactl only without it', /const dump = await run\('pw-dump', \[defaultSource\.real\]\)\s+if \(dump !== null\) return nodeState/.test(read('src/main/btmic.ts')), true)
  /* "When I stopped, suddenly the music sounded blurry, no spatial sound,
     and a little bit of audio leaked from the MacBook before it recovered." */
  const nodeOf = (name, profile, state = 'running') => ({ id: 1, type: 'PipeWire:Interface:Node', info: { state, props: { 'node.name': name, ...(profile ? { 'api.bluez5.profile': profile } : {}) } } })
  const standIn = nodeOf('bluez_input.2C:BE:EE:12:34:56', '', 'suspended')
  const speakers = nodeOf('alsa_output.pci-0000_01_00.3.HiFi__Speaker__sink', '')
  check('in headset mode, music waits', B.musicMode(JSON.stringify([standIn, nodeOf('bluez_input.2C_BE_EE_12_34_56.0', 'headset-head-unit'), nodeOf('bluez_output.2C_BE_EE_12_34_56.1', 'headset-head-unit')])), 'headset')
  check('while their output is gone, it waits', B.musicMode(JSON.stringify([standIn, speakers])), 'switching')
  check('back in music mode, it plays', B.musicMode(JSON.stringify([standIn, speakers, nodeOf('bluez_output.2C_BE_EE_12_34_56.1', 'a2dp-sink')])), 'ready')
  check('with no earbuds, nothing to wait for', B.musicMode(JSON.stringify([speakers])), 'ready')
  const music = read('src/main/music.ts')
  check('the music is resumed only after that', /if \(waitForEarbuds\) console\.log\(`\[wumpy\] music: \$\{await backToMusicMode\(\)\}, then resumed`\)\s+if \(holds > 0\) return/.test(music), true)
  check('a hold meanwhile keeps it paused, for that hold', /paused = \[\.\.\.new Set\(\[\.\.\.paused, \.\.\.now\]\)\]/.test(music), true)
  check('but quitting does not wait', /return releaseMusic\(false\)/.test(music), true)
  check('the recorder waits on it', /gate: \(\) => working/.test(turn) && /hearing\.frame\(level, now, opts\.gate \? opts\.gate\(\) : true\)/.test(recorderSrc), true)
  check('two running answers in a row before it counts', /working = runs >= 2/.test(turn), true)
  check('and not Bluetooth, asked once', /if \(state === 'none'\) \{\s+working = true\s+return/.test(turn), true)
  check('only on Linux', /if \(process\.platform !== 'linux'\) return 'none'/.test(read('src/main/btmic.ts')), true)
}
/* "I can't hear the chime that signals me to speak": played after the mic
   opened, through an output kept open while the earbuds switched to
   headset mode, it went into a stream that broke with the switch. */
check('the dot first, in the earbuds’ ordinary mode', /await chime\('opening'\)\s+if \(cancelled\) return false[\s\S]{0,400}mic = await navigator\.mediaDevices\.getUserMedia\(/.test(turn), true)
/* Then: "in between... can you add like some dots, like a regular
   mechanical keyboard, tick, tick, tick" - for the wait while the earbuds
   switch, which had been silent on purpose. */
check('ticking while the earbuds switch, if the mic is not on at once', /const waiting = setTimeout\(\(\) => \{\s+waitingTicks = true\s+if \(earbudsOut\) startTicks\('waiting'\)\s+\}, NO_SWITCH_MS\)/.test(turn), true)
check('stopped the moment it is', /clearTimeout\(waiting\)\s+waitingTicks = false\s+stopTicks\(\)/.test(turn), true)
check('and never from the laptop’s speakers while the earbuds’ output is gone', /if \(waitingTicks\) out \? startTicks\('waiting'\) : stopTicks\(\)/.test(turn) && /earbudsOut: sink \? sink\.startsWith\('bluez_output\.'\) : null/.test(read('src/main/btmic.ts')), true)
/* Then: "add a chime to tell me when [it] is ready for me to speak." */
check('"talk now" once the mic delivers sound', /recording\.live, sleep\(LIVE_WAIT_MS\)[\s\S]{0,1800}note\(`microphone live after \$\{liveMs\}ms`\)[\s\S]{0,400}await chime\('listen'\)/.test(turn), true)
check('from an output opened after the switch, not through it', /if \(liveMs < 0 \|\| liveMs >= NO_SWITCH_MS\) releaseOutput\(\)/.test(turn) && /playOn\(handsFree\)\s+wakeOutput\(\)\s+await chime\('listen'\)/.test(turn), true)
/* Live at 164ms, "talk now" at 1090ms: 450 of them waking an output that
   had never gone to sleep. Kept open when nothing switched. */
check('kept, with no wake wait, when no earbuds switched', /export const NO_SWITCH_MS = 400\b/.test(turn), true)
check('under the half second WirePlumber waits before switching earbuds', Number(/export const NO_SWITCH_MS = (\d+)/.exec(turn)?.[1]) < 500, true)
check('and speech counts only after it', /await chime\('listen'\)\s+await sleep\(READY_TAIL_MS\)\s+if \(cancelled\) return false\s+recording\.arm\(\)/.test(turn), true)
check('only one chime before the mic is on', (turn.slice(turn.indexOf('async function open('), turn.indexOf('mic = await navigator')).match(/await chime\(/g) ?? []).length, 1)
check('the first ear waits for "talk now"', /const recording = await newEar\(false\)/.test(turn), true)
check('carrying on while it is heard is the same question', /if \(!ear\?\.spoke\(\)\) break\s+stopTicks\(\)\s+note\('they carried on talking: waiting for the rest'\)/.test(turn), true)
check('a click does not start an utterance', /export const CONVERSATION_ONSET = \{ frames: 3, window: 4 \}/.test(turn) && /onset: CONVERSATION_ONSET/.test(turn), true)
check('and over a sound, it takes longer and louder', /ear\?\.strict\(ticking\(\) \|\| \(speaker\?\.busy\(\) \?\? false\) \|\| stopSound !== null\)/.test(turn), true)
/* "Nothing worth sending" twice while talking: this MacBook's mic hears a
   room at 0.00005 and a voice at 0.009, under a fixed bar of 0.02. */
{
  const R = await load('src/renderer/src/recorder.ts', 'recorder')
  const W = await load('src/renderer/src/wav.ts', 'wav')
  check('a mic that was fine before is judged as before', R.speechThreshold(0.01), 0.02)
  check('a quiet laptop mic: speech is well above its room', R.speechThreshold(0.00005) < 0.009, true)
  check('but never down at the noise itself', R.speechThreshold(0.00005), R.MIN_SPEECH_LEVEL)
  check('no room heard yet: the old bar', R.speechThreshold(Infinity), 0.02)
  check('talking over it takes more than a click', R.STRICT_ONSET.frames * 40 >= 250 && R.STRICT_LOUDER >= 2, true)
  check('dictation uses the bar', /if \(raw > speech\) spokeRef/.test(read('src/renderer/src/hooks/useListening.ts')), true)
  check('and the recorder gates on it', /recent\.push\(level > \(this\.strict \? strictBar\(speech\) : speech\)\)/.test(recorderSrc), true)
  check('talking over an answer takes three times what one leaked in at', R.strictBar(0.002) >= 0.006, true)
  check('and a voice still does it easily', R.strictBar(0.02) <= 0.05, true)
  const quiet = Float32Array.from({ length: 100 }, (_, i) => 0.009 * Math.sin(i))
  const peak = (a) => Math.max(...a.map(Math.abs))
  check('a quiet clip is brought up for the transcriber', +peak(W.louder(quiet.slice())).toFixed(2), 0.28)
  check('by no more than 30 dB', peak(W.louder(quiet.slice())) / peak(quiet) <= 31.7, true)
  const loud = Float32Array.from({ length: 100 }, (_, i) => 0.7 * Math.sin(i))
  check('a normal one is left alone', peak(W.louder(loud.slice())), peak(loud))
}

/* --------------------------------------------- the mic, frame by frame */

/* What the recorder hears, played the levels of real mics: 40ms a frame,
   as the recorder looks. */
{
  const R = await load('src/renderer/src/recorder.ts', 'hearing')
  const run = (hearing, frames, t0 = 0) => {
    let t = t0
    const seen = { live: -1, onset: -1, endedAt: -1, longestQuiet: 0 }
    for (const [level, working = true] of frames) {
      t += 40
      const r = hearing.frame(level, t, working)
      if (r.live && seen.live < 0) seen.live = t
      if (r.onset && seen.onset < 0) seen.onset = t
      if (hearing.spoke) seen.longestQuiet = Math.max(seen.longestQuiet, t - hearing.spokeAt)
    }
    return { ...seen, t }
  }
  const hold = (level, ms, working = true) => Array.from({ length: Math.round(ms / 40) }, () => [level, working])
  const hiss = (ms) => Array.from({ length: Math.round(ms / 40) }, (_, i) => [0.00005 + (i % 5) * 0.00002, false])

  /* "It said it's listening, but then it doesn't pick up my microphone. And
     after like 5 seconds, then it picks up." */
  {
    const h = new R.Hearing(0)
    const seen = run(h, [...hiss(5000), ...hold(0.0005, 400)])
    check('earbuds still switching are not live, however they hiss', seen.live > 5000, true)
    check('and once PipeWire has their mic running, they are', seen.live, 5040)
    check('their hiss is not the room', h.room, 0.0005)
  }
  {
    const h = new R.Hearing(0)
    check('with nothing to ask, exact zeros are not live', run(h, hold(0, 2000)).live, -1)
    check('and a quiet room is', run(h, hold(0.0003, 200), 2000).live, 2040)
  }
  /* "When I'm just speaking halfway through... it actually cuts me off." */
  const talker = () => {
    const h = new R.Hearing(0, { frames: 3, window: 4 })
    run(h, hold(0.0005, 1000))
    return h
  }
  {
    const h = talker()
    const seen = run(h, [...hold(0.05, 2000), ...hold(0, 2000, false), ...hold(0.05, 1000)], 1000)
    check(`a two-second dropout mid-sentence is not a pause (${seen.longestQuiet}ms)`, seen.longestQuiet < 1500, true)
    const after = run(h, hold(0.0005, 1600), seen.t)
    check('the pause after it still ends it', after.t - h.spokeAt > 1500, true)
  }
  {
    const h = talker()
    const seen = run(h, [...hold(0.05, 3000), ...hold(0, 9000, false)], 1000)
    check('a mic gone for good still ends it, a few seconds on', seen.longestQuiet > 1500 && h.dropMs <= R.DROPOUT_CREDIT_MS + 40, true)
  }
  {
    const h = talker()
    /* Words with soft ends: loud, then two fifths of the bar, for 300ms. */
    const words = Array.from({ length: 6 }, () => [...hold(0.05, 400), ...hold(0.002, 320)]).flat()
    const seen = run(h, words, 1000)
    check(`the soft ends of words keep it going (${seen.longestQuiet}ms quiet at most)`, seen.longestQuiet <= 80, true)
    const fan = run(h, hold(0.004, 2400), seen.t)
    check('but a noise just under the bar does not hold it forever', fan.t - h.spokeAt > 1500, true)
  }
  {
    const h = talker()
    const seen = run(h, [...hold(0.06, 2500), ...hold(0.0005, 600), ...hold(0.06, 300)], 1000)
    check('the room does not creep up through a long sentence', h.bar, R.speechThreshold(0.0005))
    check('so the next words still count', seen.longestQuiet < 700, true)
  }
  {
    const h = talker()
    check('a click is not someone talking', run(h, [[0.2], [0.0005], [0.0005], [0.0005], [0.15], [0.0005]], 1000).onset, -1)
    check('a word is, within 160ms', run(h, hold(0.03, 160), 1240).onset - 1240 <= 160, true)
  }
  {
    const h = talker()
    h.setStrict(true)
    const echo = run(h, hold(0.008, 3000), 1000)
    const quiet = talker()
    quiet.setStrict(true)
    check('in a quiet room, an answer at the level logged is not talking over it', run(quiet, hold(0.002, 3000), 1000).onset, -1)
    check('an answer leaking into the mic is not someone talking over it', echo.onset, -1)
    check('someone talking over it is, in about a third of a second', run(h, hold(0.06, 400), echo.t).onset - echo.t <= 320, true)
  }
  {
    const h = new R.Hearing(0)
    run(h, hold(0.0005, 400))
    check('dictation still starts on the first loud frame', run(h, [[0.03]], 400).onset, 440)
  }
  {
    const h = new R.Hearing(0, { frames: 3, window: 4 }, false)
    run(h, hold(0.0005, 400))
    check('nothing counts before it is armed - not the "talk now" chime', run(h, hold(0.1, 400), 400).onset, -1)
    h.arm(800)
    check('and speech does after', run(h, hold(0.05, 200), 800).onset > 800, true)
  }
}

/* -------------------------------------------------------------- the log */

for (const line of ['started', 'microphone: ', 'heard ', 'heard "', 'speaking ', 'ended', 'failed: ', 'talked over it']) {
  check(`the log says "${line.trim()}"`, turn.includes(line), true)
}

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} voice bar checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
