/**
 * `wumpy-look`: opening a picture that is already on the disk.
 *
 * Asked for because it was missing and the gap was invisible from outside.
 * Wumpy could photograph the whole screen and could not open a file: seven
 * fences, none of which meant "look at this one", so "what does the error
 * in D:\shots\build.png say" had no answer at all. The model could propose
 * a command that printed the file's SIZE and nothing that let it see it.
 *
 * Three things are worth a check rather than a glance.
 *
 * THE PATH RULES, because this is the one read that SENDS what it reads. A
 * UNC path reaches another machine; a URL is not a file; a device name is
 * not a file either. None of those should get as far as the disk.
 *
 * WHAT IS WORTH SENDING, because a look block that quietly became a worse
 * file read would undercut the attachment rules it sits beside: a text file
 * costs a quarter as much read as a command and can be quoted back exactly.
 *
 * THE GATE, because the grammar is gated behind the picture topic and the
 * sentence that needs it most - a bare path with no "image" or "screenshot"
 * in it - was the one sentence that could not reach it.
 *
 * Run with: npm run check:look
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, tag, external = []) {
  const out = `.look-check-${tag}.mjs`
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    external,
    alias: { '@shared': 'src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

const L = await load('src/shared/look.ts', 'pure')
const M = await load('src/main/look.ts', 'main', ['electron'])
const N = await load('src/shared/needs.ts', 'needs')

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  const shown = JSON.stringify(got)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${shown?.length > 42 ? `${shown.slice(0, 42)}…` : shown}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const HOME = `C:${BS}Users${BS}someone`
const env = {
  home: HOME,
  cwd: HOME,
  resolve: (...parts) => {
    /* Enough of a resolver for the rules being tested: an absolute path
       wins, anything else hangs off the first part. */
    const last = parts[parts.length - 1]
    if (/^[a-z]:/i.test(last) || last.startsWith(BS)) return last
    return parts.join(BS)
  }
}

/* ------------------------------------------------------- reading the block */

{
  const r = L.readLookRequest(['# Read the build error', 'D:' + BS + 'shots' + BS + 'b.png'].join(NL))
  check('the path comes out', r.path, 'D:' + BS + 'shots' + BS + 'b.png')
  check('and the reason', r.why, 'Read the build error')
  check('with nothing extra', r.extra, 0)

  /* One file at a time, and the others are REPORTED rather than dropped: a
     quiet partial success is the hardest kind for a user to notice. */
  const many = L.readLookRequest(['a.png', 'b.png', 'c.png'].join(NL))
  check('several paths take the first', many.path, 'a.png')
  check('and say how many were left', many.extra, 2)

  check('an empty block has no path', L.readLookRequest('').path, '')
  check('a reason-only block has no path', L.readLookRequest('# why').path, '')
}

/* ----------------------------------------------------------- the path rules */

check('a plain path is fine', L.checkLookPath('D:' + BS + 'a.png', env).ok, true)
check('quotes are stripped', L.checkLookPath('"D:' + BS + 'a.png"', env).path, 'D:' + BS + 'a.png')
check('~ becomes home', L.checkLookPath('~' + BS + 'a.png', env).path, HOME + BS + 'a.png')
check(
  'and so does %USERPROFILE%',
  L.checkLookPath('%USERPROFILE%' + BS + 'a.png', env).path,
  HOME + BS + 'a.png'
)

/* The refusals, each for its own reason. */
check('nothing is not a path', L.checkLookPath('', env).ok, false)
check('a UNC path is another machine', L.checkLookPath(BS + BS + 'nas' + BS + 'a.png', env).ok, false)
check('and says so', /network path/.test(L.checkLookPath(BS + BS + 'nas' + BS + 'a.png', env).why), true)
check('a URL is not a file', L.checkLookPath('https://x.test/a.png', env).ok, false)
check('a wildcard is not one file', L.checkLookPath('D:' + BS + '*.png', env).ok, false)
check('a device name is not a file', L.checkLookPath('CON', env).ok, false)
check('nor is a path with no name', L.checkLookPath('D:' + BS + '..', env).ok, false)
check('control characters are refused', L.checkLookPath('D:' + BS + 'a' + String.fromCharCode(7) + '.png', env).ok, false)

/*
 * NO HOME-DIRECTORY RULE, unlike the write path, and deliberately.
 *
 * Writing outside home can destroy something the user never named. Reading
 * outside home shows them a file they DID name, on a card, before it goes
 * anywhere - and their pictures live on whatever drive they live on. This
 * machine's own repo is on D:.
 */
check('a file outside home is allowed', L.checkLookPath('D:' + BS + 'pics' + BS + 'a.png', env).ok, true)

/* ------------------------------------------------- what is worth sending */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

check('a picture can be looked at', L.canLookAt('image'), true)
check('and a document', L.canLookAt('document'), true)
/* Text is refused HERE and not generally: a command reads it exactly, can
   be quoted back, and costs a quarter as much. */
check('a text file is not this', L.canLookAt('text'), false)
check('and says what to do instead', /command instead/.test(L.whyNotLook('text')), true)
check('a video is not this either', L.canLookAt('video'), false)
check('and points at the + button', /\+ button/.test(L.whyNotLook('video')), true)

{
  const good = L.lookVerdict('a.png', 4096, PNG)
  check('a real png passes', good.ok, true)
  check('with an image mime', good.mime, 'image/png')

  check('an empty file is refused', L.lookVerdict('a.png', 0, new Uint8Array(0)).ok, false)
  const huge = L.lookVerdict('a.png', 99_000_000, PNG)
  check('an enormous one is refused', huge.ok, false)
  check('and says how big it was', /over the/.test(huge.why), true)
}

/* ------------------------------------------- the real reader, on real files */

const dir = mkdtempSync(join(tmpdir(), 'wumpy-look-'))
try {
  /* A real 1x1 PNG, so kindFor is sniffing bytes rather than trusting a name. */
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const real = join(dir, 'shot.png')
  writeFileSync(real, png)

  const got = M.lookAtFile(real)
  check('a real file comes back ok', got.ok, true)
  check('as an image', got.file?.kind, 'image')
  check('with its own name', got.file?.name, 'shot.png')
  check('and the bytes it had', got.file?.bytes, png.length)
  check('encoded as a data url', got.file?.dataUrl.startsWith('data:image/png;base64,'), true)
  /* Round trip, because a truncated or mis-encoded body is the one failure
     that would look fine right up until the model saw nothing. */
  check(
    'that decodes back to the file',
    Buffer.from(got.file.dataUrl.split(',')[1], 'base64').equals(png),
    true
  )
  /* Unmeasured rather than wrong: decoding an image for a thumbnail ratio
     is a dependency for a number nothing depends on. */
  check('with dimensions left unmeasured', [got.file?.width, got.file?.height], [0, 0])

  const missing = M.lookAtFile(join(dir, 'nope.png'))
  check('a missing file says so plainly', missing.ok, false)
  check('in words, not a code', /no file there/i.test(missing.why), true)

  mkdirSync(join(dir, 'folder'))
  const folder = M.lookAtFile(join(dir, 'folder'))
  check('a folder is not a file', folder.ok, false)
  check('and says which it is', /folder/i.test(folder.why), true)

  /* A text file with an image name: the bytes decide, not the extension. */
  const liar = join(dir, 'notes.png')
  writeFileSync(liar, 'this is plain text, not a picture at all, not even slightly')
  const lied = M.lookAtFile(liar)
  check('a text file named .png is caught by its bytes', lied.ok, false)

  const text = join(dir, 'notes.txt')
  writeFileSync(text, 'hello')
  check('and a plain text file is refused', M.lookAtFile(text).ok, false)

  check('a UNC path never reaches the disk', M.lookAtFile(BS + BS + 'nas' + BS + 'a.png').ok, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------- the gate */

const needs = (t) => N.needsFor([{ role: 'user', content: t }])

/*
 * The sentence that needs the grammar most is a bare path, which contains
 * none of the picture WORDS. Measured before the extensions were added:
 * this returned no topics at all.
 */
check('a png filename reaches the picture rules', needs('what does build.png say').includes('picture'), true)
check('and a jpg', needs('open holiday.jpg').includes('picture'), true)
check('and a pdf', needs('read the report.pdf').includes('picture'), true)
check('and a full path', needs('look at D:' + BS + 'shots' + BS + 'b.png').includes('picture'), true)

/* Still narrow. A .txt is not a picture and must not drag the rules in. */
check('a text file does not', needs('open notes.txt').includes('picture'), false)
check('nor a script', needs('run build.ps1').includes('picture'), false)
check('and a plain question still costs nothing', needs('what is my key percentage'), [])

/* ----------------------------------------------------------- the wiring */

const fences = readFileSync('src/shared/fences.ts', 'utf8')
check('look is a fence the app knows', /'look'/.test(fences), true)

const main = readFileSync('src/main/index.ts', 'utf8')
check('there is exactly one way in', (main.match(/lookAtFile\(/g) ?? []).length, 1)
check('and it is an explicit request', /IPC\.lookFile/.test(main), true)
check('nothing reads a file unasked', /setInterval[^;]{0,120}lookAtFile/i.test(main), false)

const card = readFileSync('src/renderer/src/components/LookCard.tsx', 'utf8')
/* The path is what is being approved, so it is on the card before the
   read and stays there after it. */
check('the card shows the path', /<pre className="cmd-body">\{request\.path\}<\/pre>/.test(card), true)
check('and only accept-all opens by itself', /mode === 'all'/.test(card), true)
check('once, even across a remount', /claimOnce\(`look:/.test(card), true)
check('extra paths are reported, not dropped', /request\.extra > 0/.test(card), true)

const assistant = readFileSync('src/shared/assistant.ts', 'utf8')
check('the rules are gated behind pictures', /screen && wants\('picture'\) \? LOOK_PROMPT/.test(assistant), true)

console.log(`${NL}${count - failed}/${count} look checks passed`)
if (failed) process.exit(1)
