/**
 * One network of devices, names of theirs, and settings that follow them -
 * three requests in one:
 *
 *   "device 1 pairs to device 2, so if device 3 pairs with device 2, device 3
 *    then becomes paired with 1 and 2 ... everything becomes a network"
 *   "allow me to rename the devices I'm paired with ... my work laptop, my
 *    personal laptop"
 *   "a feature where you can sync your settings to the other devices too"
 *
 * Three real LanSync devices on this machine (and a fourth for later), over
 * localhost: paired in a chain, the ends meet and sync with the middle one
 * switched off; a rename on one reaches all; a device taken out on one is
 * taken out on all, and a code brings it back; settings changed on two
 * devices at once both survive, and the ones that belong to one machine
 * never travel.
 *
 * Run with: node scripts/check-lanmesh.mjs
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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(66)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

async function load(entry, tag) {
  const out = join(process.cwd(), `.lanmesh-${tag}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', alias: { '@shared': './src/shared' } })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const L = await load('src/main/lansync.ts', 'lan')
const C = await load('src/renderer/src/commands.ts', 'cmd')
const S = await load('src/shared/settingsync.ts', 'set')
const D = await load('src/shared/defaults.ts', 'def')
const DEF = D.DEFAULT_SETTINGS

/* ------------------------------------------------------------- the command */

const cmd = (t) => {
  const r = C.parseCommand(t)
  return r && { action: r.action, arg: r.arg, to: r.to, kind: r.kind }
}
check('/sync rename desk to Work laptop', cmd('/sync rename desk to Work laptop'), { action: 'rename', arg: 'desk', to: 'Work laptop', kind: 'sync' })
check('/sync rename this to Personal laptop', cmd('/sync rename this to Personal laptop'), { action: 'rename', arg: 'this', to: 'Personal laptop', kind: 'sync' })
check('a device whose name has spaces', cmd('/sync rename old desk pc to Desk'), { action: 'rename', arg: 'old desk pc', to: 'Desk', kind: 'sync' })
check('without "to": how to say it', cmd('/sync rename desk')?.kind, 'error')
check('/sync unpair Work laptop', cmd('/sync unpair Work laptop'), { action: 'unpair', arg: 'Work laptop', kind: 'sync' })

/* ------------------------------------------------- settings, by themselves */

const t0 = 1_700_000_000_000
check('nothing changed yet: nothing to share', S.shareText(DEF, S.firstStamps(DEF, t0)), null)
const tuned = { ...DEF, model: 'some/model', thinking: true, dock: 'left', hotkeys: ['Ctrl+K'], approvalMode: 'all' }
const first = S.firstStamps(tuned, t0)
check('the first time, what differs from the default is stamped', Object.keys(first).sort(), ['model', 'thinking'])
check('where it docks, its hotkeys and what runs unasked are never shared', Object.keys(S.readShared(S.shareText(tuned, first).text, t0)).sort(), ['model', 'thinking'])
const forged = JSON.stringify({ v: 1, s: { approvalMode: ['all', t0], hotkeys: [['x'], t0], model: ['m', t0], speakRate: [99, t0], thinking: ['yes', t0] } })
check('sent anyway, they are refused - and so are impossible values', Object.keys(S.readShared(forged, t0)), ['model'])
check('a clock a week ahead does not win', S.readShared(JSON.stringify({ v: 1, s: { model: ['m', t0 + 7 * 86_400_000] } }), t0), {})
check('not JSON: nothing', S.readShared('{nope'), null)

/* Changed on two devices since: each keeps the other's change too. */
const a = { values: { ...DEF, model: 'a/model' }, stamps: { model: t0 + 10 } }
const b = { values: { ...DEF, thinking: true }, stamps: { thinking: t0 + 20 } }
const into = (dev, from) => {
  const m = S.merge(dev.values, dev.stamps, S.readShared(S.shareText(from.values, from.stamps).text, t0 + 100))
  dev.values = { ...dev.values, ...m.patch }
  dev.stamps = m.stamps
  return m.changed
}
check('the laptop takes the desk\'s change', into(a, b), ['thinking'])
check('the desk takes the laptop\'s', into(b, a), ['model'])
check('and both end the same, to the byte', S.shareText(a.values, a.stamps).text === S.shareText(b.values, b.stamps).text, true)
b.values.model = 'b/model'
b.stamps.model = t0 + 5
check('an older change does not undo a newer one', [into(a, b), a.values.model], [[], 'a/model'])
const tie = (v) => ({ values: { ...DEF, model: v }, stamps: { model: t0 } })
const [x, y] = [tie('x/one'), tie('y/two')]
into(x, y)
into(y, x)
check('changed at the very same moment: both still agree', [x.values.model, y.values.model], ['y/two', 'y/two'])
check('in words', S.settingWords(['model', 'thinking', 'speakVoice']), 'the model, thinking, the voice')

/* ------------------------------------------------ four devices, for real */

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
function store(label) {
  const me = { skills: new Map(), values: { ...DEF }, stamps: {}, from: [] }
  me.write = (name, body) => me.skills.set(name, { text: `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`, at: Date.now() })
  me.set = (patch) => {
    S.stampChanges(me.values, { ...me.values, ...patch }, me.stamps, Date.now())
    Object.assign(me.values, patch)
  }
  me.store = {
    syncView() {
      const o = {}
      for (const [n, v] of me.skills) o[n] = { text: v.text, hash: hash(v.text), at: v.at }
      const s = S.shareText(me.values, me.stamps)
      if (s) o['@settings'] = { ...s, hash: hash(s.text) }
      return o
    },
    put(name, text, from) {
      if (name !== '@settings') return me.skills.set(name, { text, at: Date.now() }), true
      const read = S.readShared(text)
      if (!read) return false
      const m = S.merge(me.values, me.stamps, read)
      Object.assign(me.values, m.patch)
      me.stamps = m.stamps
      if (m.changed.length) me.from.push(from)
      return true
    },
    drop(name) {
      return name.startsWith('@') ? false : me.skills.delete(name)
    }
  }
  me.label = label
  return me
}

const root = mkdtempSync(join(tmpdir(), 'wumpy-mesh-'))
const base = 46100 + Math.floor(Math.random() * 600)
const ports = { one: base, two: base + 1, three: base + 2, four: base + 3 }
const notes = []
const devices = {}
function device(label) {
  const st = store(label)
  const lan = new L.LanSync({
    dir: mkdtempSync(join(root, `${label}-`)),
    store: st.store,
    name: label,
    log: (l) => process.env.LANLOG && console.log(label, l),
    changed: () => undefined,
    note: (text) => notes.push(`${label}: ${text}`),
    port: 0,
    udpPort: ports[label],
    targets: () => Object.entries(ports).filter(([k]) => k !== label).map(([, port]) => ({ address: '127.0.0.1', port })),
    quick: true
  })
  devices[label] = { lan, st }
  return { lan, st }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await wait(60)
  }
  return false
}
const names = (lan) => lan.peers().map((p) => p.name).sort()

const one = device('one')
const two = device('two')
const three = device('three')
for (const d of [one, two, three]) await d.lan.start()

try {
  one.st.write('standup', 'The morning standup')
  const p1 = await two.lan.join(one.lan.show().code)
  check('one and two pair with a code', p1.ok, true)
  const p2 = await three.lan.join(two.lan.show().code)
  check('then three pairs with two', p2.ok, true)

  check('three is paired with one too, with no code', await until(() => names(three.lan).includes('one')), true)
  check('and one with three', await until(() => names(one.lan).includes('three')), true)
  check('every device knows the other two', [names(one.lan), names(two.lan), names(three.lan)], [['three', 'two'], ['one', 'three'], ['one', 'two']])
  check('it says how it met them', one.lan.peers().find((p) => p.name === 'three')?.via, 'two')
  check('and tells them so', notes.some((n) => n.startsWith('one: Now paired with **three** too, through **two**')), true)
  check('one and three sync directly', await until(() => one.lan.peers().find((p) => p.name === 'three')?.synced), true)

  /* The one in the middle, switched off: the ends still sync. */
  two.lan.stop()
  one.st.write('recipe', 'How I like recipes written')
  one.lan.nudge()
  check('with two off, a skill made on one reaches three', await until(() => three.st.skills.has('recipe')), true)
  await two.lan.start()

  /* Names of theirs. */
  const r = one.lan.rename('three', 'Work laptop')
  check('one renames three to "Work laptop"', [r.ok, r.name, r.was], [true, 'Work laptop', 'three'])
  check('two calls it that too', await until(() => names(two.lan).includes('Work laptop')), true)
  check('and three knows what it is called now', await until(() => three.lan.me().name === 'Work laptop'), true)
  check('found by its new name', one.lan.peers().find((p) => p.name === 'Work laptop')?.host, 'three')
  one.lan.rename('two', 'Middle')
  check('"met through" follows a rename of the one in the middle', await until(() => three.lan.peers().find((p) => p.host === 'one')?.via === 'Middle'), true)
  const mine = two.lan.rename('this', 'Personal laptop')
  check('two names itself', mine.ok, true)
  check('and one hears it', await until(() => names(one.lan).includes('Personal laptop')), true)
  check('a name is one short line', L.deviceName(' **My\n  `desk`** ' + 'x'.repeat(80)).length <= 40 && !/[*`\n]/.test(L.deviceName('**a**\n`b`')), true)
  check('renaming nothing that exists says so', one.lan.rename('nobody', 'x').ok, false)

  /* Settings: changed on two devices at once, both survive everywhere. */
  one.st.set({ model: 'nvidia/one-model', dock: 'left' })
  three.st.set({ thinking: true, hotkeys: ['Super+Z'] })
  one.lan.nudge()
  three.lan.nudge()
  const all = (k, v) => [one, two, three].every((d) => JSON.stringify(d.st.values[k]) === JSON.stringify(v))
  check('the model chosen on one reaches every device', await until(() => all('model', 'nvidia/one-model')), true)
  check('thinking turned on at three, too', await until(() => all('thinking', true)), true)
  check('but where one docks stays on one', [two.st.values.dock, three.st.values.dock], [DEF.dock, DEF.dock])
  check('and three\'s hotkeys stay on three', [one.st.values.hotkeys, two.st.values.hotkeys], [DEF.hotkeys, DEF.hotkeys])
  check('the device it came from is named', two.st.from.length > 0 && two.st.from.every((f) => ['one', 'Work laptop', 'Personal laptop'].includes(f)), true)

  /* Taken out of the network on one: out on all. */
  const out = one.lan.unpair('Work laptop')
  check('one takes three out', out, 1)
  check('and two forgets it as well', await until(() => !names(two.lan).includes('Work laptop')), true)
  check('nobody introduces it back', (await wait(1500), [names(one.lan), names(two.lan)]), [['Personal laptop'], ['one']])
  const tried = await three.lan.syncAll()
  check('three can no longer sync with either', tried.every((t) => !t.ok), true)

  /* A code brings it back - to all of them. */
  const back = await three.lan.join(one.lan.show().code)
  check('paired again with a code', back.ok, true)
  check('and two has it back too, by introduction', await until(() => names(two.lan).includes('Work laptop')), true)

  /* A fourth device joins through any of them. */
  const four = device('four')
  await four.lan.start()
  four.st.write('hangman', 'Playing hangman out loud')
  check('four pairs with three only', (await four.lan.join(three.lan.show().code)).ok, true)
  check('and is soon paired with all three', await until(() => names(four.lan).length === 3 && [one, two].every((d) => d.lan.peers().some((p) => p.host === 'four'))), true)
  check('its skill reaches one', await until(() => one.st.skills.has('hangman')), true)
  check('and four has the settings the network chose', await until(() => four.st.values.model === 'nvidia/one-model' && four.st.values.thinking === true), true)

  /* Leaving: this device forgets every pairing. */
  check('/sync unpair with no name: four leaves', four.lan.unpair(), 3)
  check('and holds no pairing at all', four.lan.peers().length, 0)
} finally {
  for (const d of Object.values(devices)) d.lan.stop()
  rmSync(root, { recursive: true, force: true })
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\none network: paired once, introduced to the rest, renamed and removed everywhere, settings shared')
process.exit(0)
