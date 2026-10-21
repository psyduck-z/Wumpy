/**
 * Pictures and clips: getting them small, and getting them onto the wire.
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
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)

const imgOut = '.media-check.mjs'
await build({
  entryPoints: ['src/renderer/src/media.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: imgOut,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const I = await import(pathToFileURL(imgOut).href)
rmSync(imgOut, { force: true })

const cloudOut = '.media-cloud.mjs'
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

check('a png is an image', I.kindOf({ type: 'image/png', name: 'a.png' }), 'image')
check('so is a jpeg with no type', I.kindOf({ name: 'photo.JPG' }), 'image')
/* A pasted screenshot arrives with a type and the name "image.png" or none. */
check('and a typed blob with no name at all', I.kindOf({ type: 'image/png' }), 'image')
check('an mp4 is a video', I.kindOf({ type: 'video/mp4', name: 'clip.mp4' }), 'video')
check('a mov with no type is too', I.kindOf({ name: 'IMG_4201.MOV' }), 'video')
check('and a webm', I.kindOf({ name: 'screen.webm' }), 'video')
check('a pdf is neither', I.kindOf({ type: 'application/pdf', name: 'a.pdf' }), null)
check('nor a text file', I.kindOf({ name: 'notes.txt' }), null)
check('nor nothing', I.kindOf({}), null)

/**
 * A clip costs by the second, not by the pixel. Measured with countTokens
 * against gemini-3.5-flash: 3 seconds at 320x240 came to 376 tokens and 30
 * seconds at 640x360 to 3,165 — about 105 a second either way.
 */
check('the measured rate is the one in the code', I.TOKENS_PER_SECOND, 105)
check('so a minute is about six thousand tokens', Math.round(60 * I.TOKENS_PER_SECOND), 6300)
/* The whole request has to fit in one call, so the cap is on bytes. */
check('and a video has a byte ceiling', I.MAX_VIDEO_BYTES <= 20_000_000, true)

/* ------------------------------------------------- which models can look */

check('Gemini can see', C.seesMedia('gemini-3.5-flash'), true)
check('and so can the lite one', C.seesMedia('gemini-3.1-flash-lite'), true)
/**
 * EVERY MODEL IS BORN SIGHTED NOW, and this block used to assert the
 * opposite. "An image sent to one is a 400 that costs the whole turn" was
 * the reason for the cautious default, and on 19 Oct a sweep found the
 * caution was costing far more than the 400 would: three of six catalogue
 * entries could see and were being denied every picture, silently, with a
 * borrowed description standing in for an image they could have read.
 *
 * A dropped attachment produces a plausible answer and no error, so the
 * failure never surfaces. The 400 at least announces itself - and does
 * not cost the turn any more, because the client catches that refusal,
 * writes the model down as blind and retries without the picture.
 *
 * So an unmeasured model is assumed to see, and `sees: false` is reserved
 * for the two proved otherwise by the endpoint itself.
 */
check('an unmeasured model is assumed to see', C.seesMedia('codestral-latest'), true)
check('and so is one nobody has heard of', C.seesMedia('someone/brand-new-model'), true)
/* Proved blind, so not even tried. */
check('a model the endpoint refused does not', C.seesMedia('nvidia/nemotron-3-super-120b-a12b'), false)
check('nor the other one', C.seesMedia('z-ai/glm-5.3'), false)
check('and nothing is not a model', C.seesMedia(''), false)

/*
 * Learned at runtime, which is what makes the optimistic default safe:
 * the first 400 from a text-only model is the last picture it is sent.
 */
{
  C.forgetBlind()
  check('a new model starts sighted', C.seesMedia('maker/unknown'), true)
  C.rememberBlind('maker/unknown')
  check('and is blind once the endpoint says so', C.seesMedia('maker/unknown'), false)
  check('which the client can ask about', C.provedBlind('maker/unknown'), true)
  C.forgetBlind()
  check('forgotten only deliberately', C.seesMedia('maker/unknown'), true)
}
/*
 * SEEING IS A PROPERTY OF THE MODEL, NOT OF ITS PROVIDER. It was "is it a
 * Gemini", which was true of everything offered until Google came out of
 * the picker and the catalogue had no eyes left in it at all: "an annoying
 * thing is that the model does not support images".
 *
 * So the catalogue decides, and the Gemini rule stays underneath it for a
 * name typed in by hand - the entries are gone, the routing is not.
 */
check('the vision model on NVIDIA can see', C.seesMedia('nvidia/nemotron-3.5-super-vl-120b-a12b'), true)
/*
 * The two that genuinely cannot, and both were PROVED on 19 Oct rather
 * than assumed - which matters because the same sweep found that three
 * models marked blind by omission could see perfectly well.
 *
 * These two refuse at the server: nemotron-3-super answers "ValueError:
 * Received multimodal data but multimodal processing is not ..." and
 * glm-5.3 answers "Invalid request". That is a rejection, not a bad
 * answer, so there is nothing to argue with.
 */
check('the one it is named after cannot', C.seesMedia('nvidia/nemotron-3-super-120b-a12b'), false)
check('nor can the big GLM', C.seesMedia('z-ai/glm-5.3'), false)
/*
 * Exactly these, and each one asked rather than assumed.
 *
 * `sees` is absent-means-no, so a model that can see and is not listed is
 * silently denied every picture - and on 19 Oct three of them were. The
 * whole catalogue was put through scripts/bench-vision.mjs, which climbs
 * six rungs from "which side is red" to "read the small number in the red
 * box", with every image generated and every number random:
 *
 *   gemma4:31b-cloud        6/6    600ms   was unflagged
 *   nemotron-3.5-super-vl   6/6    370ms   already flagged
 *   glm-5.3-flash           5/6  1,599ms   was unflagged
 *   deepseek-v4.1-flash     reads them, 90s+   was unflagged
 *   nemotron-3-super        refused by the server
 *   glm-5.3                 refused by the server
 *
 * So the bit was wrong for half the list, and wrong in the direction that
 * costs: a screenshot bound for any of those three was being replaced
 * with a description borrowed from a second model - an extra request, to
 * produce something worse than the picture they could have read.
 */
check(
  'the catalogue marks exactly the models that were proved by asking',
  C.CLOUD_MODELS.filter((m) => m.sees).map((m) => m.id),
  [
    'nvidia/nemotron-3-super-120b-a12b',
    'deepseek-ai/deepseek-v4.1-flash',
    'z-ai/glm-5.3-flash',
    'nvidia/nemotron-3.5-super-vl-120b-a12b',
    'gemma4:31b-cloud'
  ].filter((id) => C.CLOUD_MODELS.find((m) => m.id === id)?.sees)
)
/* Named rather than counted, so adding an entry cannot quietly change
   what this asserts. */
check('and that is four of the six', C.CLOUD_MODELS.filter((m) => m.sees).length, 4)

/*
 * THE EYE IS CHOSEN ON EYESIGHT, NOT ON THE LADDER.
 *
 * eyeFor ranked by the capability score, which sounds right and measures
 * the wrong thing: an eye is handed a picture and asked what is in it,
 * and does none of the reasoning that score covers. The bug appeared the
 * instant the catalogue became honest - deepseek was correctly marked
 * sighted, immediately outranked everything at 39/41, and would have
 * become the app's eye at ninety seconds an image in place of one that
 * does it in 370ms. Every screenshot on a blind model, three times
 * slower than the turn it was helping with.
 */
/*
 * And the retry that makes the optimistic default affordable. The loop
 * lives in `send`, which receives a body the caller already built, so a
 * bare retry would post the identical request and be refused identically
 * - the image parts have to come out of the body in place.
 */
{
  const main = readFileSync('src/main/cloud.ts', 'utf8')
  check('a refused picture is recognised', /const refusedPicture =/.test(main), true)
  check('by what the endpoint actually says', /multimodal\|image\|vision\|not support\|invalid request/.test(main), true)
  check('the model is written down as blind', /rememberBlind\(model\)/.test(main), true)
  /* Stripped from the body, not merely retried: without this the second
     attempt carries the same picture. */
  check('and the picture comes out of the body', /m\.content = text\.length === 1/.test(main), true)
  check('leaving the question behind', /part\?\.type === 'text'/.test(main), true)
  /* provedBlind doubles as the loop guard, or a 400 for any other reason
     would retry for ever once the model is marked. */
  check('and it cannot loop', /!provedBlind\(model\)/.test(main), true)
}

check(
  'the quickest accurate eye is the one borrowed',
  C.eyeFor('nvidia/nemotron-3-super-120b-a12b')?.id,
  'nvidia/nemotron-3.5-super-vl-120b-a12b'
)
/*
 * Both 6/6, so speed breaks the tie: 370ms against 600ms.
 *
 * Preferring the FREE one was tried on 21 Oct and backed out. gemma4 is
 * the user's own Ollama account and costs nothing from the per-minute
 * ceiling, which is a good argument - but a keyless provider is a daemon
 * and a daemon can be off. `ready()` calls keyless providers ready the
 * moment they are named, so the eye would have been offered with nothing
 * configured, and returned nothing quietly when Ollama was down.
 *
 * These two checks are what caught it, which is why they are worth
 * keeping sharp: an eye on a provider that cannot answer is not an eye.
 */
check('both are equally accurate', C.CLOUD_MODELS.find((m) => m.id === 'gemma4:31b-cloud')?.vision?.clean, 6)
check('and the quicker one is chosen', C.eyeFor('nvidia/nemotron-3-super-120b-a12b')?.vision?.medianMs, 370)

/*
 * THE BADGE SHOWS A SCORE ONLY WHEN THERE IS ONE.
 *
 * deepseek reads images - proved by asking - and is slow enough that the
 * ladder got through one rung before giving up, half of which timed out.
 * That lands as 0/1, and "vision 0/1" reads as "failed the eye test"
 * when the truth is the opposite. Three rungs is the floor for a number;
 * below it the badge claims only what is known, that pictures are sent.
 */
{
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  check('a thin score is not shown as one', /m\.vision && m\.vision\.of >= 3/.test(app), true)
  const deep = C.CLOUD_MODELS.find((m) => m.id === 'deepseek-ai/deepseek-v4.1-flash')
  check('deepseek has too few rungs to score', (deep?.vision?.of ?? 0) < 3, true)
  /* And still gets pictures, which is the part that is actually known. */
  check('but still gets the pictures', C.seesMedia('deepseek-ai/deepseek-v4.1-flash'), true)
  const vl = C.CLOUD_MODELS.find((m) => m.id === 'nvidia/nemotron-3.5-super-vl-120b-a12b')
  check('a full ladder does score', (vl?.vision?.of ?? 0) >= 3, true)
}
/* And the highest-scoring model in the whole catalogue is not it. */
check('the smartest model is not the eye', C.eyeFor('nvidia/nemotron-3-super-120b-a12b')?.id !== 'deepseek-ai/deepseek-v4.1-flash', true)
check('because it reads one image in 90 seconds', C.CLOUD_MODELS.find((m) => m.id === 'deepseek-ai/deepseek-v4.1-flash')?.vision?.medianMs, 90_006)
check('the Ollama one can see', C.seesMedia('gemma4:31b-cloud'), true)

/* ------------------------------------------------------- borrowed eyes */

/*
 * "is there a way it can see images without sacrificing much"
 *
 * Switching to the vision model costs three ladder rungs on every turn,
 * including the ones with no picture in them. Borrowing it costs one extra
 * call on the turns that have a picture, and nothing on the rest.
 */
/*
 * deepseek used to stand in for "blind" here and no longer can: the 19
 * Oct sweep found it reads images, just at ninety seconds a go. The
 * example has to be one the endpoint actually refuses, or this measures
 * nothing.
 */
const BLIND = 'nvidia/nemotron-3-super-120b-a12b'
check('a model that cannot see gets an eye', C.eyeFor(BLIND)?.id, 'nvidia/nemotron-3.5-super-vl-120b-a12b')
check('one that can see does not need one', C.eyeFor('nvidia/nemotron-3.5-super-vl-120b-a12b'), null)
check('nor does a Gemini typed in by hand', C.eyeFor('gemini-3.8-flash'), null)
check('and nothing is not a model', C.eyeFor(''), null)
/* An eye on a provider with no key is not an eye: the composer would accept
   a paste for a call that cannot be made. Same question, one answer, so the
   two cannot disagree. */
check('an eye with no key is not offered', C.eyeReady(BLIND, []), null)
check('with one, it is', C.eyeReady(BLIND, ['nvidia'])?.id, 'nvidia/nemotron-3.5-super-vl-120b-a12b')
check('a key for someone else does not count', C.eyeReady(BLIND, ['groq', 'google']), null)

const mainSrc = readFileSync('src/main/index.ts', 'utf8')
/* The cost is one call, and it is only paid where it buys something. A plan
   looks after every step, and the control list already covers a screen that
   has one - so during a plan the picture is read only when the names came
   back thin, which is an app with no accessibility tree. */
check('a look the user asked for is described', /why === 'asked' \|\| thin/.test(mainSrc), true)
check('and a plan step only when the names are thin', /const thin = named\.elements\.length < 5/.test(mainSrc), true)
check('the eye is asked with the picture attached', /pictures: true/.test(mainSrc), true)
check('and background work still is not', /opts\.pictures/.test(readFileSync('src/main/cloud.ts', 'utf8')), true)
/* A description is not sight. The model answering did not see the screen,
   and every place this surfaces says so - otherwise the next step is a
   confident claim about a pixel nobody looked at. */
check('the hand-back calls it second-hand', /SECOND-HAND - you did not/.test(readFileSync('src/renderer/src/App.tsx', 'utf8')), true)
check('and the card says who described it', /described it/.test(readFileSync('src/renderer/src/components/ScreenCard.tsx', 'utf8')), true)
check('an attached picture is read for it too', /async function lendEyes/.test(mainSrc), true)
check('but only the newest turn of it', /\.reverse\(\)\.find\(\(m\) => m\.role === 'user' && m\.images\?\.length\)/.test(mainSrc), true)
check('and at most two pictures', /\.slice\(0, 2\)/.test(mainSrc), true)

/* ------------------------------------------------------- the shape on the wire */

const PIC = { kind: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' }
const CLIP = { kind: 'video', dataUrl: 'data:video/mp4;base64,BBBB', seconds: 3 }

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

/**
 * A clip goes the same way as a picture, in an image_url part with a
 * data:video/mp4 URL. That looks wrong and is not: measured against the
 * live API a clip sent exactly this way was read correctly - "Red / Green /
 * Blue" for a second each of red, green and blue - while the documented
 * input_audio part answered 400 "Invalid audio format mp4". The endpoint
 * takes the type from the data URL, not from the name of the part.
 */
const withClip = C.wireMessage({ role: 'user', content: 'what happens here', images: [CLIP] }, true)
check('a video rides in the same kind of part', withClip.content[1].type, 'image_url')
check('carrying its own data URL', withClip.content[1].image_url.url, CLIP.dataUrl)
check('with the question in front of it', withClip.content[0].text, 'what happens here')

/* One of each, in the order they were attached. */
const both = C.wireMessage({ role: 'user', content: 'compare', images: [PIC, CLIP] }, true)
check('several attachments all go', both.content.length, 3)
check('in the order they were added', [both.content[1].image_url.url, both.content[2].image_url.url], [
  PIC.dataUrl,
  CLIP.dataUrl
])

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

console.log(`${NL}${count - failed}/${count} media checks correct`)
process.exit(failed === 0 ? 0 : 1)
