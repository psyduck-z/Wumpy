/**
 * A whole spoken conversation, run for real in Chromium: the hook that
 * runs it (useVoiceTurn), the recorder, the chimes and the speaker, on a
 * fake microphone playing a made-up voice, with Wumpy's main process, the
 * transcriber, the model and Magpie stood in for. No sound is played
 * (--disable-audio-output) and no real microphone is opened.
 *
 * The voice asks something, is answered, talks over the answer with a
 * second question, is answered again, and then a hold ends it. The log
 * lines the conversation writes are what is checked: that each step comes,
 * in order, and nothing hangs.
 *
 * Needs Electron, so it is not part of `npm run typecheck`:
 *   node scripts/check-conversation-live.mjs
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SR = 48000
const dir = mkdtempSync(join(tmpdir(), 'wumpy-conversation-'))
const repo = resolve('.')

/* ------------------------------------------------------------ the voice */

let seed = 5
const noise = () => {
  seed = (seed * 16807) % 2147483647
  return (seed / 2147483647) * 2 - 1
}
const parts = []
const room = (s) => parts.push(Float32Array.from({ length: Math.round(s * SR) }, () => noise() * 0.0026))
const talk = (s, loud = 0.25) =>
  parts.push(
    Float32Array.from({ length: Math.round(s * SR) }, (_, i) => {
      const t = i / SR
      const envelope = (0.5 - 0.5 * Math.cos(2 * Math.PI * 4.5 * t)) ** 0.7
      const f = 120 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t))
      let v = 0
      for (let k = 1; k < 16; k++) v += (0.6 / k) * Math.sin(2 * Math.PI * k * f * t + k) * (k >= 4 && k <= 7 ? 1.6 : 1)
      return loud * envelope * v + noise() * 0.0026
    })
  )
/* From when the mic opens: room while "talk now" plays, the first
   question, quiet while it is heard and answered, the second question over
   the answer, and quiet to the end. */
room(1.6)
talk(2.0)
room(5.0)
talk(1.6)
/* A cough in the middle of the second answer: talked over, but not a
   question, so the answer carries on. */
room(3.8)
talk(0.35)
/* Later, a sentence the transcriber makes nothing of: it says so. */
room(19.6)
talk(1.4, 0.1)
room(30)
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

/* ---------------------------------------------------- the page around it */

writeFileSync(
  join(dir, 'entry.tsx'),
  `
import { createRoot } from 'react-dom/client'
import { useVoiceTurn } from ${JSON.stringify(join(repo, 'src/renderer/src/hooks/useVoiceTurn'))}
import { voiceView } from ${JSON.stringify(join(repo, 'src/renderer/src/voiceview'))}

const t0 = performance.now()
const at = () => ((performance.now() - t0) / 1000).toFixed(2)
const say = (line) => console.log('EVENT ' + at() + ' ' + line)

/* Wumpy's main process, stood in for. */
const audioListeners = []
let turn = () => {}
let heardCount = 0
;(window as any).wumpy = {
  voice: {
    start: async () => ({ kind: 'ready' }),
    log: (line) => say(line),
    micState: async () => ({ mic: 'none', earbudsOut: null }),
    transcribe: async (audio) => {
      await new Promise((r) => setTimeout(r, 350))
      /* As long as the voice in it: a question, or a cough heard as "Mm-hmm." */
      /* By how much voice is in it: a question, or a cough heard as
         "Mm-hmm." - and anything after half a minute, the mumble at the
         end, as no words at all. */
      const pcm = new Int16Array(audio, 44)
      let voiced = 0
      for (const v of pcm) if (Math.abs(v) > 1000) voiced++
      const seconds = voiced / 16000
      const text = performance.now() - t0 > 30000 ? '' : seconds > 0.6 ? 'question ' + ++heardCount : 'Mm-hmm.'
      return { text, heard: text, polished: false, polishRefused: false, confidence: 1, ms: 350 }
    },
    speak: async () => null,
    speakStream: async (id, text) => {
      /* Magpie: a tone as long as the words would take, in four pieces. */
      const seconds = Math.min(6, 0.065 * text.length)
      const n = Math.round(seconds * 22050)
      const all = new Int16Array(n)
      for (let i = 0; i < n; i++) all[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 22050))
      const quarter = Math.ceil(n / 4)
      for (let k = 0; k < 4; k++) {
        await new Promise((r) => setTimeout(r, k ? 60 : 300))
        const piece = all.slice(k * quarter, (k + 1) * quarter)
        for (const l of audioListeners) l({ id, pcm: piece.buffer })
      }
      return { pieces: 4, rate: 22050, firstMs: 300, ms: 480, streamed: true }
    },
    onAudio: (cb) => {
      audioListeners.push(cb)
      return () => {}
    },
    onTurn: (cb) => {
      turn = cb
      return () => {}
    }
  },
  music: { hold: async () => {}, release: async () => {} },
  settings: { get: async () => ({ speakRate: 1.15 }) }
}

/* The model, stood in for: an answer written word by word. */
const messages = []
let writing = null
const deps = {
  send: (text) => {
    say('SENT ' + text)
    messages.push({ id: 'u' + messages.length, role: 'user', content: text, createdAt: Date.now() })
    const answer = { id: 'a' + messages.length, role: 'assistant', content: '', createdAt: Date.now() }
    const words = 'Sure. The answer to that is a long one, so here it is, said slowly enough to talk over. And there is more after that, too. Then a last part, which goes on a little longer still, so that it is still being written.'.split(' ')
    let i = 0
    writing = setInterval(() => {
      if (i === 0) messages.push(answer)
      answer.content = words.slice(0, ++i).join(' ')
      if (i >= words.length) {
        clearInterval(writing)
        writing = null
      }
    }, 220)
  },
  streaming: () => writing !== null,
  messages: () => messages.slice(),
  stop: () => {
    say('STOPPED WRITING')
    clearInterval(writing)
    writing = null
  }
}

function App() {
  useVoiceTurn(deps)
  return null
}
createRoot(document.getElementById('root')).render(<App />)

/* The gestures: a hold to start, a repeat report of it, and a hold to end. */
setTimeout(() => { say('GESTURE start'); turn() }, 500)
setTimeout(() => { say('GESTURE repeated report'); turn() }, 900)
setTimeout(() => { say('GESTURE end'); turn() }, 42000)
setInterval(() => {
  const v = voiceView()
  if (v.stage === 'done') { say('STAGE done'); setTimeout(() => say('FINISHED'), 300) }
}, 250)
setTimeout(() => say('FINISHED timeout'), 52000)
`
)
await build({
  entryPoints: [join(dir, 'entry.tsx')],
  bundle: true,
  format: 'iife',
  outfile: join(dir, 'page.js'),
  logLevel: 'error',
  jsx: 'automatic',
  nodePaths: [join(repo, 'node_modules')],
  alias: { '@shared': join(repo, 'src/shared') },
  define: { 'process.env.NODE_ENV': '"production"' }
})
writeFileSync(join(dir, 'page.html'), '<!doctype html><div id="root"></div><script src="page.js"></script>')
writeFileSync(
  join(dir, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', ${JSON.stringify(join(dir, 'talk.wav'))})
app.commandLine.appendSwitch('disable-audio-output')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  w.webContents.on('console-message', (e) => {
    if (e.message.startsWith('EVENT ')) console.log(e.message.slice(6))
    else if (e.level === 'error') console.log('ERROR ' + e.message)
    if (e.message.includes(' FINISHED')) app.quit()
  })
  await w.loadFile(${JSON.stringify(join(dir, 'page.html'))})
  setTimeout(() => app.quit(), 58000)
})`
)

const electron = join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const output = await new Promise((done) => {
  let text = ''
  const child = spawn(electron, [join(dir, 'main.cjs')], { shell: process.platform === 'win32' })
  child.stdout.on('data', (d) => (text += d))
  child.on('close', () => done(text))
})
rmSync(dir, { recursive: true, force: true })

const events = output
  .split('\n')
  .map((l) => /^(\d+\.\d+) (.*)$/.exec(l) ?? (l.startsWith('ERROR ') ? [l, '0', l] : null))
  .filter(Boolean)
  .map(([, t, what]) => ({ t: Number(t), what }))
if (process.argv.includes('--show')) for (const e of events) console.log(`  ${e.t.toFixed(2)}  ${e.what}`)
const first = (re) => events.find((e) => re.test(e.what))
const all = (re) => events.filter((e) => re.test(e.what))

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${JSON.stringify(actual)}`)
}
const before = (a, b) => Boolean(a && b && a.t <= b.t)
const started = first(/voice turn: started$/)
const live = first(/voice turn: microphone live after/)
const talkNow = first(/voice turn: talk now:/)
const heard = all(/voice turn: heard "question/)
const sent = all(/^SENT /)
const over = first(/voice turn: talked over it/)
const stoppedWriting = first(/^STOPPED WRITING/)
const ended = first(/voice turn: held again .* the conversation ends/)
const done = first(/^STAGE done/)

check('nothing went wrong on the page', all(/^ERROR|voice turn: failed/).map((e) => e.what), [])
check('a hold starts a conversation', Boolean(started), true)
check('and the earbuds reporting it twice counts once', Boolean(first(/a second gesture \d+ms after the last, taken as the same one/)), true)
check('the mic comes on, then "talk now"', before(live, talkNow), true)
check('the first question is heard, and sent', heard.length >= 1 && sent[0]?.what === 'SENT question 1', true)
check(`  ready ${heard[0] ? /(\d+)ms after the pause/.exec(heard[0].what)?.[1] : '?'}ms after the pause, from the early guess`, Boolean(heard[0] && /from the guess/.test(heard[0].what)), true)
check('talking over the answer stops it', Boolean(over) && before(sent[0], over), true)
check('and once the question is heard, the old answer stops being written', before(over, stoppedWriting) && before(stoppedWriting, sent[1]), true)
const carried = first(/voice turn: "Mm-hmm\." was not a question: carrying on with the answer/)
check('a cough over the second answer: it carries on', Boolean(carried) && before(sent[1], carried), true)
check('without stopping it being written, or sending anything', all(/^STOPPED WRITING/).length === 1 && sent.length === 2, true)
check('the second question is heard, with no gesture in between', sent[1]?.what === 'SENT question 2', true)
check('a sentence that comes back as no words: it says so', Boolean(first(/voice turn: a whole sentence came back as no words: said so/)), true)
check('it is answered too', all(/voice turn: speaking the answer/).length >= 2, true)
check('a hold ends it', Boolean(ended) && before(sent[1], ended), true)
check('with the bar saying it is finished', before(ended, done), true)
check('it ended on time, not by the test giving up', Boolean(first(/ FINISHED$|^FINISHED$/)) && !first(/FINISHED timeout/), true)
console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} live conversation checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
