/**
 * Getting the words out of a .docx, and the other zips full of XML.
 *
 * Asked for as allowing nearly all file types to be attached and read. The
 * images, text and PDFs already worked; Word, PowerPoint, Excel and the
 * OpenDocument three were listed as `opaque` and attached as a sentence
 * saying they could not be read - which was honest, and was also the most
 * common kind of file a person actually has.
 *
 * The extraction deletes tags rather than parsing XML, which is the right
 * crudeness for the job and has exactly one subtlety worth checking: WHERE
 * THE LINE BREAKS GO. Text with every break removed is a wall, and the
 * formats each say it differently - w:p, a:p, text:p, a table row. Get that
 * wrong and the model is handed one enormous line.
 *
 * The second is the spreadsheet, which is not a bag of words: cells carry
 * their own addresses, so a blank column has to stay blank or every value
 * after it is in the wrong column.
 *
 * Run with: npm run check:office
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { deflateRawSync, inflateSync, crc32 } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const out = '.office-check.mjs'
await build({
  entryPoints: ['src/shared/office.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const O = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  const shown = JSON.stringify(got)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${shown?.length > 44 ? `${shown.slice(0, 44)}…` : shown}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)

/* --------------------------------------------------------- which family */

check('a word file', O.officeKind('report.docx'), 'docx')
check('a deck', O.officeKind('pitch.pptx'), 'pptx')
check('a workbook', O.officeKind('budget.xlsx'), 'xlsx')
check('an opendocument text', O.officeKind('notes.odt'), 'odf')
check('and its siblings', [O.officeKind('a.ods'), O.officeKind('a.odp')], ['odf', 'odf'])
check('case does not matter', O.officeKind('REPORT.DOCX'), 'docx')
/* The old formats are a different container entirely - OLE2, not a zip -
   so they stay opaque rather than being opened as an empty document. */
check('the pre-2007 formats are not this', O.officeKind('old.doc'), null)
check('nor is a pdf', O.officeKind('a.pdf'), null)
check('nor a plain zip', O.officeKind('a.zip'), null)

/* ------------------------------------------- only the parts worth reading */

check('the body of a document', O.wantedEntry('docx', 'word/document.xml'), true)
check('and its footnotes', O.wantedEntry('docx', 'word/footnotes.xml'), true)
/* Everything else in there is furniture, and a big .docx is mostly
   furniture: fonts, themes, images, styles. */
check('not the styles', O.wantedEntry('docx', 'word/styles.xml'), false)
check('not an embedded image', O.wantedEntry('docx', 'word/media/image1.png'), false)
/* Headers and footers repeat on every page; they are page furniture too. */
check('not the running header', O.wantedEntry('docx', 'word/header1.xml'), false)

check('every slide', O.wantedEntry('pptx', 'ppt/slides/slide7.xml'), true)
check('and the notes under them', O.wantedEntry('pptx', 'ppt/notesSlides/notesSlide2.xml'), true)
check('not the layouts', O.wantedEntry('pptx', 'ppt/slideLayouts/slideLayout1.xml'), false)

check('the sheets', O.wantedEntry('xlsx', 'xl/worksheets/sheet1.xml'), true)
/* Without the dictionary the cells are indexes pointing at nothing. */
check('and the string table they reference', O.wantedEntry('xlsx', 'xl/sharedStrings.xml'), true)
check('not the calc chain', O.wantedEntry('xlsx', 'xl/calcChain.xml'), false)

check('opendocument keeps it all in one part', O.wantedEntry('odf', 'content.xml'), true)
check('and not in the styles', O.wantedEntry('odf', 'styles.xml'), false)

/* Order matters twice: slides read in their own order, and the string
   table has to come before the sheets that resolve against it. */
check(
  'slides come out in order, not alphabetically',
  O.entryOrder('pptx', ['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml']),
  ['ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']
)
check(
  'the string table comes first',
  O.entryOrder('xlsx', ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml'])[0],
  'xl/sharedStrings.xml'
)

/* --------------------------------------------------------------- entities */

check('the five entities', O.unescapeXml('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;'), `<a> & "b" 'c'`)
check('numeric escapes', O.unescapeXml('&#65;&#x42;'), 'AB')
/*
 * Ampersand LAST, or a document containing the literal text "&lt;" comes
 * out as a real "<" - the classic double-unescape, and the one that turns
 * a code sample in a Word file into broken markup.
 */
check('and an escaped entity stays escaped', O.unescapeXml('&amp;lt;'), '&lt;')

/* ----------------------------------------------------- where the lines go */

{
  const docx =
    '<w:body><w:p><w:r><w:t>First line</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second </w:t></w:r><w:r><w:t>line</w:t></w:r></w:p></w:body>'
  check('a paragraph per line', O.textFromDocx(docx), `First line${NL}Second line`)
  /* Runs are split by formatting, not by meaning: "Second " and "line" are
     one sentence that happened to be half bold. */
  check('runs inside a paragraph are one line', O.textFromDocx(docx).split(NL).length, 2)

  check(
    'an explicit break is a break',
    O.textFromDocx('<w:p><w:t>a</w:t><w:br/><w:t>b</w:t></w:p>'),
    `a${NL}b`
  )
  /* Attributes must never reach the text, which is what deleting whole
     tags rather than just angle brackets buys. */
  check(
    'attributes never leak',
    O.textFromDocx('<w:p w14:paraId="77D3" w:rsidR="00A1"><w:t>only this</w:t></w:p>'),
    'only this'
  )
  check('an empty document is empty, not whitespace', O.textFromDocx('<w:body></w:body>'), '')
}

check(
  'slides break on their own paragraphs',
  O.textFromPptx('<a:p><a:t>Title</a:t></a:p><a:p><a:t>Point</a:t></a:p>'),
  `Title${NL}Point`
)
check(
  'opendocument breaks on headings and paragraphs',
  O.textFromOdf('<text:h>Heading</text:h><text:p>Body</text:p>'),
  `Heading${NL}Body`
)
check(
  'and on table rows',
  O.textFromOdf('<table:table-row><text:p>a</text:p></table:table-row><table:table-row><text:p>b</text:p></table:table-row>'),
  `a${NL}b`
)

/* --------------------------------------------------------- the spreadsheet */

{
  const shared = O.sharedStrings(
    '<sst><si><t>Name</t></si><si><t>Total</t></si><si><r><t>Wid</t></r><r><t>get</t></r></si></sst>'
  )
  check('the string table is read in order', shared, ['Name', 'Total', 'Widget'])
  /* A string split across runs is one string: Word and Excel both do that
     when half of it is formatted differently. */
  check('a split string is rejoined', shared[2], 'Widget')

  check('a column letter becomes an index', [O.columnOf('A1'), O.columnOf('B2'), O.columnOf('Z9')], [0, 1, 25])
  check('and keeps going past Z', O.columnOf('AA1'), 26)

  const sheet =
    '<sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>' +
    '</sheetData>'
  check('cells come back as rows', O.textFromSheet(sheet, shared), 'Name\tTotal\nWidget\t42')

  /*
   * THE BLANK COLUMN, which is the whole reason cells are placed by their
   * address rather than appended in order. A row that skips B must still
   * put its third value in the third column, or every figure after a gap
   * is read against the wrong heading.
   */
  const gap = '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData>'
  check('a skipped column stays skipped', O.textFromSheet(gap, []), '1\t\t3')

  /* Empty rows are spacers and a sheet is full of them. */
  const blanks = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"></row></sheetData>'
  check('blank rows are dropped', O.textFromSheet(blanks, []), '1')

  /* An inline string is the other way Excel stores text. */
  const inline = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hi</t></is></c></row></sheetData>'
  check('inline strings are read too', O.textFromSheet(inline, []), 'Hi')
}

/* ------------------------------------------------------------- the headings */

check('a slide says which slide', O.headingFor('pptx', 'ppt/slides/slide3.xml'), '--- Slide 3 ---')
check(
  'and its notes say so',
  O.headingFor('pptx', 'ppt/notesSlides/notesSlide3.xml'),
  '--- Notes for slide 3 ---'
)
check('a sheet says which sheet', O.headingFor('xlsx', 'xl/worksheets/sheet2.xml'), '--- Sheet 2 ---')
/* A one-part document needs no heading: "--- Document ---" above the only
   thing in the file is noise the model pays for. */
check('a document needs no heading', O.headingFor('docx', 'word/document.xml'), '')
check('but footnotes do', O.headingFor('docx', 'word/footnotes.xml'), '--- Footnotes ---')

/* ------------------------------------------- a real archive, read for real */

/*
 * The XML half is checked above with strings. This builds an actual zip -
 * local headers, central directory, end record, real byte offsets - and
 * reads it back through the real reader, because every bug that file can
 * have is an off-by-a-few in an offset and none of them are visible from
 * a string test.
 *
 * Stored rather than deflated, so this proves the directory walk without
 * also depending on the platform's inflate. The deflate path is the same
 * code with one extra call.
 */
{
  const UNZIP = await (async () => {
    const tmp = '.office-unzip-check.mjs'
    await build({
      entryPoints: ['src/renderer/src/unzip.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: tmp,
      logLevel: 'error',
      alias: { '@shared': 'src/shared' }
    })
    const mod = await import(pathToFileURL(tmp).href)
    rmSync(tmp, { force: true })
    return mod
  })()

  /**
   * A zip whose entries are DEFLATED, which is what Word actually writes.
   *
   * The stored-block builder below proves the directory walk and the
   * offsets, and deliberately does not touch the platform's inflate - so
   * for two days the reader had never once been handed a real compressed
   * entry, and the gap was flagged twice as "should work". This closes
   * it: zlib compresses, DecompressionStream decompresses, and the two
   * have to agree on every byte.
   */
  function makeDeflatedZip(files) {
    const enc = new TextEncoder()
    const locals = []
    const dir = []
    let offset = 0
    for (const [name, body] of files) {
      const n = enc.encode(name)
      const raw = Buffer.from(enc.encode(body))
      const comp = deflateRawSync(raw)
      const sum = crc32(raw)
      const local = Buffer.alloc(30 + n.length + comp.length)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(8, 8) // deflate
      local.writeUInt32LE(sum, 14)
      local.writeUInt32LE(comp.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(n.length, 26)
      local.writeUInt16LE(0, 28)
      Buffer.from(n).copy(local, 30)
      comp.copy(local, 30 + n.length)
      locals.push(local)

      const entry = Buffer.alloc(46 + n.length)
      entry.writeUInt32LE(0x02014b50, 0)
      entry.writeUInt16LE(8, 10)
      entry.writeUInt32LE(sum, 16)
      entry.writeUInt32LE(comp.length, 20)
      entry.writeUInt32LE(raw.length, 24)
      entry.writeUInt16LE(n.length, 28)
      entry.writeUInt32LE(offset, 42)
      Buffer.from(n).copy(entry, 46)
      dir.push(entry)
      offset += local.length
    }
    const directory = Buffer.concat(dir)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    return new Blob([Buffer.concat([...locals, directory, end])])
  }

  /** A zip with no compression, which is a legal zip and the simplest one. */
  function makeZip(files) {
    const enc = new TextEncoder()
    const locals = []
    const dir = []
    let offset = 0
    for (const [name, body] of files) {
      const n = enc.encode(name)
      const b = enc.encode(body)
      const local = Buffer.alloc(30 + n.length + b.length)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0, 8) // stored
      local.writeUInt32LE(0, 14) // crc, unchecked by the reader
      local.writeUInt32LE(b.length, 18)
      local.writeUInt32LE(b.length, 22)
      local.writeUInt16LE(n.length, 26)
      local.writeUInt16LE(0, 28)
      Buffer.from(n).copy(local, 30)
      Buffer.from(b).copy(local, 30 + n.length)
      locals.push(local)

      const entry = Buffer.alloc(46 + n.length)
      entry.writeUInt32LE(0x02014b50, 0)
      entry.writeUInt16LE(0, 10) // stored
      entry.writeUInt32LE(b.length, 20)
      entry.writeUInt32LE(b.length, 24)
      entry.writeUInt16LE(n.length, 28)
      entry.writeUInt32LE(offset, 42)
      Buffer.from(n).copy(entry, 46)
      dir.push(entry)
      offset += local.length
    }
    const directory = Buffer.concat(dir)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    return new Blob([Buffer.concat([...locals, directory, end])])
  }

  const docx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/styles.xml', '<styles>NOT THIS</styles>'],
    ['word/document.xml', '<w:body><w:p><w:t>Hello from a real zip</w:t></w:p></w:body>']
  ])

  const parts = await UNZIP.readZipText(docx, (path) => O.wantedEntry('docx', path))
  check('the wanted entry comes out of a real zip', parts.has('word/document.xml'), true)
  /* The offsets are right only if the body is exactly what went in - one
     byte adrift and this is garbage or empty. */
  check(
    'with its bytes intact',
    O.textFromDocx(parts.get('word/document.xml') ?? ''),
    'Hello from a real zip'
  )
  /* And the point of naming entries: the furniture is never decompressed. */
  check('and the parts nobody asked for stay shut', parts.has('word/styles.xml'), false)
  check('as does the manifest', parts.has('[Content_Types].xml'), false)

  /* Not a zip at all: a .docx that is really something else, or truncated. */
  const junk = new Blob([Buffer.from('this is not a zip file, not even close')])
  check('a file that is not a zip reads as nothing', (await UNZIP.readZipText(junk, () => true)).size, 0)

  /* A zip bomb cannot be let through on the directory's own say-so. */
  check('there is a ceiling on what comes out', UNZIP.MAX_UNZIP_BYTES <= 16 * 1024 * 1024, true)

  /*
   * THE PATH A REAL WORD FILE TAKES. Everything above used stored
   * entries, which never exercises inflate at all - so the reader had
   * been shipped twice on "should work". Deflated here by zlib and
   * decompressed by DecompressionStream, which is the pair that has to
   * agree in production.
   */
  const paragraphs = Array.from(
    { length: 60 },
    (_, i) => `<w:p><w:r><w:t>Paragraph ${i} with & &lt;escapes&gt; in it</w:t></w:r></w:p>`
  ).join('')
  const realDocx = makeDeflatedZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/styles.xml', '<styles>' + 'x'.repeat(5000) + '</styles>'],
    ['word/document.xml', `<w:body>${paragraphs}</w:body>`]
  ])
  const got = await UNZIP.readZipText(realDocx, (path) => O.wantedEntry('docx', path))
  check('a deflated entry comes out', got.has('word/document.xml'), true)

  const body = O.textFromDocx(got.get('word/document.xml') ?? '')
  const lines = body.split(NL)
  check('every paragraph survived', lines.length, 60)
  check('the first is intact', lines[0], 'Paragraph 0 with & <escapes> in it')
  check('and so is the last', lines[59], 'Paragraph 59 with & <escapes> in it')
  /* Compression is not a free pass for the entry filter: the 5KB of
     styles must still never be inflated. */
  check('and the furniture is still not decompressed', got.has('word/styles.xml'), false)
}

/* ------------------------------------------- the vision test's own PNGs */

/*
 * Not an office format, but the same problem solved in the same file's
 * spirit: a hand-rolled zlib stream that has to be right or everything
 * downstream lies. If the encoder were subtly wrong, every model would
 * score zero on the vision ladder and the catalogue would fill with
 * blind models that can all see - a failure that looks exactly like a
 * finding.
 */
{
  const V = await (async () => {
    const tmp = '.vision-check.mjs'
    await build({
      entryPoints: ['src/shared/vision.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: tmp,
      logLevel: 'error',
      alias: { '@shared': 'src/shared' }
    })
    const mod = await import(pathToFileURL(tmp).href)
    rmSync(tmp, { force: true })
    return mod
  })()
  globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64')

  const task = V.visionTask(5, false)
  const pixels = (task.image.w * 3 + 1) * task.image.h

  const inflateIdat = (png) => {
    const buf = Buffer.from(png)
    let at = 8
    const idat = []
    while (at < buf.length) {
      const len = buf.readUInt32BE(at)
      if (buf.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len))
      at += 12 + len
    }
    return inflateSync(Buffer.concat(idat))
  }

  /* Stored blocks: no dependency, renderer-safe, and enormous. */
  const stored = V.toPng(task.image)
  check('the stored png has a png header', stored[0] === 0x89 && stored[1] === 0x50, true)
  check('and inflates to exactly the pixels', inflateIdat(stored).length, pixels)

  /*
   * Deflated, which is what the main process sends. 108,193 bytes
   * becomes about 880 - a hundred and thirty times smaller, and roughly
   * 500ms of upload per picture. Measured on gemma4: the same six rungs
   * went from 600ms each to 1,119 once the uncompressed encoder was in
   * use, which is what prompted this.
   */
  const packed = V.toPng(task.image, (raw) => deflateRawSync(raw))
  check('deflating shrinks it by two orders of magnitude', packed.length * 50 < stored.length, true)
  check('and it still inflates to exactly the pixels', inflateIdat(packed).length, pixels)
  /* Same image either way, or the two paths would be testing different
     models with different pictures. */
  check('both encodings carry identical pixels', inflateIdat(packed).equals(inflateIdat(stored)), true)

  /* The data URL is what actually crosses the wire. */
  check('the data url names the type', V.dataUrl(task.image).startsWith('data:image/png;base64,'), true)

  /* The questions themselves: both sides asked, and the answer known
     exactly rather than judged. */
  const left = V.visionTask(1, false)
  const right = V.visionTask(1, true)
  check('the colour question has two answers', [left.want.test('Red'), right.want.test('Blue')], [true, true])
  check('and they are not the same one', left.want.test('Blue'), false)
  check('the hard rung asks about the red box', /RED box/.test(task.ask), true)
  check('and wants a four-digit number', /^\d{4}$/.test(task.want.source), true)
}

console.log(`${NL}${count - failed}/${count} office checks passed`)
if (failed) process.exit(1)
