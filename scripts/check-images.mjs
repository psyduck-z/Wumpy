/**
 * Pictures: getting them small, and getting them onto the wire.
 *
 * Two halves. The arithmetic of shrinking one, which decides what a pasted
 * screenshot costs on every turn it stays in the conversation. And the shape
 * it takes in the request, where a message stops being a string - the one
 * place a mistake is silent, because a provider that does not understand the
 * parts answers 400 and the turn is gone.
 *
 * shrinkImage itself needs a canvas and is not tested here; everything it
 * decides before touching one is.
 *
 * Run with: npm run check:images
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)

const imgOut = '.images-check.mjs'
await build({
  entryPoints: ['src/renderer/src/images.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: imgOut,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const I = await import(pathToFileURL(imgOut).href)
rmSync(imgOut, { force: true })

const cloudOut = '.images-cloud.mjs'
await build({
  entryPoints: ['src/shared/cloud.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: cloudOut,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const C = await import(pathToFileURL(cloudOut).href)
rmSync(cloudOut, { force: true })

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

/* --------------------------------------------------------- how much to shrink */

/**
 * A Win+Shift+S capture off this machine is 2560 wide. The model reads an
 * image as a grid of tiles and stops gaining detail well before that, and
 * every byte is paid on this turn AND stored in the chat file afterwards.
 */
check('a 2560-wide screenshot is scaled down', I.scaleFor(2560, 1440) < 1, true)
check('to the ceiling on its long edge', Math.round(2560 * I.scaleFor(2560, 1440)), I.MAX_EDGE)
check('a tall image is measured on its height', Math.round(3000 * I.scaleFor(800, 3000)), I.MAX_EDGE)
check('and a small one is left exactly alone', I.scaleFor(640, 480), 1)
check('never scaled UP', I.scaleFor(10, 10), 1)
/* A zero-sized image would divide by zero; it comes back as a no-op instead. */
check('a zero-sized image does not divide by zero', I.scaleFor(0, 0), 1)

/* ------------------------------------------------------ measuring a data URL */

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
for (const text of ['a', 'ab', 'abc', 'abcd', 'hello there', 'x'.repeat(1000)]) {
  const url = `data:image/png;base64,${b64(text)}`
  if (I.dataUrlBytes(url) !== text.length) {
    failed++
    console.log(`FAIL dataUrlBytes was wrong for ${text.length} bytes`)
  }
}
count++
console.log('ok   data URL sizes are measured without decoding            6 lengths')

/* ------------------------------------------------------------- what counts */

check('a png is an image', I.isImageFile({ type: 'image/png', name: 'a.png' }), true)
check('so is a jpeg with no type', I.isImageFile({ name: 'photo.JPG' }), true)
/* A pasted screenshot arrives with a type and the name "image.png" or none. */
check('and a typed blob with no name at all', I.isImageFile({ type: 'image/png' }), true)
check('a pdf is not', I.isImageFile({ type: 'application/pdf', name: 'a.pdf' }), false)
check('nor a text file', I.isImageFile({ name: 'notes.txt' }), false)
check('nor nothing', I.isImageFile({}), false)

/* ------------------------------------------------- which models can look */

check('Gemini can see', C.seesImages('gemini-3.5-flash'), true)
check('and so can the lite one', C.seesImages('gemini-3.1-flash-lite'), true)
/**
 * The other three providers are still wired up and their models are text
 * only. An image sent to one is a 400 that costs the whole turn, so the
 * paste is refused with a reason instead.
 */
check('codestral cannot', C.seesImages('codestral-latest'), false)
check('nor can a Groq model', C.seesImages('openai/gpt-oss-120b'), false)
check('and nothing is not a model', C.seesImages(''), false)

/* ------------------------------------------------------- the shape on the wire */

const PIC = { dataUrl: 'data:image/jpeg;base64,AAAA' }

/** Nearly every message is a string, and stays one. */
check(
  'a message with no images stays a plain string',
  C.wireMessage({ role: 'user', content: 'hello' }, true),
  { role: 'user', content: 'hello' }
)

const withPic = C.wireMessage({ role: 'user', content: 'what is this', images: [PIC] }, true)
check('one with images becomes parts', Array.isArray(withPic.content), true)
/**
 * Text first. An image handed over before the question reads as the subject
 * of it, which is right for "what is this"; a question asked before its
 * picture reads as a question about nothing.
 */
check('text comes first', withPic.content[0], { type: 'text', text: 'what is this' })
check('then the image', withPic.content[1], { type: 'image_url', image_url: { url: PIC.dataUrl } })

/* An image on its own is a message; there is simply no text part. */
const alone = C.wireMessage({ role: 'user', content: '', images: [PIC] }, true)
check('an image with no words is still sent', alone.content.length, 1)
check('as the image alone', alone.content[0].type, 'image_url')

/**
 * The second line of defence. The composer refuses to attach to a model
 * that cannot see; if one ever gets through, it is dropped rather than sent
 * into a 400.
 */
check(
  'images are dropped for a model that cannot see',
  C.wireMessage({ role: 'user', content: 'look', images: [PIC] }, false),
  { role: 'user', content: 'look' }
)
/* Only a user turn carries them — an assistant does not send pictures. */
check(
  'and never attached to an assistant turn',
  C.wireMessage({ role: 'assistant', content: 'ok', images: [PIC] }, true),
  { role: 'assistant', content: 'ok' }
)

/* ---------------------------------------------- folding still works around them */

/**
 * Google deletes system messages, so the app folds them into one. That fold
 * reads every message's content, and a message whose content is a list used
 * to be a string everywhere - this is the join that would have printed
 * "[object Object]" into the preamble.
 */
const folded = C.foldSystemMessages([
  { role: 'system', content: 'rules' },
  { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] },
  { role: 'system', content: 'facts' }
])
check('two system messages fold into one', folded.filter((m) => m.role === 'system').length, 1)
check('with both texts', folded[0].content, `rules${NL}${NL}facts`)
check('and the parts message survives intact', Array.isArray(folded[1].content), true)
check('wireText reads a parts message', C.wireText(folded[1].content), 'hi')
check('and a plain one', C.wireText('just text'), 'just text')

console.log(`${NL}${count - failed}/${count} image checks correct`)
process.exit(failed === 0 ? 0 : 1)
