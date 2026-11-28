import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { firstStamps, merge, readShared, shareText, stampChanges, type SharedKey, type Stamps } from '@shared/settingsync'
import type { WumpySettings } from '@shared/types'

/**
 * This device's half of sharing settings with the paired devices
 * (@shared/settingsync has the rules): when each shared setting last
 * changed, kept beside settings.json, and the settings of another device
 * merged in.
 */
export class SettingsShare {
  private stamps: Stamps
  private readonly file: string
  /** True while another device's settings are being written, so they keep that device's times. */
  private taking = false

  constructor(
    dir: string,
    private readonly settings: { all(): WumpySettings; patch(p: Partial<WumpySettings>): WumpySettings }
  ) {
    this.file = join(dir, 'settings-shared.json')
    this.stamps = this.load(dir)
  }

  private load(dir: string): Stamps {
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8')) as { stamps?: Stamps }
      if (o?.stamps && typeof o.stamps === 'object') return o.stamps
    } catch {
      /* The first time. */
    }
    /* What they chose before there was sharing, dated when they last changed a
       setting here - so between two devices set up before, the one looked
       after more recently wins. */
    const settingsFile = join(dir, 'settings.json')
    const at = existsSync(settingsFile) ? statSync(settingsFile).mtimeMs : Date.now()
    const stamps = firstStamps(this.settings.all(), Math.round(at))
    this.save(stamps)
    return stamps
  }

  private save(stamps = this.stamps): void {
    try {
      writeAtomic(this.file, `${JSON.stringify({ stamps }, null, 2)}\n`)
    } catch {
      /* Next change tries again. */
    }
  }

  /** Settings changed here: true when a shared one did, so the others should hear. */
  saw(prev: WumpySettings, next: WumpySettings): boolean {
    if (this.taking) return false
    if (!stampChanges(prev, next, this.stamps, Date.now())) return false
    this.save()
    return true
  }

  /** As the sync carries them. */
  view(): { text: string; hash: string; at: number } | null {
    const s = shareText(this.settings.all(), this.stamps)
    return s && { ...s, hash: createHash('sha256').update(s.text).digest('hex').slice(0, 16) }
  }

  /** Another device's, merged in: false for something that is not settings; the settings it changed here. */
  take(text: string): { ok: boolean; changed: SharedKey[]; patch: Partial<WumpySettings> } {
    const read = readShared(text)
    if (!read) return { ok: false, changed: [], patch: {} }
    const m = merge(this.settings.all(), this.stamps, read)
    this.stamps = m.stamps
    this.save()
    if (m.changed.length) {
      this.taking = true
      try {
        this.settings.patch(m.patch)
      } finally {
        this.taking = false
      }
    }
    return { ok: true, changed: m.changed, patch: m.patch }
  }
}
