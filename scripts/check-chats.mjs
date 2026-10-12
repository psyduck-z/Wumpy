/**
 * Saved conversations, and the images that go with them.
 *
 * One thing is really being tested here: that attaching a screenshot does
 * not quietly make the resume picker slow. list() reads and JSON.parses
 * EVERY chat file in full to read six header fields off each one, which is
 * free for a few kilobytes of text and is not free for four base64
 * screenshots — so the bytes live beside the chat and the chat keeps a
 * filename.
 *
 * ChatStore imports electron for the userData path, so the real file logic
 * runs here against a temporary folder through a stub.
 *
 * Run with: npm run check:chats
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'wumpy-chats-'))

const shim = join(dir, 'electron.mjs')
writeFileSync(shim, `export const app = { getPath: () => ${JSON.stringify(dir)} }${NL}`)

const out = '.chats-check.mjs'
await build({
  entryPoints: ['src/main/chats.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { electron: shim, '@shared': 'src/shared' }
})
const { ChatStore } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const chats = new ChatStore()

/** A real, if tiny, JPEG payload — 40KB of it, to make the size test mean something. */
const BIG = 'A'.repeat(40_000)
const DATA = `data:image/jpeg;base64,${BIG}`
const shot = { kind: 'image', dataUrl: DATA, name: 'screenshot.png', width: 800, height: 450, bytes: 30_000 }

const message = (over) => ({
  id: over.id,
  role: over.role ?? 'user',
  content: over.content ?? '',
  createdAt: 1,
  ...over
})

/* ------------------------------------------------- an ordinary chat first */

chats.save({ id: 'plain1', title: 'No pictures', messages: [message({ id: 'm1', content: 'hi' })] })
check('a chat with no images saves', chats.list().length, 1)
check('and loads back', chats.load('plain1').messages[0].content, 'hi')

/* ----------------------------------------------------- one with a picture */

chats.save({
  id: 'withpic',
  title: 'A screenshot',
  messages: [message({ id: 'm1', content: 'what is this', images: [shot] })]
})

const onDisk = readFileSync(join(dir, 'chats', 'withpic.json'), 'utf8')

/**
 * The whole point. A 40KB data URL in the JSON would be parsed on every
 * single listing, for every chat, forever.
 */
check('the base64 is NOT in the chat file', onDisk.includes(BIG.slice(0, 200)), false)
check('the chat file stays small', onDisk.length < 2000, true)
check('and it keeps a filename instead', /"file":\s*"withpic-0-0\.jpg"/.test(onDisk), true)

const files = readdirSync(join(dir, 'chats', 'images'))
check('the image is a file of its own', files.length, 1)
check('named after the chat and the message', files[0], 'withpic-0-0.jpg')
/* An ordinary jpeg in a folder, openable without the app. */
check('holding the decoded bytes', readFileSync(join(dir, 'chats', 'images', files[0])).length > 0, true)

/* --------------------------------------------------------- and back again */

const back = chats.load('withpic')
check('loading puts the data URL back', back.messages[0].images[0].dataUrl === DATA, true)
check('with the rest of the attachment intact', back.messages[0].images[0].name, 'screenshot.png')
check('and the right dimensions', [back.messages[0].images[0].width, back.messages[0].images[0].height], [800, 450])

/* Saving a loaded chat again must not write a second copy of the image. */
chats.save(back)
check('re-saving does not duplicate the file', readdirSync(join(dir, 'chats', 'images')).length, 1)
check('and still loads', chats.load('withpic').messages[0].images[0].dataUrl === DATA, true)

/* ------------------------------------------------------------ the listing */

/**
 * The listing never touches the images, which is the property that made
 * this worth doing. If it ever reads them again, the chat file will have
 * grown — so the test is on the file, above — but check the header is
 * right too.
 */
const listed = chats.list().find((c) => c.id === 'withpic')
check('the listing still reports the title', listed.title, 'A screenshot')
check('and the message count', listed.messageCount, 1)
check('and carries no messages at all', 'messages' in listed, false)

/* ---------------------------------------------------------------- deleting */

/** The pictures go with the conversation, or they are unreachable forever. */
chats.delete('withpic')
check('deleting takes the chat', existsSync(join(dir, 'chats', 'withpic.json')), false)
check('and its images with it', readdirSync(join(dir, 'chats', 'images')).length, 0)
check('leaving the other chat alone', chats.list().length, 1)

/* ------------------------------------------------- a missing image file */

/**
 * The file can go: a user tidying the folder, a sync tool, a crash between
 * the two writes. A message with a picture that is gone still reads
 * correctly, and an <img> with no src is not a reason to fail the load.
 */
chats.save({
  id: 'gone',
  title: 'Lost',
  messages: [message({ id: 'm1', content: 'look', images: [shot] })]
})
rmSync(join(dir, 'chats', 'images', 'gone-0-0.jpg'), { force: true })
const lost = chats.load('gone')
check('a chat whose image is gone still loads', lost.messages[0].content, 'look')
check('without a broken attachment', lost.messages[0].images.length, 0)

/* ------------------------------------------------------------- and clips */

/**
 * A video is the same arrangement and much more of it — a thirty-second
 * clip is a couple of hundred kilobytes before base64 — so getting the
 * type right on the way back matters. An mp4 written out as `image/mp4` is
 * a data URL no decoder will touch, and the failure is a chat that reopens
 * with a dead player in it.
 */
const CLIPDATA = `data:video/mp4;base64,${'B'.repeat(20_000)}`
chats.save({
  id: 'clip',
  title: 'A clip',
  messages: [
    message({ id: 'm1', content: 'what happens', images: [{ kind: 'video', dataUrl: CLIPDATA, name: 'rgb.mp4', width: 320, height: 240, seconds: 3, bytes: 15_000 }] })
  ]
})
const clipFiles = readdirSync(join(dir, 'chats', 'images'))
check('a video is written out too', clipFiles.includes('clip-0-0.mp4'), true)
check('and not left in the chat file', readFileSync(join(dir, 'chats', 'clip.json'), 'utf8').includes('BBBBBBBBBB'), false)

const clipBack = chats.load('clip')
check('it comes back as a video data URL', clipBack.messages[0].images[0].dataUrl === CLIPDATA, true)
check('with the right media type, not image/mp4', clipBack.messages[0].images[0].dataUrl.startsWith('data:video/mp4;'), true)
check('and keeps its length', clipBack.messages[0].images[0].seconds, 3)
check('and its kind', clipBack.messages[0].images[0].kind, 'video')

/* ------------------------------------------- getting around the chats */

/*
 * Reported together, because they are the same complaint: moving between
 * chats takes more steps than it should. "just slash delete means you
 * delete the current chat. You don't have to go to the UI page thing"; and
 * "when you resume a chat, yeah, you should auto go there".
 */
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
const commands = readFileSync('src/renderer/src/commands.ts', 'utf8')

check('/delete carries whether to show the list', /kind: 'delete'; pick: boolean/.test(commands), true)
check('and defaults to not showing it', /pick: \/\^\(pick\|list\|other\|choose\)/.test(commands), true)
check('the handler deletes the open chat first', /if \(!action\.pick\)/.test(app), true)
/* A new chat before the delete, so the panel is never left with none. */
check('it starts a fresh one rather than leaving none', /newChat\(\)[\s\S]{0,40}if \(saved\) await window\.wumpy\.chats\.delete/.test(app), true)
check('and names what it deleted', /Deleted "\$\{name\}"/.test(app), true)
check('an unsaved chat is not reported as deleted', /nothing saved yet/.test(app), true)

check('the delete list closes when it empties', /refreshChats\(\)\)\.length === 0\) close\(\)/.test(app), true)

/* Opening a chat lands at the end of it, not where the last one was. */
const openChat = app.slice(app.indexOf('const openChat'), app.indexOf('/* ------', app.indexOf('const openChat')))
check('opening a chat re-arms the scroll', /stickToBottom\.current = true/.test(openChat), true)
check('and scrolls after the layout settles', /requestAnimationFrame/.test(openChat), true)
check('and closes the picker', /setPicker\(null\)/.test(openChat), true)

/* A new answer brings you to it, wherever you had scrolled to. */
check('a starting turn re-arms the scroll', /streaming && !wasStreaming\.current/.test(app), true)
check('once, on the edge, not continuously', /wasStreaming\.current = streaming/.test(app), true)

/* Compaction waits until the panel is away. */
check('idle compaction needs the panel hidden', /if \(!tucked\) return/.test(app), true)
check('and it waits a few seconds, not twenty', /\}, 5_000\)/.test(app), true)

/*
 * And "away" has to come from the main process.
 *
 * It was read from document.hidden, which this window never reports: the
 * panel turns off backgroundThrottling so that the focus retry and the open
 * animation survive being hidden, and Chromium then calls the page visible
 * for as long as it exists. Measured over the DevTools protocol on a window
 * that had never been shown at all: visibilityState 'visible'. So the flag
 * never flipped and this feature could not fire once.
 */
check('tucked is told, not guessed', /panel\.onTucked\(\(\) => \{/.test(app), true)
check('and asked for on arrival', /panel\.visible\(\)\.then/.test(app), true)
check('a shown panel is not tucked', /panel\.onShown\(\(\) => setTucked\(false\)\)/.test(app), true)
check('document.hidden is no longer believed on its own', /setTucked\(document\.hidden\)/.test(app), false)

const panelSrc = readFileSync('src/main/panel.ts', 'utf8')
check('hide() says so before it hides', panelSrc.indexOf('IPC.panelTucked') < panelSrc.indexOf('this.window.hide()'), true)
check('and main can be asked outright', /get onScreen\(\): boolean/.test(panelSrc), true)

rmSync(dir, { recursive: true, force: true })
console.log(`${NL}${count - failed}/${count} chat-store checks correct`)
process.exit(failed === 0 ? 0 : 1)
