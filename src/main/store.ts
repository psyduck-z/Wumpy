import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { WumpySettings } from '@shared/types'

/**
 * Settings live in a single JSON file under the user data directory. Small enough
 * that a dependency-free read/merge/write beats pulling in a store library.
 */
export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private cache: WumpySettings

  constructor() {
    this.cache = this.read()
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
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf8')
    } catch (err) {
      console.error('[wumpy] could not persist settings:', err)
    }
    return this.all()
  }
}
