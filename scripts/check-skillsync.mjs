/**
 * Skills on every device (src/shared/skillsync.ts, src/main/skillsync.ts):
 * the merge rules, then two devices syncing for real through a stand-in
 * for GitHub's gist API - a skill made on one appears on the other, an edit
 * follows it, a deletion follows it, an edit beats a deletion, and a shipped
 * skill nobody changed never overwrites one somebody did.
 *
 * Run with: node scripts/check-skillsync.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(62)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

const root = mkdtempSync(join(tmpdir(), 'wumpy-sync-'))
async function load(entry, name, userData) {
  const shim = join(root, `electron-${name}.mjs`)
  writeFileSync(
    shim,
    `export const app = { getPath: () => ${JSON.stringify(userData)} }\n` +
      `export const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).slice(4) }\n`
  )
  const out = join(process.cwd(), `.sync-${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', alias: { electron: shim, '@shared': './src/shared' } })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

/* ------------------------------------------------------------- the rules */

const P = await load('src/shared/skillsync.ts', 'shared', root)
const v = (hash, at = 1) => ({ hash, at })
check('new here: shared', P.plan({ a: v('1') }, {}, {}), { a: 'upload' })
check('new there: fetched', P.plan({}, { a: v('1') }, {}), { a: 'download' })
check('the same both sides: nothing', P.plan({ a: v('1') }, { a: v('1') }, { a: '1' }), { a: 'same' })
check('changed here only: shared', P.plan({ a: v('2') }, { a: v('1') }, { a: '1' }), { a: 'upload' })
check('changed there only: fetched', P.plan({ a: v('1') }, { a: v('2') }, { a: '1' }), { a: 'download' })
check('deleted here: deleted there', P.plan({}, { a: v('1') }, { a: '1' }), { a: 'deleteRemote' })
check('deleted there: deleted here', P.plan({ a: v('1') }, { a: { hash: '', at: 5, deleted: true } }, { a: '1' }), { a: 'deleteLocal' })
check('changed both sides: the newer wins (here)', P.plan({ a: v('2', 9) }, { a: v('3', 5) }, { a: '1' }), { a: 'upload' })
check('changed both sides: the newer wins (there)', P.plan({ a: v('2', 5) }, { a: v('3', 9) }, { a: '1' }), { a: 'download' })
check('edited here, deleted there: the edit wins', P.plan({ a: v('2') }, { a: { hash: '', at: 99, deleted: true } }, { a: '1' }), { a: 'upload' })
check('deleted here, edited there: the edit wins', P.plan({}, { a: v('3') }, { a: '1' }), { a: 'download' })
check('first sync, different on each side: the newer', P.plan({ a: v('2', 9) }, { a: v('3', 5) }, {}), { a: 'upload' })
check('a tombstone with nothing here is nothing', P.plan({}, { a: { hash: '', at: 1, deleted: true } }, { a: null }), { a: 'same' })
check('a gist file name per skill', [P.gistFile('grill'), P.nameOfGistFile('grill.SKILL.md'), P.nameOfGistFile('../x.md')], ['grill.SKILL.md', 'grill', null])
check('a broken manifest is an empty one', P.readManifest('{nope'), { version: 1, skills: {} })
check('what it did, in a line', P.summary({ a: 'upload', b: 'download', c: 'deleteLocal', d: 'same' }).line, 'got /b from your other devices; removed /c, deleted on another device; shared /a')

/* -------------------------------------------- two devices, one fake gist */

const gists = new Map()
let nextId = 1
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  const method = init.method ?? 'GET'
  calls.push(`${method} ${u.pathname}`)
  if (!/^Bearer good/.test(init.headers?.Authorization ?? '')) return new Response('{}', { status: 401 })
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const view = (g) => ({ id: g.id, description: g.description, files: Object.fromEntries(Object.entries(g.files).map(([k, c]) => [k, { filename: k, content: c }])) })
  if (u.pathname === '/gists' && method === 'GET') return json([...gists.values()].map((g) => ({ id: g.id, description: g.description, files: {} })))
  if (u.pathname === '/gists' && method === 'POST') {
    const body = JSON.parse(init.body)
    if (body.public !== false) return json({ message: 'should be unlisted' }, 422)
    const g = { id: `g${nextId++}`, description: body.description, files: Object.fromEntries(Object.entries(body.files).map(([k, f]) => [k, f.content])) }
    gists.set(g.id, g)
    return json(view(g), 201)
  }
  const m = /^\/gists\/(\w+)$/.exec(u.pathname)
  if (m && gists.has(m[1])) {
    const g = gists.get(m[1])
    if (method === 'PATCH') {
      for (const [k, f] of Object.entries(JSON.parse(init.body).files)) {
        if (f === null) delete g.files[k]
        else g.files[k] = f.content
      }
    }
    return json(view(g))
  }
  return json({}, 404)
}

async function device(label) {
  const dir = join(root, label)
  mkdirSync(dir, { recursive: true })
  const { SkillStore } = await load('src/main/skills.ts', `store-${label}`, dir)
  const { SkillSync } = await load('src/main/skillsync.ts', `sync-${label}`, dir)
  const store = new SkillStore()
  store.list()
  const sync = new SkillSync(store, () => {})
  sync.setToken('ghp_' + 'x'.repeat(30))
  /* The fake GitHub only takes "good..." tokens; one kept by setToken is replaced for the test. */
  writeFileSync(join(dir, 'github-token.bin'), 'enc:good-token')
  return { dir, store, sync }
}

const laptop = await device('laptop')
const windows = await device('windows')
const has = (d, name) => d.store.get(name)?.body ?? null

check('a token that is not one is refused', laptop.sync.setToken('hello').ok, false)
let r = await laptop.sync.sync()
check('the first sync makes one unlisted gist', [r.ok, gists.size], [true, 1])
check('and shares nothing shipped and untouched', Object.keys([...gists.values()][0].files).sort(), ['README.md', 'wumpy-skills.json'])

laptop.store.save({ name: 'standup', description: 'Write my standup. Use when I paste what I did.', body: 'Yesterday / Today / Blockers from: $ARGUMENTS', argumentHint: '<what I did>' })
r = await laptop.sync.sync()
check('a skill made on the laptop is shared', [r.message, Boolean([...gists.values()][0].files['standup.SKILL.md'])], ['shared /standup', true])
r = await windows.sync.sync()
check('the other device finds the same gist', gists.size, 1)
check('and gets the skill', [r.message, has(windows, 'standup'), r.changed], ['got /standup from your other devices', 'Yesterday / Today / Blockers from: $ARGUMENTS', true])
check('with its argument hint', windows.store.get('standup')?.argumentHint, '<what I did>')
r = await windows.sync.sync()
check('a second sync with nothing new changes nothing', [r.message, r.changed], ['already the same everywhere', false])

windows.store.save({ name: 'standup', body: 'Three bullets from: $ARGUMENTS' })
await windows.sync.sync()
await laptop.sync.sync()
check('an edit on one device reaches the other', has(laptop, 'standup'), 'Three bullets from: $ARGUMENTS')

/* A shipped skill: changed on Windows; the laptop's copy, untouched, must not win. */
const grillWin = join(windows.dir, 'skills', 'grill', 'SKILL.md')
writeFileSync(grillWin, readFileSync(grillWin, 'utf8') + '\nAlways ask about money first.\n')
utimesSync(grillWin, new Date(1000), new Date(1000)) /* older than the laptop's install, on purpose */
await windows.sync.sync()
await laptop.sync.sync()
check('a shipped skill changed on one device reaches the other', /money first/.test(has(laptop, 'grill') ?? ''), true)
check('and an untouched copy never overwrites the change', /money first/.test(readFileSync(grillWin, 'utf8')), true)

laptop.store.save({ name: 'standup', body: '' })
await laptop.sync.sync()
r = await windows.sync.sync()
check('a skill deleted on one device is deleted on the other', [has(windows, 'standup'), r.message], [null, 'removed /standup, deleted on another device'])
check('and stays deleted', [(await laptop.sync.sync()).message, has(laptop, 'standup')], ['already the same everywhere', null])

laptop.store.save({ name: 'recipes', body: 'Metric units.' })
await laptop.sync.sync()
await windows.sync.sync()
windows.store.save({ name: 'recipes', body: 'Metric units, and serves four.' })
laptop.store.save({ name: 'recipes', body: '' })
await laptop.sync.sync()
await windows.sync.sync()
await laptop.sync.sync()
check('edited on one, deleted on the other: the edit is kept everywhere', [has(laptop, 'recipes'), has(windows, 'recipes')], ['Metric units, and serves four.', 'Metric units, and serves four.'])

writeFileSync(join(laptop.dir, 'github-token.bin'), 'enc:bad-token')
r = await laptop.sync.sync()
check('a refused token is said plainly', [r.ok, /did not accept the token/.test(r.message)], [false, true])

/* -------------------------------------------------------------- wiring */
const read = (f) => readFileSync(f, 'utf8')
const main = read('src/main/index.ts')
const cmds = read('src/renderer/src/commands.ts')
check('off until they turn it on', /skillSync: false/.test(read('src/shared/defaults.ts')), true)
check('every 30 minutes and after a save, only when on', /setInterval\(\(\) => void syncInBackground\('every 30 minutes'\), 30 \* 60_000\)/.test(main) && /if \(result\.ok\) syncSoon\(\)/.test(main) && /settings\.get\('skillSync'\) !== true\) return/.test(main), true)
check('a sync that changed skills here refreshes the commands', /if \(result\.changed\) panel\?\.send\(IPC\.skillsChanged, null\)/.test(main) && /window\.wumpy\.skills\.onChanged\(refresh\)/.test(read('src/renderer/src/App.tsx')), true)
check('the token never goes in input history', /\/\^\\\/sync\\s\+\(key\|token\)\\b\/i\.test\(entry\)/.test(read('src/renderer/src/hooks/useInputHistory.ts')), true)
check('and the model may never run /sync', /NEVER_PROPOSED = new Set\(\['key', 'approve', 'open', 'sync'\]\)/.test(cmds), true)
check('it is said that an unlisted gist can be read by anyone with the link', /anyone with its link could read them/.test(read('src/renderer/src/App.tsx')), true)

rmSync(root, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'all skill sync checks correct' : `${failed} skill sync checks FAILED`}`)
process.exit(failed ? 1 : 0)
