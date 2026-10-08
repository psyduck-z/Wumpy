import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ProviderId } from '@shared/cloud'
import { maskKey } from '@shared/cloud'

/**
 * API keys, encrypted at rest and never handed back out.
 *
 * Settings live in a readable JSON file, which is right for a window width and
 * wrong for a credential: anything that can read the user's home folder could
 * lift it, and Wumpy already refuses to write files into .ssh for exactly that
 * reason. So keys go in their own file, encrypted with safeStorage - DPAPI on
 * Windows, scoped to this user account.
 *
 * Two rules hold everywhere below.
 *
 * A key is never returned to the renderer. Not masked, not partially, not on
 * request. The panel is a web page; whatever reaches it reaches anything that
 * manages to run script in it. The renderer may ask *whether* a key exists and
 * may ask to set or clear one, and that is the whole interface. The only code
 * that sees the plaintext is the fetch that sends it.
 *
 * A key is never logged. Errors carry a masked form, because a stack trace in a
 * support paste is a key in a support paste.
 */
export class KeyStore {
  private readonly file = join(app.getPath('userData'), 'keys.bin')
  private cache: Partial<Record<ProviderId, string>> | null = null

  /**
   * Whether encryption is actually available.
   *
   * On Windows it effectively always is. If it is not, Wumpy stores nothing
   * rather than quietly falling back to plaintext - a key the user believes is
   * encrypted and is not is worse than no key at all, because they would make
   * a different decision about which key to paste.
   */
  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private load(): Partial<Record<ProviderId, string>> {
    if (this.cache) return this.cache
    this.cache = {}
    if (!this.available()) return this.cache
    try {
      const blob = readFileSync(this.file)
      const json = safeStorage.decryptString(blob)
      const parsed = JSON.parse(json) as Partial<Record<ProviderId, string>>
      // Only keep what we recognise, so a hand-edited file cannot inject a
      // provider name that later gets used to build a URL.
      for (const id of ['google', 'groq'] as ProviderId[]) {
        const value = parsed[id]
        if (typeof value === 'string' && value.trim()) this.cache[id] = value.trim()
      }
    } catch {
      // Missing, or written by another user account, or corrupt. All three mean
      // the same thing here: there is no usable key.
    }
    return this.cache
  }

  private persist(): void {
    const data = this.cache ?? {}
    try {
      if (!Object.keys(data).length) {
        rmSync(this.file, { force: true })
        return
      }
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(data)))
    } catch (err) {
      // The message is ours, not the exception's, in case the exception
      // helpfully quoted what it was trying to encrypt.
      console.error('[wumpy] could not save the API key:', (err as Error)?.name ?? 'unknown error')
    }
  }

  /** The plaintext key. Main process only; never send this over IPC. */
  secret(provider: ProviderId): string | null {
    return this.load()[provider] ?? null
  }

  has(provider: ProviderId): boolean {
    return Boolean(this.secret(provider))
  }

  /** Which providers are configured. Safe to send to the renderer. */
  configured(): ProviderId[] {
    const data = this.load()
    return (['google', 'groq'] as ProviderId[]).filter((id) => Boolean(data[id]))
  }

  set(provider: ProviderId, key: string): void {
    this.load()
    this.cache = { ...this.cache, [provider]: key.trim() }
    this.persist()
  }

  clear(provider: ProviderId): void {
    this.load()
    const next = { ...this.cache }
    delete next[provider]
    this.cache = next
    this.persist()
  }

  /** For a log line that needs to identify a key without revealing it. */
  hint(provider: ProviderId): string {
    const key = this.secret(provider)
    return key ? maskKey(key) : 'none'
  }
}
