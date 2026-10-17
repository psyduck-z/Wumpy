/**
 * What Wumpy leaves on the disk, and what happens if it is killed mid-write.
 *
 * Two problems, measured rather than assumed. The user data directory on
 * this machine held 38 MB after eleven days, of which Wumpy's own records
 * were 236 KB - the rest was Chromium's HTTP cache, 26 MB of responses from
 * a dev server, which the renderer's own content security policy forbids it
 * from ever needing. And every store in the app wrote with a bare
 * `writeFileSync` straight over its live file, which truncates first: for
 * the width of that write the file on disk is empty, and `Stop-Process
 * -Force` is how this app is stopped several times an hour.
 *
 * Each reader treats a parse failure as "no file", which is right and is
 * also what makes a torn write invisible. settings.json reads back as
 * DEFAULT_SETTINGS; keys.bin reads back as no keys at all.
 *
 * So: writeAtomic is exercised for real here, and the stores are checked to
 * be using it. The chat folder's two leaks - images whose conversation is
 * gone, and conversations that nothing ever drops - are tested against a
 * real ChatStore in a temporary directory.
 *
 * Run with: npm run check:storage
 */
import { build } from 'esbuild'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'wumpy-storage-'))

const shim = join(dir, 'electron.mjs')
writeFileSync(shim, `export const app = { getPath: () => ${JSON.stringify(dir)} }${NL}`)

const builds = [
  ['src/main/atomic.ts', '.atomic-check.mjs'],
  ['src/main/chats.ts', '.storage-chats.mjs']
]
for (const [entry, outfile] of builds) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    alias: { electron: shim, '@shared': 'src/shared' }
  })
}
const { writeAtomic } = await import(pathToFileURL('.atomic-check.mjs').href)
const { ChatStore } = await import(pathToFileURL('.storage-chats.mjs').href)
for (const [, outfile] of builds) rmSync(outfile, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

/* ------------------------------------------------- the atomic write itself */

const box = join(dir, 'box')
const file = join(box, 'settings.json')

writeAtomic(file, `{"a":1}${NL}`)
check('it writes the file', readFileSync(file, 'utf8'), `{"a":1}${NL}`)
check('and makes the directory on the way', existsSync(box), true)
/* The whole point: nothing is left behind to be read as the real thing. */
check('no temp file survives the write', readdirSync(box), ['settings.json'])

writeAtomic(file, `{"a":2}${NL}`)
check('a second write replaces the first', readFileSync(file, 'utf8'), `{"a":2}${NL}`)
check('and still leaves nothing behind', readdirSync(box), ['settings.json'])

/* keys.bin is a Buffer from safeStorage, not a string, and a Buffer that
   came back as "[object Object]" would be a file of 15 bytes that decrypts
   to nothing - which reads exactly like having no key saved. */
const blob = join(box, 'keys.bin')
writeAtomic(blob, Buffer.from([0, 1, 2, 250, 255]))
check('bytes go through as bytes', [...readFileSync(blob)], [0, 1, 2, 250, 255])

/* A leftover from a write that was interrupted between the open and the
   rename. The next write must overwrite it rather than refuse. */
writeFileSync(`${file}.tmp`, 'half a document')
writeAtomic(file, `{"a":3}${NL}`)
check('a stale temp file is reused, not tripped over', readFileSync(file, 'utf8'), `{"a":3}${NL}`)
check('and is gone afterwards', existsSync(`${file}.tmp`), false)

/* ---------------------------------------------- the stores that use it now */

const SOURCES = {
  'settings': 'src/main/store.ts',
  'the key pool': 'src/main/pool.ts',
  'usage counts': 'src/main/usage.ts',
  'input history': 'src/main/history.ts',
  'the notes file': 'src/main/context.ts',
  'the API keys': 'src/main/keys.ts',
  'chats': 'src/main/chats.ts'
}
for (const [what, path] of Object.entries(SOURCES)) {
  const src = readFileSync(path, 'utf8')
  check(`${what} is written atomically`, /writeAtomic\(/.test(src), true)
  /*
   * And not by the old route. Named with `this.file` or `this.pathFor`
   * rather than any writeFileSync at all, because a store may legitimately
   * write something else - chats.ts writes image files - and the file that
   * must never be truncated in place is its own.
   */
  check(
    `and nothing writes over ${what} in place`,
    /writeFileSync\(\s*(this\.file|this\.pathFor)/.test(src),
    false
  )
}

/* ------------------------------------------------------ the chat directory */

const chats = new ChatStore()
const imageDir = join(dir, 'chats', 'images')

const shot = (name) => ({
  kind: 'image',
  dataUrl: 'data:image/jpeg;base64,QUFBQQ==',
  name,
  width: 8,
  height: 8,
  bytes: 4
})

const saved = chats.save({
  id: 'keeper',
  messages: [{ role: 'user', content: 'look at this', images: [shot('a.jpg')] }]
})
check('a chat with a picture saves', Boolean(saved), true)
const mine = readdirSync(imageDir)
check('and the bytes land beside it', mine.length, 1)

/*
 * THE THREE WAYS AN IMAGE OUTLIVES EVERYTHING THAT COULD REACH IT.
 *
 * delete() takes a conversation's pictures with it, which covers the
 * ordinary case. These are the ones it does not cover: a save that
 * superseded an earlier one and left its file behind, a chat whose JSON
 * will not parse so list() never names it, and a crash between writing the
 * images and writing the chat. All three look the same on disk - a file
 * whose chat id belongs to no chat - and before the sweep all three stayed
 * for ever.
 */
writeFileSync(join(imageDir, 'ghost-0-0.jpg'), 'x'.repeat(1000))
writeFileSync(join(imageDir, 'keeper-9-0.jpg.tmp'), 'x'.repeat(1000))
new ChatStore()
const after = readdirSync(imageDir).sort()
check('an image whose chat is gone is swept', after.includes('ghost-0-0.jpg'), false)
check('a temp file from a torn write is swept', after.includes('keeper-9-0.jpg.tmp'), false)
check('and the live one is not touched', after, mine)

/* A conversation still there keeps its pictures when something else is
   swept, which is the failure that would make this worse than the leak. */
const reopened = chats.load('keeper')
check('the chat still reads back', reopened?.messages?.[0]?.images?.length, 1)
check('with its bytes inlined', reopened.messages[0].images[0].dataUrl.startsWith('data:'), true)

/*
 * And the cap. Written straight to disk rather than through 205 saves,
 * because save() calls prune() and prune() lists the folder - the point
 * here is the drop, not the quadratic.
 */
const chatDir = join(dir, 'chats')
mkdirSync(chatDir, { recursive: true })
for (let i = 0; i < 205; i++) {
  writeFileSync(
    join(chatDir, `bulk${i}.json`),
    JSON.stringify({
      id: `bulk${i}`,
      title: `chat ${i}`,
      createdAt: 1000 + i,
      /* Oldest first, so the ones dropped are known by name. */
      updatedAt: 1000 + i,
      messageCount: 1,
      messages: [{ role: 'user', content: 'hello' }]
    })
  )
}
check('over the cap to start with', chats.list().length > 200, true)
chats.save({ id: 'newest', messages: [{ role: 'user', content: 'and one more' }] })
check('one save brings it back to the cap', chats.list().length, 200)
const left = new Set(chats.list().map((c) => c.id))
check('the newest is kept', left.has('newest'), true)
check('the oldest is dropped', left.has('bulk0'), false)
check('and the newest of the old is not', left.has('bulk204'), true)

/* ------------------------------------------------------- Chromium's caches */

const disk = readFileSync('src/main/disk.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
check('the HTTP cache has a ceiling', /appendSwitch\('disk-cache-size'/.test(disk), true)
/*
 * Before the app is ready, not inside whenReady. The switch is read when
 * the network service starts and setting it afterwards does nothing at all -
 * silently, which is the kind of fix that looks applied and is not.
 */
const readyAt = main.indexOf('app.whenReady()')
check('and it is set before anything opens the cache', main.indexOf('capDiskCache()') < readyAt, true)
check('what is already over it is reclaimed once', /reclaimCache\(session\.defaultSession\)/.test(main), true)
/* The shader and code caches are compilation results for this GPU and this
   build, and they are what makes a cold start fast. Capping the HTTP cache
   must not turn into disabling those. */
check('the shader cache is left alone', /disable-gpu-shader-disk-cache/.test(main + disk), false)

/* The log was already bounded; this says so out loud, because it is the one
   file that is appended to on every single line Wumpy writes. */
const logSrc = readFileSync('src/main/log.ts', 'utf8')
check('the log keeps its own ceiling', /MAX_BYTES = 512 \* 1024/.test(logSrc), true)

rmSync(dir, { recursive: true, force: true })

console.log(`${NL}${count - failed}/${count} storage checks passed`)
if (failed) process.exit(1)
