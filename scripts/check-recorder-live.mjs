/**
 * The recorder in real Chromium, on a fake microphone playing a made-up
 * sentence: what check-voicebar's frame-by-frame checks cannot show - the
 * browser's own echo cancelling, noise suppression and gain in the way,
 * MediaRecorder, the analyser's timing, and a recording-so-far that
 * decodes.
 *
 * The sentence is synthetic speech (voiced syllables at a talking pace,
 * over room noise): two seconds, a 0.8s pause that must not end it, more,
 * 0.6s of a dead mic that must not end it either, a last phrase, and quiet.
 *
 * Needs Electron and may need a sound device, so it is not part of `npm
 * run typecheck`: the Windows workflow runs it as a step of its own, and
 * here it is `node scripts/check-recorder-live.mjs` after changing how
 * speech is heard.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SR = 48000
const dir = mkdtempSync(join(tmpdir(), 'wumpy-recorder-'))

/* ------------------------------------------------------------ the voice */

let seed = 3
const noise = () => {
  seed = (seed * 16807) % 2147483647
  return (seed / 2147483647) * 2 - 1
}
const parts = []
const room = (s) => parts.push(Float32Array.from({ length: s * SR }, () => noise() * 0.0026))
const dead = (s) => parts.push(new Float32Array(s * SR))
const talk = (s) =>
  parts.push(
    Float32Array.from({ length: s * SR }, (_, i) => {
      const t = i / SR
      const envelope = (0.5 - 0.5 * Math.cos(2 * Math.PI * 4.5 * t)) ** 0.7
      const f = 120 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t))
      let v = 0
      for (let k = 1; k < 16; k++) v += (0.6 / k) * Math.sin(2 * Math.PI * k * f * t + k) * (k >= 4 && k <= 7 ? 1.6 : 1)
      return 0.25 * envelope * v + noise() * 0.0026
    })
  )
room(1)
talk(2)
room(0.8)
talk(1.2)
dead(0.6)
talk(0.8)
room(4)
const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
let o = 0
for (const p of parts) {
  samples.set(p, o)
  o += p.length
}
const wav = Buffer.alloc(44 + samples.length * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + samples.length * 2, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(SR, 24)
wav.writeUInt32LE(SR * 2, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(samples.length * 2, 40)
samples.forEach((s, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2))
writeFileSync(join(dir, 'talk.wav'), wav)

/* ------------------------------------------------------ the page and app */

await build({
  entryPoints: ['src/renderer/src/recorder.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Rec',
  outfile: join(dir, 'rec.js'),
  logLevel: 'error'
})
writeFileSync(
  join(dir, 'page.html'),
  `<!doctype html><script src="rec.js"></script><script>
(async () => {
  const out = (o) => console.log('RESULT ' + JSON.stringify(o))
  try {
    const t0 = performance.now()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const r = await Rec.record({ stream, silenceMs: 1500, maxMs: 45000, maxFromSpeech: true, onset: { frames: 3, window: 4 } })
    const guesses = []
    let guessAt = -1
    const timer = setInterval(async () => {
      if (r.quietMs() >= 450 && guessAt !== r.spokeAt()) {
        guessAt = r.spokeAt()
        const snap = await r.snapshot()
        if (!snap) return
        const a = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await snap.blob.arrayBuffer())
        guesses.push(+a.duration.toFixed(2))
      }
    }, 60)
    const clip = await r.done
    clearInterval(timer)
    out({ clipS: clip ? +(clip.ms / 1000).toFixed(2) : 0, onsetS: +(r.onsetMs() / 1000).toFixed(2), endedS: +((performance.now() - t0) / 1000).toFixed(2),
      guesses, lastGuessUsed: guessAt === r.spokeAt(), ...r.stats() })
  } catch (e) { out({ error: String(e) }) }
})()
</script>`
)
writeFileSync(
  join(dir, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', ${JSON.stringify(join(dir, 'talk.wav'))})
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  w.webContents.on('console-message', (e) => { if (e.message.startsWith('RESULT ')) { console.log(e.message); app.quit() } })
  await w.loadFile(${JSON.stringify(join(dir, 'page.html'))})
  setTimeout(() => { console.log('RESULT {"error":"timed out"}'); app.quit() }, 30000)
})`
)

const electron = join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const output = await new Promise((resolve) => {
  let text = ''
  const child = spawn(electron, [join(dir, 'main.cjs')], { shell: process.platform === 'win32' })
  child.stdout.on('data', (d) => (text += d))
  child.on('close', () => resolve(text))
})
rmSync(dir, { recursive: true, force: true })
const line = output.split('\n').find((l) => l.startsWith('RESULT '))
const r = line ? JSON.parse(line.slice(7)) : { error: 'no result' }

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(64)} ${JSON.stringify(actual)}`)
}
if (r.error) {
  console.log(`FAIL the recorder ran: ${r.error}`)
  process.exit(1)
}
/* The file plays from when the mic opens: talking 1.0-3.0s, a pause to
   3.8s, talking to 5.0s, a dead mic to 5.6s, talking to 6.4s, then quiet. */
check(`talking is heard starting, near 1s (${r.onsetS}s)`, r.onsetS > 0.9 && r.onsetS < 1.6, true)
check(`neither the pause nor the dead mic ends it (${r.clipS}s recorded)`, r.clipS > 7.4, true)
check(`the end comes about 1.5s after the last word (${r.clipS}s)`, r.clipS < 8.9, true)
check('a guess was taken in the pause in the middle, and dropped', r.guesses.length >= 2 && r.guesses[0] < 4.5, true)
check(`the last guess, taken in the final pause, is what gets used (${r.guesses.at(-1)}s of audio)`, r.lastGuessUsed && r.guesses.at(-1) > 6.6, true)
check(`the dead mic was not counted as a pause (${r.dropMs}ms credited)`, r.dropMs > 100, true)
console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} live recorder checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
