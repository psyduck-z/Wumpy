/**
 * Getting the words out of the formats that are really zips full of XML.
 *
 * A .docx, .pptx, .xlsx, .odt, .ods and .odp are all the same trick: a zip
 * archive with the document in XML inside it. Wumpy listed every one of
 * them as `opaque` and attached them as a sentence saying it could not read
 * them - which was honest, and was also the single most common kind of file
 * a person has and wants read.
 *
 * Asked for as allowing nearly all file types to be attached and read. The
 * images, the text and the PDFs already worked; this is the rest of it.
 *
 * NO DEPENDENCY AND NO PARSER. The entries come out with a zip reader built
 * on the platform's own DecompressionStream, and the XML is reduced to text
 * by deleting the tags - which sounds crude and is exactly right here. The
 * job is not to understand a document, it is to hand a model the words in
 * their order. A real XML parse would cost a dependency and a dozen edge
 * cases to arrive at the same string.
 *
 * What IS structural is where the line breaks go, because that is the
 * difference between a document and a wall. Each format says it in its own
 * way and each is handled by name below.
 *
 * Pure, so every format can be driven from a check with a string.
 */

/** The families worth opening, by extension. */
export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'odf'

export function officeKind(name: string): OfficeKind | null {
  const file = (name ?? '').toLowerCase()
  if (/\.docx$/.test(file)) return 'docx'
  if (/\.pptx$/.test(file)) return 'pptx'
  if (/\.xlsx$/.test(file)) return 'xlsx'
  if (/\.(odt|odp|ods)$/.test(file)) return 'odf'
  return null
}

/**
 * Which entries in the zip are worth decompressing.
 *
 * A .docx holds fonts, images, themes and styles as well as the words, and
 * a big one is mostly not words. Naming what to read means a 30 MB deck
 * costs the slides and nothing else.
 *
 * Returned as a test rather than a list because the sheet and slide names
 * are numbered: there is no knowing how many there are until the directory
 * has been read.
 */
export function wantedEntry(kind: OfficeKind, path: string): boolean {
  const p = path.toLowerCase()
  switch (kind) {
    case 'docx':
      /* The body, plus footnotes and endnotes, which carry real text and
         are separate parts. Headers and footers are deliberately left:
         they repeat on every page and are page furniture. */
      return (
        p === 'word/document.xml' || p === 'word/footnotes.xml' || p === 'word/endnotes.xml'
      )
    case 'pptx':
      /* Slides and the notes under them, numbered from 1. */
      return /^ppt\/(slides\/slide\d+|notesslides\/notesslide\d+)\.xml$/.test(p)
    case 'xlsx':
      /* Shared strings holds every repeated string in the book exactly
         once; the sheets reference them by index. Both halves are needed
         or the cells come back as numbers pointing at nothing. */
      return p === 'xl/sharedstrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(p)
    case 'odf':
      return p === 'content.xml'
  }
}

/** Entries in the order their text should appear. */
export function entryOrder(kind: OfficeKind, paths: readonly string[]): string[] {
  const numbered = (p: string): number => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0)
  if (kind === 'pptx' || kind === 'xlsx') {
    return [...paths].sort((a, b) => {
      /* sharedStrings first, so the sheets can resolve against it. */
      if (a.toLowerCase().includes('sharedstrings')) return -1
      if (b.toLowerCase().includes('sharedstrings')) return 1
      return numbered(a) - numbered(b) || a.localeCompare(b)
    })
  }
  return [...paths].sort()
}

/** The five XML entities, plus numeric escapes. */
export function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    /* Ampersand last, or &amp;lt; becomes a real < rather than the text
       "&lt;" the document actually contains. */
    .replace(/&amp;/g, '&')
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return ''
  return String.fromCodePoint(code)
}

/**
 * Tags out, words in order, line breaks where the format says so.
 *
 * `breaks` is the list of closing tags that end a line. Everything else is
 * deleted, including the whole of anything self-closing, so attributes
 * never leak into the text.
 */
function flatten(xml: string, breaks: readonly string[]): string {
  let text = xml
  /* Explicit line and paragraph breaks first, while the tags still exist. */
  for (const tag of breaks) {
    text = text.replace(new RegExp(`</?(?:[a-z0-9]+:)?${tag}(?:[^>]*)?/?>`, 'gi'), '\n')
  }
  return unescapeXml(text.replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A Word document: one line per paragraph, and its explicit breaks. */
export function textFromDocx(xml: string): string {
  return flatten(xml, ['w:p', 'w:br', 'w:tab'])
}

/** A slide: one line per paragraph, with the slide's own heading added by the caller. */
export function textFromPptx(xml: string): string {
  return flatten(xml, ['a:p', 'a:br'])
}

/** OpenDocument: paragraphs, headings, list items and table rows. */
export function textFromOdf(xml: string): string {
  return flatten(xml, ['text:p', 'text:h', 'text:line-break', 'table:table-row'])
}

/**
 * A spreadsheet, as rows rather than as a bag of words.
 *
 * The cells carry their own addresses, so a row can be rebuilt in order and
 * a blank column stays blank. Without that a sheet flattens into a list of
 * values with no way to tell which column anything was in, which is worse
 * than useless for the thing people ask about a spreadsheet.
 *
 * `shared` is xl/sharedStrings.xml: every repeated string in the workbook,
 * stored once, referenced by index from cells marked t="s".
 */
export function sharedStrings(xml: string): string[] {
  const out: string[] = []
  /* One <si> per string, which may be split across several <t> runs when
     part of it is formatted differently. */
  for (const item of xml.match(/<si\b[\s\S]*?<\/si>/gi) ?? []) {
    const runs = item.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) ?? []
    out.push(
      unescapeXml(runs.map((r) => r.replace(/<[^>]*>/g, '')).join('')).replace(/\s+/g, ' ').trim()
    )
  }
  return out
}

/** "B12" -> 1, so cells land in their own columns. */
export function columnOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec((ref ?? '').toUpperCase())?.[1] ?? ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return Math.max(0, n - 1)
}

export function textFromSheet(xml: string, shared: readonly string[]): string {
  const lines: string[] = []
  for (const row of xml.match(/<row\b[\s\S]*?<\/row>/gi) ?? []) {
    const cells: string[] = []
    for (const cell of row.match(/<c\b[^>]*(?:\/>|[\s\S]*?<\/c>)/gi) ?? []) {
      const ref = /\br="([A-Z]+\d+)"/i.exec(cell)?.[1] ?? ''
      const type = /\bt="([^"]+)"/i.exec(cell)?.[1] ?? ''
      let value = ''
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/i.exec(cell)?.[1] ?? '')
        value = shared[index] ?? ''
      } else if (type === 'inlineStr') {
        const runs = cell.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) ?? []
        value = unescapeXml(runs.map((r) => r.replace(/<[^>]*>/g, '')).join(''))
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/i.exec(cell)?.[1] ?? '')
      }
      const at = columnOf(ref)
      while (cells.length < at) cells.push('')
      cells.push(value.replace(/\s+/g, ' ').trim())
    }
    /* A row of nothing is a spacer, and a page of them is not worth
       sending. Trailing blanks go too, so a sheet that is 16,384 columns
       wide on paper is as wide as its content. */
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    if (cells.length) lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

/** What to call each part in the assembled text, so a model knows where it is. */
export function headingFor(kind: OfficeKind, path: string): string {
  const n = /(\d+)\.xml$/.exec(path)?.[1]
  if (kind === 'pptx') {
    return /notesslide/i.test(path) ? `--- Notes for slide ${n} ---` : `--- Slide ${n} ---`
  }
  if (kind === 'xlsx') return `--- Sheet ${n} ---`
  if (kind === 'docx' && /footnotes/i.test(path)) return '--- Footnotes ---'
  if (kind === 'docx' && /endnotes/i.test(path)) return '--- Endnotes ---'
  return ''
}
