/**
 * Attaching a file of any sort.
 *
 * The picker said `accept="image/*,video/*"` and a drop of anything else was
 * IGNORED - not refused, ignored, so the file vanished and nothing said why.
 * The ask was files of any sort, and the honest reading of that is not "send
 * every byte of everything to Google": it is that nothing is silently dropped
 * and each kind of file is handled the way that kind is useful.
 *
 * So most of what follows is about the three-way decision - characters, bytes,
 * or a sentence saying what the thing was - and about the caps, because a
 * 32,768-token window with 13,300 of instructions in it cannot take a 400MB
 * log and a model handed half a file and not told so will answer confidently
 * about the half it has.
 *
 * Run with: npm run check:attach
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.attach-check.mjs'
const wire = '.attach-wire.mjs'
await build({
  entryPoints: ['src/shared/attach.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
await build({
  entryPoints: ['src/shared/cloud.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: wire,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const A = await import(pathToFileURL(out).href)
const { wireMessage } = await import(pathToFileURL(wire).href)
const P = await import(pathToFileURL('.attach-pressure.mjs').href).catch(() => null)
rmSync(out, { force: true })
rmSync(wire, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(got)}` +
      (ok ? '' : `${String.fromCharCode(10)}     expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const bytes = (text) => new Uint8Array(Buffer.from(text, 'utf8'))

/* ------------------------------------------------------- what a file IS */

check('a screenshot', A.kindByName({ name: 'shot.png' }), 'image')
check('a clip', A.kindByName({ name: 'demo.mp4' }), 'video')
check('a recording', A.kindByName({ name: 'note.m4a' }), 'audio')
check('a PDF', A.kindByName({ name: 'contract.pdf' }), 'document')
check('source code', A.kindByName({ name: 'App.tsx' }), 'text')
check('a log', A.kindByName({ name: 'wumpy.log' }), 'text')
check('a spreadsheet export', A.kindByName({ name: 'sales.csv' }), 'text')
check('a config file', A.kindByName({ name: '.gitignore' }), 'text')
check('a Dockerfile, which has no extension', A.kindByName({ name: 'Dockerfile' }), 'text')
check('a Makefile', A.kindByName({ name: 'makefile' }), 'text')
check('an archive', A.kindByName({ name: 'backup.zip' }), 'opaque')
check('a Word file, which is an archive', A.kindByName({ name: 'report.docx' }), 'opaque')
check('a spreadsheet, likewise', A.kindByName({ name: 'books.xlsx' }), 'opaque')
check('a program', A.kindByName({ name: 'setup.exe' }), 'opaque')
check('something nobody has heard of', A.kindByName({ name: 'thing.qqq' }), null)
/* The browser's type is a second opinion, not the first. */
check('a type with no name', A.kindByName({ type: 'image/webp' }), 'image')
check('a JSON type', A.kindByName({ type: 'application/json' }), 'text')
check('a +xml type', A.kindByName({ type: 'application/atom+xml' }), 'text')

/* ------------------------------------------- and when the name says nothing */

check('bytes that are text are text', A.kindFor({ name: 'thing.qqq' }, bytes('hello there')), 'text')
check(
  'bytes that are not, are not',
  A.kindFor({ name: 'thing.qqq' }, new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])),
  'opaque'
)
check('an empty file is text', A.kindFor({ name: 'empty' }, new Uint8Array([])), 'text')
check(
  'a .json that is really a zip is not sent as text',
  A.kindFor({ name: 'data.json' }, new Uint8Array([0x50, 0x4b, 3, 4, 0, 1, 2, 3])),
  'opaque'
)
check('a name beats a heuristic for media', A.kindFor({ name: 'a.png' }, bytes('not really')), 'image')
/*
 * A NUL settles it. The escape codes in a coloured log do not: one line of
 * wumpy.log measured 6% control bytes, which a tight threshold called binary.
 */
check('a NUL means binary', A.looksLikeText(new Uint8Array([104, 105, 0, 104])), false)
const ESC = String.fromCharCode(27)
check(
  'an escape code in a log is still text',
  A.looksLikeText(bytes(`${ESC}[31mred${ESC}[0m and more text here`)),
  true
)
check(
  'a line of nothing but escapes is not',
  A.looksLikeText(bytes(`${ESC}${ESC}${ESC}${ESC}${ESC}a${ESC}${ESC}${ESC}${ESC}b`)),
  false
)

/* Notepad still writes UTF-16, and decoding that as UTF-8 is mojibake. */
check('a UTF-16LE mark', A.encodingOf(new Uint8Array([0xff, 0xfe, 0x68, 0x00])), 'utf-16le')
check('a UTF-16BE mark', A.encodingOf(new Uint8Array([0xfe, 0xff, 0x00, 0x68])), 'utf-16be')
check('plain bytes are UTF-8', A.encodingOf(bytes('hello')), 'utf-8')
check(
  'UTF-16LE with no mark, from its NULs',
  A.encodingOf(new Uint8Array([...'hello world here'].flatMap((c) => [c.charCodeAt(0), 0]))),
  'utf-16le'
)
check('and it counts as text', A.looksLikeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00])), true)

/* ----------------------------------------------------------------- the caps */

check('a small file goes whole', A.trimForSend('abc').truncated, false)
check('a big one is cut', A.trimForSend('x'.repeat(20_000)).truncated, true)
check('to the cap', A.trimForSend('x'.repeat(20_000)).text.length, A.TEXT_CHARS)
check('and remembers how long it was', A.trimForSend('x'.repeat(20_000)).chars, 20_000)
/* Cut at a line break, so a code file does not end mid-token. */
{
  const body = `${'a'.repeat(15_000)}${NL}${'b'.repeat(2000)}`
  check('it cuts at a newline when one is near', A.trimForSend(body).text.endsWith('a'), true)
}
check('the read is capped too', A.TEXT_READ_BYTES, A.TEXT_CHARS * 4)

/* -------------------------------------------------------------- the charge */

check('a picture is flat', A.attachmentTokens({ kind: 'image', bytes: 50_000 }), 1100)
check('a clip is by the second', A.attachmentTokens({ kind: 'video', bytes: 1, seconds: 60 }), 6300)
check('text is by its length', A.attachmentTokens({ kind: 'text', bytes: 1, text: 'x'.repeat(4000) }), 1000)
check(
  'and an unread file is one sentence',
  A.attachmentTokens({ kind: 'opaque', name: 'a.zip', bytes: 1000 }) < 100,
  true
)

/* --------------------------------------------------- how it reaches the wire */

const textFile = {
  kind: 'text',
  name: 'notes.ts',
  bytes: 120,
  text: 'export const a = 1',
  chars: 18
}
{
  const folded = A.foldAttachments('what does this do', [textFile])
  check('the file comes before the question', folded.text.indexOf('notes.ts') < folded.text.indexOf('what does'), true)
  check('it is fenced', folded.text.includes('```ts'), true)
  check('and named', folded.text.includes('notes.ts'), true)
  check('nothing goes as bytes', folded.bytes.length, 0)
}
{
  /* A truncation has to be stated INSIDE the fence, where a model reading
     only the block still sees it. */
  const long = { ...textFile, text: 'x'.repeat(100), chars: 90_000, truncated: true }
  const folded = A.foldAttachments('summarise', [long])
  check('a cut file says so', /FIRST 100 OF 90,000 CHARACTERS/.test(folded.text), true)
}
{
  /*
   * A .docx used to be the example here and is no longer unreadable: it is
   * a zip full of XML and @shared/office takes the words out. The example
   * has to be something genuinely opaque, or this check passes on a claim
   * the app has stopped making.
   */
  const folded = A.foldAttachments('read this', [
    { kind: 'opaque', name: 'artwork.psd', bytes: 40_000, mime: 'image/vnd.adobe.photoshop' }
  ])
  check('an unreadable file is still mentioned', folded.text.includes('artwork.psd'), true)
  check('and says its contents did not go', /NOT sent/.test(folded.text), true)
  /* The advice has to name what IS readable, and stay true as that list
     grows - it used to say "export it", which is now work the app does. */
  check('and suggests what would work', /Word, PowerPoint, Excel/.test(folded.text), true)
  check('without telling them to export a docx', /export/.test(folded.text), false)
}
{
  /* The budget is spent in order, so the first file attached gets the room. */
  const big = (name) => ({ kind: 'text', name, bytes: 1, text: 'x'.repeat(30_000), chars: 30_000 })
  const folded = A.foldAttachments('', [big('one.txt'), big('two.txt')])
  check('the total budget is respected', folded.text.length <= A.TEXT_TOTAL + 600, true)
  check('and the second file knows it was cut', folded.trimmed, true)
}
check('a fence survives a file that contains fences', A.textBlock({ kind: 'text', name: 'a.md', bytes: 1, text: '```js' + NL + 'x' + NL + '```' }).startsWith('a.md' + NL + '````'), true)

/* ------------------------------------------------------- the message itself */

{
  const m = { role: 'user', content: 'explain', images: [textFile] }
  /* A text file is characters, so it must reach a model with no vision at
     all - where the old code dropped every attachment. */
  const blind = wireMessage(m, false)
  check('text reaches a model that cannot see', typeof blind.content === 'string', true)
  check('and it is in there', String(blind.content).includes('export const a = 1'), true)
}
{
  const picture = { kind: 'image', dataUrl: 'data:image/png;base64,AAA', bytes: 10, name: 'a.png' }
  const m = { role: 'user', content: 'what is this', images: [picture] }
  check('a picture still goes as a part', Array.isArray(wireMessage(m, true).content), true)
  /* Dropped without vision, and SAID to be dropped: a question with the
     picture quietly removed gets a plausible description of nothing. */
  check('and is dropped without vision', String(wireMessage(m, false).content).startsWith('what is this'), true)
  check('with the drop stated', String(wireMessage(m, false).content).includes('NOT sent'), true)
}
{
  const m = {
    role: 'user',
    content: 'both',
    images: [textFile, { kind: 'image', dataUrl: 'data:image/png;base64,AAA', bytes: 10 }]
  }
  const parts = wireMessage(m, true).content
  check('a mixed message has one text part', parts.filter((p) => p.type === 'text').length, 1)
  check('with the file folded into it', parts[0].text.includes('notes.ts'), true)
  check('and the picture after it', parts[1].type, 'image_url')
}

/* ------------------------------------------- the refusal that could not be tested */

check('an unsupported type is recognised', A.refusedAttachment('Unsupported file type: application/pdf'), true)
check('so is an inline data complaint', A.refusedAttachment('Invalid value at inline_data'), true)
check('and a parse failure', A.refusedAttachment('Could not process the document you provided'), true)
check('an ordinary error is not', A.refusedAttachment('429 quota exceeded for this project'), false)
check('nor an empty one', A.refusedAttachment(''), false)
check(
  'stripping bytes keeps the file mentioned',
  A.withoutBytes([{ kind: 'document', name: 'a.pdf', bytes: 10, dataUrl: 'data:x' }])[0].kind,
  'opaque'
)
check(
  'and leaves text alone',
  A.withoutBytes([textFile])[0].kind,
  'text'
)

/* ------------------------------------------------------------- the wiring */

const composer = readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
check('the picker accepts anything', /accept="image/.test(composer), false)
check('a drop takes any file', /filesIn\(e\.dataTransfer/.test(composer), true)
check('and so does a paste', /filesIn\(e\.clipboardData/.test(composer), true)
check('vision is checked per attachment', /sendsBytes\(attachment\.kind\) && !readable/.test(composer), true)
/*
 * And "can anything read this", not "can the model read this". A model
 * without eyes can borrow a pair for a still image - the bytes go to a
 * vision model and its description comes back as text - but not for a clip,
 * a sound or a PDF, which the eye is not sent and could not watch, hear or
 * page through if it were.
 */
check(
  'an image counts as readable when something will read it',
  /canSeeMedia \|\| \(attachment\.kind === 'image' && Boolean\(describedBy\)\)/.test(composer),
  true
)

const chats = readFileSync('src/main/chats.ts', 'utf8')
check(
  'reopening a chat keeps a file with no bytes',
  /sendsBytes\(img\.kind \?\? 'image'\) \? Boolean\(img\.dataUrl\) : true/.test(chats),
  true
)

const pressure = readFileSync('src/shared/pressure.ts', 'utf8')
check('only bytes are trimmed as pictures', /const heavy = /.test(pressure), true)
check('and the meter charges each kind', /estimateWithFiles/.test(pressure), true)

console.log(`${NL}${count - failed}/${count} attachment checks passed`)
if (failed) process.exit(1)
