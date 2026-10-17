import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { WumpySettings } from '@shared/types'

/**
 * Settings live in a single JSON file under the user data directory. Small enough
 * that a dependency-free read/merge/write beats pulling in a store library.
 */
export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private cache: WumpySettings
  private readonly listeners = new Set<(s: WumpySettings) => void>()

  constructor() {
    this.cache = this.read()
  }

  /**
   * Notified on every change, whoever made it.
   *
   * The tray menu and the panel both write settings, and before this only the
   * writer knew. The panel could sit showing "ask every time" while the tray
   * had switched approval to "run everything" — the status bar said one thing
   * and the main process did another, which for a permission control is the
   * worst way to be wrong.
   */
  onChange(cb: (settings: WumpySettings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private read(): WumpySettings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<WumpySettings>
      // Merge over defaults so settings added in a later version are present.
      return { ...DEFAULT_SETTINGS, ...raw }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  all(): WumpySettings {
    return { ...this.cache }
  }

  get<K extends keyof WumpySettings>(key: K): WumpySettings[K] {
    return this.cache[key]
  }

  patch(patch: Partial<WumpySettings>): WumpySettings {
    this.cache = { ...this.cache, ...patch }
    try {
      /* Atomically: a torn settings file reads as no settings at all, and
         `read` would then hand back DEFAULT_SETTINGS - silently undoing
         every choice the user has made, approval mode among them. */
      writeAtomic(this.file, `${JSON.stringify(this.cache, null, 2)}\n`)
    } catch (err) {
      console.error('[wumpy] could not persist settings:', err)
    }
    for (const cb of this.listeners) cb(this.all())
    return this.all()
  }
}
