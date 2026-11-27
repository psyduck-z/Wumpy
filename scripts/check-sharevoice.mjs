/**
 * The voice calibration, shared with their other devices: "allow me to share
 * voice (calibrated) so that i don't have to calibrate it for every one".
 *
 * Two real LanSync devices on this machine, paired with a code, each with a
 * store that carries "@voice" beside its skills the way main/index.ts wires
 * it. Calibrated on one, the other gets it; calibrated again on the other,
 * the newer one wins back; forgetting on one forgets nothing on the other;
 * and what the other device sends is checked before it is believed.
 *
 * Run with: node scripts/check-sharevoice.mjs
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(64)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

async function load(entry, tag) {
  const out = join(process.cwd(), `.sharevoice-${tag}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', alias: { '@shared': './src/shared' } })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const L = await load('src/main/lansync.ts', 'lan')
const V = await load('src/shared/voiceprint.ts', 'voice')
const SK = await load('src/shared/skillsync.ts', 'sum')

const MODEL = 'campplus-voxceleb-16k'
const vec = (seed) => Array.from({ length: 192 }, (_, i) => Math.round(Math.sin(seed * 7 + i) * 1e5) / 1e5)
const calibration = (seed, at) => ({
  model: MODEL,
  clips: Array.from({ length: V.ENROL_CLIPS }, (_, i) => ({ v: vec(seed + i * 0.01), at: at + i, ms: 3000, device: `mic ${seed}`, enrolled: true }))
})

/* --------------------------------------------------------- what is believed */

const good = V.shareText(calibration(1, 1_700_000_000_000))
check('a whole calibration is shared', good !== null, true)
check('half a calibration is not', V.shareText({ model: MODEL, clips: calibration(1, 1).clips.slice(0, 2) }), null)
check('learned clips do not travel, only the sentences read', JSON.parse(V.shareText({ model: MODEL, clips: [...calibration(1, 5).clips, { v: vec(9), at: 9, ms: 1, device: 'x' }] }).text).clips.length, V.ENROL_CLIPS)
check('it reads back as the same sentences', V.readShared(good.text, MODEL)?.length, V.ENROL_CLIPS)
const tamper = (f) => {
  const o = JSON.parse(good.text)
  f(o)
  return V.readShared(JSON.stringify(o), MODEL)
}
check('another model: refused', V.readShared(good.text, 'some-other-model'), null)
check('not JSON: refused', V.readShared('{nope', MODEL), null)
check('too few sentences: refused', tamper((o) => (o.clips = o.clips.slice(0, 2))), null)
check('a vector of the wrong length: refused', tamper((o) => o.clips[2].v.pop()), null)
check('a number that is not one: refused', tamper((o) => (o.clips[1].v[5] = 'x')), null)
check('an impossible date: refused', tamper((o) => (o.clips[0].at = -1)), null)
check('a huge device name is cut short', tamper((o) => (o.clips[0].device = 'm'.repeat(5000)))?.[0].device.length, 120)
check('the sync says it plainly', SK.summary({ '@voice': 'download' }).line, 'got your voice calibration')

/* ------------------------------------------------ two devices, for real */

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
function device(label) {
  const skills = new Map()
  const me = { print: { model: MODEL, clips: [] }, share: true, took: 0 }
  me.store = {
    syncView() {
      const o = {}
      for (const [n, v] of skills) o[n] = { text: v.text, hash: hash(v.text), at: v.at }
      const s = me.share ? V.shareText(me.print) : null
      if (s) o['@voice'] = { ...s, hash: hash(s.text) }
      return o
    },
    put(name, text) {
      if (name !== '@voice') return skills.set(name, { text, at: Date.now() }), true
      const read = me.share ? V.readShared(text, MODEL) : null
      if (!read) return false
      me.print = V.enrolled(me.print, read)
      me.took++
      return true
    },
    drop(name) {
      return name === '@voice' ? false : skills.delete(name)
    }
  }
  me.label = label
  return me
}

const root = mkdtempSync(join(tmpdir(), 'wumpy-voice-'))
const ports = { a: 48100 + Math.floor(Math.random() * 40), b: 48150 + Math.floor(Math.random() * 40) }
const lan = (d, port, other) =>
  new L.LanSync({
    dir: mkdtempSync(join(root, `${d.label}-`)),
    store: d.store,
    name: d.label,
    log: (l) => process.env.LANLOG && console.log(d.label, l),
    changed: () => undefined,
    port: 0,
    udpPort: port,
    targets: () => [{ address: '127.0.0.1', port: other }],
    quick: true
  })
const laptop = device('laptop')
const desk = device('desk')
const A = lan(laptop, ports.a, ports.b)
const B = lan(desk, ports.b, ports.a)
await A.start()
await B.start()
const voiceOf = (d) => JSON.parse(V.shareText(d.print)?.text ?? '{"clips":[]}').clips.map((c) => c.device)

try {
  laptop.print = calibration(1, Date.now() - 60_000)
  const paired = await B.join(A.show().code)
  check('they pair', paired.ok, true)
  check('pairing brought the calibration across', voiceOf(desk)[0], 'mic 1')
  check('as calibrated sentences, so "only my voice" knows them', V.calibrated(desk.print), true)
  check('and said so in words', /your voice calibration/.test(paired.message), true)

  desk.print = calibration(2, Date.now())
  await B.syncAll()
  check('calibrated again on the desk: the laptop takes the newer one', voiceOf(laptop)[0], 'mic 2')

  laptop.print = { model: MODEL, clips: [] }
  await A.syncAll()
  check('forgotten on the laptop: the desk still has it', voiceOf(desk)[0], 'mic 2')
  check('and the laptop is not handed it straight back', voiceOf(laptop).length, 0)

  const before = desk.took
  laptop.print = calibration(3, Date.now() + 1000)
  desk.share = false
  await A.syncAll()
  check('sharing off on the desk: it takes nothing', [desk.took, voiceOf(desk)[0]], [before, 'mic 2'])
} finally {
  A.stop()
  B.stop()
  rmSync(root, { recursive: true, force: true })
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nthe voice calibration goes to their paired devices, and only a real one is taken')
