/**
 * An Office file, read as the words that are in it.
 *
 * The decisions are all in @shared/office, which is pure and checked, and
 * the archive is opened by ./unzip. This is the twenty lines that put them
 * together: pick the entries worth reading, read them in the order the
 * document has, and give each part a heading so a model knows whether it
 * is looking at slide four or the footnotes.
 */
import {
  entryOrder,
  headingFor,
  officeKind,
  sharedStrings,
  textFromDocx,
  textFromOdf,
  textFromPptx,
  textFromSheet,
  wantedEntry
} from '@shared/office'
import type { OfficeKind } from '@shared/office'
import { readZipText } from './unzip'

export { officeKind }

export async function readOfficeText(blob: Blob, kind: OfficeKind): Promise<string> {
  const parts = await readZipText(blob, (path) => wantedEntry(kind, path))
  if (!parts.size) return ''

  /* Shared strings are not a part of the document, they are the dictionary
     the sheets are written in - pulled out rather than printed. */
  const shared = kind === 'xlsx' ? sharedStrings(parts.get('xl/sharedStrings.xml') ?? '') : []

  const pieces: string[] = []
  for (const path of entryOrder(kind, [...parts.keys()])) {
    if (kind === 'xlsx' && path.toLowerCase().includes('sharedstrings')) continue
    const xml = parts.get(path) ?? ''
    const body =
      kind === 'docx'
        ? textFromDocx(xml)
        : kind === 'pptx'
          ? textFromPptx(xml)
          : kind === 'xlsx'
            ? textFromSheet(xml, shared)
            : textFromOdf(xml)
    if (!body.trim()) continue
    const heading = headingFor(kind, path)
    pieces.push(heading ? `${heading}\n${body}` : body)
  }
  return pieces.join('\n\n').trim()
}
