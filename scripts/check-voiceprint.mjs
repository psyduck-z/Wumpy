/**
 * Only the person's voice, in a conversation.
 *
 * Asked for in these words: "integrate voice detection so only your voice
 * is detected and trained against your voice" - "train it against your
 * voice so it only recognizes your voice".
 *
 * The features, the learning and the verdicts are run here; the model itself
 * needs a 29 MB download, so it is run only when one is given:
 *
 *   WUMPY_VOICE_MODEL=path/to/campplus.onnx WUMPY_VOICE_CLIPS=dir node scripts/check-voiceprint.mjs
 *
 * with dir holding 16 kHz WAVs named <speaker>-<anything>.wav. The numbers
 * SAME_ABOVE was set from are in shared/voiceprint.ts.
 *
 * Run with: node scripts/check-voiceprint.mjs
 */
import { build } from 'esbuild'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.voiceprint-${name}.mjs`)
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

const V = await load('src/shared/voiceprint.ts', 'vp')
const C = await load('src/renderer/src/commands.ts', 'commands')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
const read = (f) => readFileSync(f, 'utf8')

/* ------------------------------------------------------------- features */

const tone = (hz, seconds, amp = 0.3) =>
  Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / 16000))
{
  const f = V.features(tone(1000, 1))
  check('25ms frames every 10ms: 98 in a second', f.frames, 98)
  check('80 bins each', f.data.length, 98 * 80)
  /* Mean taken off: each bin averages to nothing. */
  let worst = 0
  for (let b = 0; b < 80; b++) {
    let m = 0
    for (let i = 0; i < f.frames; i++) m += f.data[i * 80 + b]
    worst = Math.max(worst, Math.abs(m / f.frames))
  }
  check('each bin has its mean taken off', worst < 1e-4, true)
  check('shorter than a frame is nothing', V.features(new Float32Array(300)).frames, 0)
  /* Before the mean comes off, a 1 kHz tone is loudest in the bin around
     1 kHz on the mel scale: of 80 from 20 Hz to 8 kHz, the 28th is centred at 1004 Hz. Read
     through a mix of two tones, so the mean does not hide it. */
  const mix = tone(1000, 1)
  const low = tone(300, 1)
  const half = mix.length / 2
  for (let i = 0; i < half; i++) mix[i] = low[i]
  const g = V.features(mix)
  const last = g.frames - 1
  let best = 0
  for (let b = 1; b < 80; b++) if (g.data[last * 80 + b] > g.data[last * 80 + best]) best = b
  check('a 1 kHz tone lands in the mel bin centred on 1 kHz (the 28th)', best, 27)
}

{
  /* Half a second of room, a second of talking, a second and a half of room. */
  const room = (sec) => Float32Array.from({ length: sec * 16000 }, () => (Math.random() - 0.5) * 0.002)
  const clip = new Float32Array(48000)
  clip.set(room(0.5), 0)
  clip.set(tone(200, 1, 0.3), 8000)
  clip.set(room(1.5), 24000)
  const kept = V.voiced(clip).length / 16000
  check('the room around the talking is left out, word edges kept', kept > 1 && kept <= 1.25, true)
  check('a clip of only room is left as it is', V.voiced(room(1)).length, 16000)
}

/* ------------------------------------------------------------- learning */

const voice = (seed, jitter = 0.15) => {
  let x = seed
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647) * 2 - 1
  const base = Array.from({ length: 512 }, () => rnd())
  return () => base.map((v) => v + jitter * rnd() * 3)
}
const mine = voice(7)
const theirs = voice(99)
let p = V.emptyVoiceprint('m')
check('nothing known, so whoever talks is heard', V.judge(p, theirs(), 3000).kind, 'theirs')
check('too short to learn from', V.learn(p, mine(), 1200, 'buds').clips.length, 0)
for (let i = 0; i < V.LEARN_CLIPS - 1; i++) p = V.learn(p, mine(), 2500, 'buds', i)
check('still learning one clip short', V.known(p), false)
check('a stranger while learning is not learned (from the third clip on)', V.learn(p, theirs(), 3000, 'buds').clips.length, V.LEARN_CLIPS - 1)
check('and is heard while it is still learning', V.judge(p, theirs(), 3000).why, 'learning')
p = V.learn(p, mine(), 2500, 'buds')
check('known after LEARN_CLIPS clips', V.known(p), true)
check('their own voice is theirs', V.judge(p, mine(), 2500).kind, 'theirs')
check('someone else is someone else', V.judge(p, theirs(), 2500).kind, 'someone else')
check('but under a second is never judged: "stop", "yes"', V.judge(p, theirs(), 800).kind, 'theirs')
check('the bar rises with the talking', [800, 1200, 2000, 5000].map(V.cutOff), [0.4, 0.4, 0.45, 0.5])
check('turned off, anyone is heard', V.judge({ ...p, off: true }, theirs(), 4000).why, 'off')
check('turned off, nothing is learned', V.learn({ ...p, off: true }, mine(), 4000, 'buds').clips.length, V.LEARN_CLIPS)
{
  let q = p
  for (let i = 0; i < 40; i++) q = V.learn(q, mine(), 3000, i % 2 ? 'buds' : 'laptop')
  check('it keeps learning their voice, up to KEEP_CLIPS', q.clips.length, V.KEEP_CLIPS)
  check('oldest out', q.clips.some((c) => c.at === 0), false)
  check('a stranger is never learned once it is known', V.learn(q, theirs(), 5000, 'buds') === q, true)
}

/* --------------------------------------------------------------- /voice me */

const run = (text) => {
  const cmd = C.allCommands().find((c) => c.name === 'voice')
  return cmd.run(text)
}
check('/voice me says how far it has got', run('me'), { kind: 'voiceprint', change: 'status' })
check('/voice me off', run('me off'), { kind: 'voiceprint', change: 'off' })
check('/voice only me on', run('only me on'), { kind: 'voiceprint', change: 'on' })
check('/voice me forget', run('me forget'), { kind: 'voiceprint', change: 'forget' })
check('/voice on is still dictation', run('on'), { kind: 'voice', setting: 'on', on: true })

/* --------------------------------------------------------------- wiring */

const turn = read('src/renderer/src/hooks/useVoiceTurn.ts')
check('each clip heard is checked while its words are heard', /const voice = whoseVoice\(clip\.blob/.test(turn), true)
check('someone else is not answered, nor "sorry, I didn\'t catch that"', /who\?\.kind === 'someone else'\) \{\s*stopTicks\(\)\s*\} else if \(words\.heard\)/.test(turn), true)
check('learned from only when it was words', /who\.token && words\.heard\.split\(\/\\s\+\/\)\.length >= LEARN_WORDS/.test(turn), true)
check('a slow voiceprint does not hold the answer', /Promise\.race\(\[voice, sleep\(VOICEPRINT_WAIT_MS\)/.test(turn), true)
const main = read('src/main/voiceprint.ts')
check('the model is checked against its hash', /sha256\(got\) !== MODEL_SHA256/.test(main), true)
check('no model, everyone is heard', /why: 'unavailable'/.test(main), true)
const builder = read('electron-builder.yml')
check('only the wasm build that runs is packaged', builder.includes('!node_modules/onnxruntime-web/dist/*{jsep,jspi,asyncify,webgpu,webgl,bundle}*'), true)

/* --------------------------------------------------- the model, if given */

const model = process.env.WUMPY_VOICE_MODEL
const clips = process.env.WUMPY_VOICE_CLIPS
if (model && clips) {
  const ort = await import('onnxruntime-web')
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(readFileSync(model))
  const wav = (file) => {
    const b = readFileSync(file)
    let o = 12
    while (o < b.length) {
      const id = b.toString('ascii', o, o + 4)
      const n = b.readUInt32LE(o + 4)
      if (id === 'data') return Float32Array.from({ length: n / 2 }, (_, i) => b.readInt16LE(o + 8 + i * 2) / 32768)
      o += 8 + n + (n & 1)
    }
  }
  const embed = async (s) => {
    const { data, frames } = V.features(V.voiced(s))
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, frames, 80]) })
    return out[session.outputNames[0]].data
  }
  const by = {}
  for (const f of readdirSync(clips).filter((f) => f.endsWith('.wav')).sort()) (by[f.split('-')[0]] ??= []).push(f)
  let wrongMine = 0
  let mineN = 0
  let letIn = 0
  let othersN = 0
  for (const [who, files] of Object.entries(by)) {
    let print = V.emptyVoiceprint('m')
    for (const f of files.slice(0, V.LEARN_CLIPS)) print = V.learn(print, await embed(wav(join(clips, f))), 3000, 'x')
    for (const f of files.slice(V.LEARN_CLIPS)) {
      mineN++
      if (V.judge(print, await embed(wav(join(clips, f))), 3000).kind !== 'theirs') wrongMine++
    }
    for (const [other, theirFiles] of Object.entries(by))
      if (other !== who)
        for (const f of theirFiles.slice(V.LEARN_CLIPS, V.LEARN_CLIPS + 2)) {
          othersN++
          if (V.judge(print, await embed(wav(join(clips, f))), 3000).kind === 'theirs') letIn++
        }
  }
  console.log(`     the model: ${wrongMine}/${mineN} of the person's own clips turned away, ${letIn}/${othersN} strangers let in`)
  check('the person is turned away under 5% of the time', wrongMine / mineN < 0.05, true)
  check('strangers are let in under 5% of the time', letIn / othersN < 0.05, true)
} else console.log('skip the model itself (set WUMPY_VOICE_MODEL and WUMPY_VOICE_CLIPS to run it)')

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
