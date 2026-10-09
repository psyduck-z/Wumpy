import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { checkWritePath, MAX_BYTES } from '@shared/writefile'
import type { WriteResult } from '@shared/types'

/**
 * Writes a file the user approved.
 *
 * The path is vetted here as well as in the panel, for the same reason links
 * are: the renderer's check is there to tell the user what will happen, and the
 * renderer is downstream of model output. This one decides.
 *
 * Nothing is interpreted. The content arrives as a string and is written as
 * UTF-8 with no BOM, because the whole point of this path is that a `$`, a
 * backtick or a brace in someone's script reaches the disk as itself.
 */
export function writeProposedFile(rawPath: string, content: string, cwd: string): WriteResult {
  const home = homedir()
  const check = checkWritePath(rawPath, {
    home,
    cwd: cwd || home,
    resolve,
    separator: sep
  })

  if (!check.ok) {
    console.warn(`[wumpy] refused to write ${JSON.stringify(rawPath)}: ${check.why}`)
    return {
      written: false,
      path: check.path,
      bytes: 0,
      overwrote: false,
      error: check.why ?? 'Refused.'
    }
  }

  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_BYTES) {
    return {
      written: false,
      path: check.path,
      bytes,
      overwrote: false,
      error: `That is ${Math.round(bytes / 1024)}KB. Wumpy writes files up to ${MAX_BYTES / 1024}KB.`
    }
  }

  // Replacing something is worth reporting back, so the transcript can say so -
  // and a path that is already a folder is not a destination at all.
  let overwrote = false
  try {
    if (existsSync(check.path)) {
      const stat = statSync(check.path)
      if (stat.isDirectory()) {
        return {
          written: false,
          path: check.path,
          bytes,
          overwrote: false,
          error: 'That is a folder, not a file.'
        }
      }
      overwrote = stat.isFile()
    }
  } catch {
    /* treated as new */
  }

  try {
    // Only the parent, and only inside the folder already vetted above.
    mkdirSync(dirname(check.path), { recursive: true })
    writeFileSync(check.path, content, { encoding: 'utf8' })
  } catch (err) {
    return {
      written: false,
      path: check.path,
      bytes,
      overwrote: false,
      error: err instanceof Error ? err.message : 'Windows would not write it.'
    }
  }

  console.log(`[wumpy] wrote ${check.path} (${bytes} bytes${overwrote ? ', replaced' : ''})`)
  return { written: true, path: check.path, bytes, overwrote }
}

/** Describes a destination without writing anything, for the card. */
export function inspectWriteTarget(
  rawPath: string,
  cwd: string
): {
  ok: boolean
  path: string
  why: string | null
  exists: boolean
} {
  const home = homedir()
  const check = checkWritePath(rawPath, { home, cwd: cwd || home, resolve, separator: sep })
  let exists = false
  try {
    exists = check.ok && existsSync(check.path)
  } catch {
    /* unreadable counts as new */
  }
  return { ...check, exists }
}
