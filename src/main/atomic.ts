import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Replacing a file without ever having half of one on disk.
 *
 * Every store in this app wrote with a bare `writeFileSync` over the live
 * file, and `writeFileSync` truncates before it writes. For the whole of
 * that window the file on disk is empty or half a JSON document, and the
 * window is not theoretical here: nothing in Wumpy gets a graceful
 * shutdown. `npm run restart` ends the previous instance with
 * `Stop-Process -Force`, which is how it is stopped several times an hour
 * while it is being worked on, and the pool store already has a comment
 * about losing a write to exactly that.
 *
 * What a torn file costs depends on who reads it, and every reader here
 * treats a parse failure as "no file":
 *
 *   settings.json       every setting back to DEFAULT_SETTINGS
 *   keys.bin            every API key, and no way to tell it from a wiped one
 *   pool.json           which keys are spent - a handful of 429s to relearn
 *   usage.json          the day's counts
 *   input-history.json  200 lines of what they typed
 *   context.md          the notes they asked it to remember
 *   chats/*.json        one conversation, and its images orphaned on disk
 *
 * The tolerant readers are right and stay as they are. This removes the
 * thing they are tolerating: write the bytes to a temp file beside the
 * target, flush them to the platter, and then rename over it. Rename is
 * the one operation the filesystem will not do halfway, so a reader sees
 * either the old file or the new one and never a shred of both.
 *
 * Synchronous on purpose, like the writes it replaces. These are two-
 * kilobyte files written a few times a minute at most, and an async write
 * is one that may not have happened when the process is killed.
 */

/**
 * `fsync` before the rename, which is the half that is easy to leave out.
 *
 * Without it the rename can reach the disk before the data it is renaming:
 * the directory entry points at a file whose contents are still in the
 * write cache, and a power loss in between leaves a correctly-named file
 * full of nothing. That is the one failure mode this whole function exists
 * to prevent, so it is worth the flush - measured at well under a
 * millisecond on these file sizes.
 */
function writeAll(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'w')
  try {
    let written = 0
    /* writeSync is allowed to write less than it was given. It never has
       on a file this size, but the loop is two lines and the alternative
       is a silently truncated file. */
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Write `data` to `file`, atomically, creating the directory if needed.
 *
 * Throws what the underlying write throws, so every caller keeps the
 * try/catch and the error message it already had - the stores each say
 * something different about what losing their file means, and those
 * messages are better than one generic one from here.
 */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  const bytes = Buffer.isBuffer(data)
    ? data
    : typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data)

  mkdirSync(dirname(file), { recursive: true })

  /* Beside the target, not in the temp directory: rename is only atomic
     within one filesystem, and userData and %TEMP% are not always the
     same one. The suffix is fixed rather than random because a crash
     between the write and the rename should leave one file to overwrite
     next time, not a new one every time - this directory is small and
     meant to stay that way. */
  const temp = `${file}.tmp`

  try {
    writeAll(temp, bytes)
  } catch (err) {
    /* A temp file that was opened and not renamed is litter. */
    rmSync(temp, { force: true })
    throw err
  }

  /**
   * Rename, with two retries, and then the old behaviour rather than
   * nothing.
   *
   * On Windows a rename over an existing file fails outright if anything
   * holds a handle to the target, and on this machine something
   * occasionally does: Defender scans a file the moment it is written, and
   * a backup agent or a sync client will open one at any time. Those holds
   * last milliseconds.
   *
   * So: try again twice. If it still will not go, write straight over the
   * target - which is exactly what this app did before today. That gives
   * up the atomicity for one write rather than giving up the write, and
   * losing a setting because an antivirus scanner was mid-scan would be a
   * worse bug than the one being fixed.
   */
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file)
      return
    } catch (err) {
      if (attempt >= 2) {
        try {
          writeFileSync(file, bytes)
        } finally {
          rmSync(temp, { force: true })
        }
        /* Said out loud: it means this write was not atomic, and if it is
           happening often that is worth knowing. */
        console.warn(
          `[wumpy] could not swap ${file} into place ` +
            `(${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}); wrote it directly`
        )
        return
      }
      /* A short spin rather than a sleep: this is the synchronous path and
         there is nothing to await on. Single-digit milliseconds. */
      const until = Date.now() + 4
      while (Date.now() < until) {
        /* waiting for whoever has the handle to let go */
      }
    }
  }
}
