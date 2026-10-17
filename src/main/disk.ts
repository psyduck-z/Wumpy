import { app, type Session } from 'electron'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * Keeping Chromium's caches from being most of what Wumpy is.
 *
 * Measured on this machine after eleven days: 38 MB of user data, of which
 * Wumpy's own records were 236 KB.
 *
 *   26.0 MB  Cache            Chromium's HTTP cache
 *    5.1 MB  GrShaderCache    compiled shaders
 *    3.2 MB  Code Cache       compiled JavaScript
 *    1.6 MB  GPUCache
 *    0.2 MB  wumpy.log        capped at 512 KB, trims itself
 *   28   KB  chats            two conversations
 *    8   KB  pool.json
 *
 * The HTTP cache is the interesting one, because for this app it caches
 * nothing. The renderer's content security policy is `default-src 'self'`
 * with `img-src 'self' data:` and `font-src 'self'` - it is not allowed to
 * fetch a single remote resource, and the model requests are made from the
 * main process with Node's fetch, which does not use this cache at all.
 * What filled it is development: `electron-vite dev` serves the renderer
 * over http://localhost, every reload is a cacheable response, and those
 * responses accumulate in the same user data directory the installed app
 * uses. The files were eleven days old and nothing had read them.
 *
 * Chromium's own ceiling is a fraction of free disk space and runs to
 * hundreds of megabytes, so "it will evict eventually" is true and far too
 * late. Capped instead - and capped rather than disabled, because the
 * switch is one line either way and a cache that is bounded costs nothing
 * worth reasoning about, while a disabled one makes dev reloads slower for
 * no gain anyone would notice.
 *
 * The shader and code caches are left alone deliberately: both are
 * compilation results keyed to this exact GPU and this exact build, both
 * are what makes a cold launch fast, and together they are a quarter of
 * what the HTTP cache was.
 */

/**
 * 16 MB, which is twice what a full reload of the renderer occupies.
 *
 * Enough that the cache can still do its job during development, small
 * enough to be an unremarkable fraction of the install.
 */
export const CACHE_CAP_BYTES = 16 * 1024 * 1024

/**
 * Tell Chromium the ceiling, before it opens the cache.
 *
 * Must run before the app is ready: the switch is read when the network
 * service starts, and setting it afterwards is silently ignored.
 */
export function capDiskCache(): void {
  app.commandLine.appendSwitch('disk-cache-size', String(CACHE_CAP_BYTES))
}

/** Bytes in a directory tree, or 0 if it cannot be read. */
export function dirBytes(dir: string): number {
  let total = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += dirBytes(path)
      continue
    }
    try {
      total += statSync(path).size
    } catch {
      /* vanished between the listing and the stat */
    }
  }
  return total
}

/**
 * Throw away a cache that is already over the cap.
 *
 * The switch bounds what Chromium will write from now on; it does not go
 * back and reclaim what is already there, and on this machine that was
 * 26 MB of responses from a dev server that no longer exists. One clear
 * when the app starts over budget, and never otherwise - an empty cache is
 * a slightly slower first paint, so doing it on every launch would be
 * paying that for nothing.
 *
 * Returns the bytes that were being held, for the log line.
 */
export async function reclaimCache(session: Session): Promise<number> {
  const dir = join(app.getPath('sessionData'), 'Cache')
  const held = dirBytes(dir)
  if (held <= CACHE_CAP_BYTES) return 0
  try {
    await session.clearCache()
  } catch {
    /* A cache that will not clear is not worth an error: the switch has
       already bounded the growth, which was the point. */
    return 0
  }
  return held
}
