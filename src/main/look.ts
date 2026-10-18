/**
 * Reading a picture off the disk so the model can see it.
 *
 * The decisions are all in @shared/look, which is pure and checked; this is
 * the part that touches the filesystem. It reads a header first and the
 * whole file only once the header says it is worth reading, so pointing a
 * look block at a 4 GB video costs 512 bytes rather than 4 GB.
 *
 * Returns an Attachment, the same shape a screenshot and a dragged file
 * produce, so everything downstream - the token estimate, the transcript
 * thumbnail, the wire conversion, the trimming of old pictures - already
 * knows what to do with it and none of it needed changing.
 */
import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, basename } from 'node:path'
import { checkLookPath, lookVerdict } from '@shared/look'
import type { Attachment } from '@shared/types'

export interface LookResult {
  ok: boolean
  file?: Attachment
  /** The resolved path, shown on the card whether or not it worked. */
  path: string
  why: string
}

/** The first bytes, which is all `kindFor` needs to tell a PNG from prose. */
function header(path: string, bytes: number): Uint8Array {
  const want = Math.min(512, bytes)
  if (want <= 0) return new Uint8Array(0)
  const buffer = Buffer.alloc(want)
  const fd = openSync(path, 'r')
  try {
    const read = readSync(fd, buffer, 0, want, 0)
    return new Uint8Array(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
}

export function lookAtFile(raw: string): LookResult {
  const check = checkLookPath(raw, { home: homedir(), cwd: homedir(), resolve })
  if (!check.ok) return { ok: false, path: check.path || (raw ?? '').trim(), why: check.why }

  let size = 0
  try {
    const stat = statSync(check.path)
    if (stat.isDirectory()) {
      return { ok: false, path: check.path, why: 'That is a folder, not a file.' }
    }
    if (!stat.isFile()) return { ok: false, path: check.path, why: 'That is not a file.' }
    size = stat.size
  } catch (err) {
    /* The two cases a user can act on, told apart. "It did not work" sends
       someone looking in the wrong place. */
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { ok: false, path: check.path, why: 'There is no file there.' }
    if (code === 'EPERM' || code === 'EACCES') {
      return { ok: false, path: check.path, why: 'Windows would not let Wumpy read that file.' }
    }
    return { ok: false, path: check.path, why: `Could not read that file (${code ?? 'unknown'}).` }
  }

  const verdict = lookVerdict(basename(check.path), size, header(check.path, size))
  if (!verdict.ok) return { ok: false, path: check.path, why: verdict.why }

  try {
    const bytes = readFileSync(check.path)
    return {
      ok: true,
      path: check.path,
      why: '',
      file: {
        kind: verdict.kind,
        dataUrl: `data:${verdict.mime};base64,${bytes.toString('base64')}`,
        name: basename(check.path),
        /*
         * Unknown, and honestly so.
         *
         * A screenshot knows its own dimensions because it took them. These
         * would need the image decoded, which is a dependency and a decode
         * for a number used only to draw a thumbnail at the right ratio.
         * Zero is what the Attachment shape already means by "not measured"
         * and every reader of it copes.
         */
        width: 0,
        height: 0,
        bytes: size
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { ok: false, path: check.path, why: `Could not read that file (${code ?? 'unknown'}).` }
  }
}
