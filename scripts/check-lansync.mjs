/**
 * Skills over Wi-Fi (src/main/lansync.ts): two devices, for real, over
 * localhost - SPAKE2 agrees only on the same code, a wrong code fails and
 * three of them end it, the right one pairs both, and from then on a skill
 * made, changed or deleted on one reaches the other by itself. A device that
 * was never paired gets nothing.
 *
 * Run with: node scripts/check-lansync.mjs
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(62)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

const root = mkdtempSync(join(tmpdir(), 'wumpy-lan-'))
const out = join(process.cwd(), '.lansync-check.mjs')
await build({ entryPoints: ['src/main/lansync.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', alias: { '@shared': './src/shared' } })
const L = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

/* ------------------------------------------------------------- SPAKE2 */

let t = Date.now()
const s1 = L.spakeStart('482913', true)
const t1 = L.spakeStart('482913', false)
const ids = { shows: 'a', types: 'b' }
const k1 = L.spakeFinish(s1, t1.msg, ids)
const k2 = L.spakeFinish(t1, s1.msg, ids)
check('the same code: both get the same key', k1.equals(k2), true)
const wrong = L.spakeStart('482914', false)
check('a different code: different keys', L.spakeFinish(s1, wrong.msg, ids).equals(L.spakeFinish(wrong, s1.msg, ids)), false)
check('a value outside the group is refused', L.spakeFinish(s1, 1n, ids), null)
check('zero is refused too', L.spakeFinish(s1, 0n, ids), null)
check('the halves differ every time', L.spakeStart('482913', true).msg !== s1.msg, true)
console.log(`     (one exchange took ${Date.now() - t} ms)`)
check('"482 913" reads as a code', L.pairCode('482 913'), '482913')
check('"48291" is not a code', L.pairCode('48291'), null)

/* ---------------------------------------------------- two devices, for real */

function store() {
  const skills = new Map()
  const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
  return {
    skills,
    write(name, body, at = Date.now()) {
      skills.set(name, { text: `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`, at })
    },
    syncView() {
      const o = {}
      for (const [n, v] of skills) o[n] = { text: v.text, hash: hash(v.text), at: v.at }
      return o
    },
    put(name, text) {
      skills.set(name, { text, at: Date.now() })
      return true
    },
    drop(name) {
      return skills.delete(name)
    }
  }
}

const udp = { a: 47900 + Math.floor(Math.random() * 50), b: 47960 + Math.floor(Math.random() * 30), c: 47995 }
const notes = []
function device(name, port, others, st) {
  const lan = new L.LanSync({
    dir: mkdtempSync(join(root, `${name}-`)),
    store: st,
    name,
    log: (l) => process.env.LANLOG && console.log(name, l),
    changed: () => undefined,
    note: (text) => notes.push(`${name}: ${text}`),
    port: 0,
    udpPort: port,
    targets: () => others.map((p) => ({ address: '127.0.0.1', port: p })),
    quick: true
  })
  return lan
}
const sa = store()
const sb = store()
sa.write('standup', 'The morning standup')
sb.write('recipe', 'How I like recipes written')
const A = device('desk', udp.a, [udp.b, udp.c], sa)
const B = device('laptop', udp.b, [udp.a, udp.c], sb)
await A.start()
await B.start()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await wait(50)
  }
  return false
}

const shown = A.show()
check('a code is six digits', /^\d{6}$/.test(shown.code), true)
const bad = String((Number(shown.code) + 1) % 1_000_000).padStart(6, '0')
const r1 = await B.join(bad)
check('a wrong code does not pair', [r1.ok, r1.message], [false, 'That code did not match.'])
check('nobody is paired after a wrong code', [A.peers().length, B.peers().length], [0, 0])

const r2 = await B.join(shown.code)
check('the right code pairs', r2.ok, true)
check('it says who with, and what moved', r2.message.replace(/\/\w+/g, '/x'), 'Paired with **desk**: got /x; shared /x.')
check('both know each other', [A.peers().map((p) => p.name), B.peers().map((p) => p.name)], [['laptop'], ['desk']])
check('the one showing the code is told', notes.includes('desk: Paired with **laptop**. Skills sync over Wi-Fi now.'), true)
check('the first sync swapped both skills', [[...sa.skills.keys()].sort(), [...sb.skills.keys()].sort()], [['recipe', 'standup'], ['recipe', 'standup']])

/* By itself, from here on. */
sa.write('hangman', 'Playing hangman out loud')
A.nudge()
check('a new skill on one reaches the other by itself', await until(() => sb.skills.has('hangman')), true)
sb.write('standup', 'The morning standup, shorter', Date.now() + 1000)
B.nudge()
check('an edit on the other comes back by itself', await until(() => sa.skills.get('standup')?.text.includes('shorter')), true)
sa.drop('recipe')
A.nudge()
check('a deletion follows', await until(() => !sb.skills.has('recipe')), true)
check('and nothing else was lost', [[...sa.skills.keys()].sort(), [...sb.skills.keys()].sort()], [['hangman', 'standup'], ['hangman', 'standup']])
const now = await A.syncAll()
check('/sync now: up to date', now.map((r) => r.message), ['up to date'])

/* Somebody else on the Wi-Fi, never paired. */
const sc = store()
const C = device('stranger', udp.c, [udp.a, udp.b], sc)
await C.start()
await wait(400)
check('an unpaired device gets nothing', sc.skills.size, 0)
const peerPort = await new Promise((resolve) => {
  const port = A['tcpPort']
  resolve(port)
})
const answer = await new Promise((resolve) => {
  const s = createConnection({ host: '127.0.0.1', port: peerPort }, () => s.write(JSON.stringify({ t: 'hello', id: C.id, n: 'x' }) + '\n'))
  let buf = ''
  s.on('data', (d) => (buf += d))
  s.on('close', () => resolve(buf.trim()))
})
check('a hello from an unpaired device is turned away', JSON.parse(answer), { t: 'unknown' })

/* Three wrong codes end it. */
const again = A.show()
const badly = (n) => String((Number(again.code) + n) % 1_000_000).padStart(6, '0')
const tries = []
for (const n of [1, 2, 3]) tries.push((await C.join(badly(n))).message)
check('each wrong code is told', tries, ['That code did not match.', 'That code did not match.', 'That code did not match.'])
check('after three wrong codes the code is cancelled', await until(() => notes.some((n) => n.startsWith('desk: Pairing code cancelled'))), true)
const late = await C.join(again.code)
check('and even the right one no longer works', late.ok, false)

check('unpair forgets the device', [A.unpair('laptop'), A.peers().length], [1, 0])

A.stop()
B.stop()
C.stop()
rmSync(root, { recursive: true, force: true })
if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall wifi sync checks pass')
process.exit(0)
