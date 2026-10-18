/**
 * Enough of a zip reader to get the words out of an Office file.
 *
 * No dependency, because the platform already has the hard part:
 * `DecompressionStream('deflate-raw')` is the same inflate a zip needs, and
 * Chromium has shipped it for years. What is left is the archive's table of
 * contents, which is a hundred lines of byte offsets.
 *
 * DELIBERATELY NOT A GENERAL ZIP LIBRARY. It reads the central directory,
 * handles the two compression methods that Office actually writes - stored
 * and deflate - and refuses everything else by returning nothing for that
 * entry. Encrypted archives, zip64 beyond 4 GB, multi-disk spans and the
 * other fifteen things the format allows are all out, and a document using
 * one of them simply comes back as the file it was.
 *
 * Named entries only. The caller says which paths it wants before anything
 * is decompressed, so a 30 MB deck full of images costs the slide XML and
 * none of the pictures.
 */

/** The central directory entry, which is all that is needed to find a file. */
interface Entry {
  path: string
  method: number
  compressed: number
  uncompressed: number
  offset: number
}

/** A zip's end-of-central-directory record, searched from the back. */
function findDirectory(view: DataView): { count: number; at: number } | null {
  /* The record is 22 bytes plus a comment of up to 65,535, so it lives in
     the last 64 KB and nowhere else. Searched backwards because the
     signature can legitimately appear inside compressed data. */
  const end = view.byteLength
  const from = Math.max(0, end - 66_000)
  for (let i = end - 22; i >= from; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue
    return { count: view.getUint16(i + 10, true), at: view.getUint32(i + 16, true) }
  }
  return null
}

function readDirectory(buffer: ArrayBuffer): Entry[] {
  const view = new DataView(buffer)
  const found = findDirectory(view)
  if (!found) return []

  const entries: Entry[] = []
  const names = new TextDecoder('utf-8', { fatal: false })
  let at = found.at
  for (let i = 0; i < found.count; i++) {
    if (at + 46 > view.byteLength) break
    if (view.getUint32(at, true) !== 0x02014b50) break
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const uncompressed = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    const path = names.decode(new Uint8Array(buffer, at + 46, nameLength))
    entries.push({ path, method, compressed, uncompressed, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * The bytes of one entry, following its local header.
 *
 * The directory records where the local header starts, not where the data
 * does, and the local header carries its OWN name and extra-field lengths
 * which may differ from the directory's. Reading the directory's lengths
 * here is the classic way to land a few bytes into the data.
 */
async function readEntry(buffer: ArrayBuffer, entry: Entry): Promise<Uint8Array | null> {
  const view = new DataView(buffer)
  if (entry.offset + 30 > view.byteLength) return null
  if (view.getUint32(entry.offset, true) !== 0x04034b50) return null
  const nameLength = view.getUint16(entry.offset + 26, true)
  const extraLength = view.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressed
  if (end > view.byteLength) return null

  const raw = new Uint8Array(buffer, start, entry.compressed)
  if (entry.method === 0) return raw
  if (entry.method !== 8) return null

  try {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    /* A corrupt or unsupported entry is one missing part, not a failed
       document: a deck whose fourth slide will not inflate is still worth
       three slides. */
    return null
  }
}

/** How much decompressed text to accept before stopping. */
export const MAX_UNZIP_BYTES = 8 * 1024 * 1024

/**
 * Read the named entries out of a zip, as text.
 *
 * `wanted` decides what is worth decompressing before anything is, and the
 * running total stops a zip bomb: a few kilobytes of deflate can claim to
 * be gigabytes, and the directory's own figures are not to be trusted
 * either, so the cap is checked against what actually came out.
 */
export async function readZipText(
  blob: Blob,
  wanted: (path: string) => boolean
): Promise<Map<string, string>> {
  const buffer = await blob.arrayBuffer()
  const out = new Map<string, string>()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let total = 0

  for (const entry of readDirectory(buffer)) {
    if (!wanted(entry.path)) continue
    if (entry.path.endsWith('/')) continue
    if (total + entry.uncompressed > MAX_UNZIP_BYTES) break
    const bytes = await readEntry(buffer, entry)
    if (!bytes) continue
    total += bytes.length
    if (total > MAX_UNZIP_BYTES) break
    out.set(entry.path, decoder.decode(bytes))
  }
  return out
}
