import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ProviderId } from '@shared/cloud'
import { PROVIDER_IDS, maskKey } from '@shared/cloud'
import { splitKeys } from '@shared/rotation'

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
  private cache: Partial<Record<ProviderId, string[]>> | null = null

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

  /**
   * Several keys per provider, because the limit is per project.
   *
   * Measured: Gemini's free tier allows five requests a minute on
   * gemini-3.5-flash, and Google applies that per PROJECT rather than per
   * key - so three keys cut from one project share one allowance and buy
   * nothing, while five keys from five projects are five times the rate.
   * One Wumpy install is four requests, so a single project is spent most
   * of a minute by one interaction.
   *
   * Stored as a list. A file written by an older version holds a bare
   * string, which is read as a list of one so nobody has to re-paste
   * anything.
   */
  private load(): Partial<Record<ProviderId, string[]>> {
    if (this.cache) return this.cache
    this.cache = {}
    if (!this.available()) return this.cache
    try {
      const blob = readFileSync(this.file)
      const json = safeStorage.decryptString(blob)
      const parsed = JSON.parse(json) as Partial<Record<ProviderId, string | string[]>>
      // Only keep what we recognise, so a hand-edited file cannot inject a
      // provider name that later gets used to build a URL.
      for (const id of PROVIDER_IDS) {
        const value = parsed[id]
        const list = (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
          .filter((k): k is string => typeof k === 'string')
          .map((k) => k.trim())
          .filter(Boolean)
        if (list.length) this.cache[id] = list
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

  /** Every key for a provider. Main process only; never send over IPC. */
  secrets(provider: ProviderId): string[] {
    return this.load()[provider] ?? []
  }

  /** The first key, for the callers that only ever wanted one. */
  secret(provider: ProviderId): string | null {
    return this.secrets(provider)[0] ?? null
  }

  /** How many keys this provider has, which is how many rotate. */
  count(provider: ProviderId): number {
    return this.secrets(provider).length
  }

  has(provider: ProviderId): boolean {
    return this.count(provider) > 0
  }

  /** Which providers are configured. Safe to send to the renderer. */
  configured(): ProviderId[] {
    const data = this.load()
    return PROVIDER_IDS.filter((id) => (data[id]?.length ?? 0) > 0)
  }

  /**
   * Replaces every key for a provider.
   *
   * Accepts several at once separated by whitespace, commas or semicolons,
   * because pasting five of them one command at a time is a chore and the
   * likeliest way to end up with four.
   */
  set(provider: ProviderId, key: string): void {
    this.load()
    const list = KeyStore.split(key)
    this.cache = { ...this.cache, [provider]: list }
    if (!list.length) delete this.cache[provider]
    this.persist()
  }

  /** Adds one or more without disturbing what is already there. */
  add(provider: ProviderId, key: string): number {
    this.load()
    const existing = this.secrets(provider)
    // A key pasted twice is one key with two chances to be rate limited at
    // the same moment, which is worse than useless.
    const merged = [...existing]
    for (const one of KeyStore.split(key)) {
      if (!merged.includes(one)) merged.push(one)
    }
    this.cache = { ...this.cache, [provider]: merged }
    this.persist()
    return merged.length
  }

  /** Splits a pasted blob into keys. Lives in shared so a check can run it. */
  static split(blob: string): string[] {
    return splitKeys(blob)
  }

  clear(provider: ProviderId): void {
    this.load()
    const next = { ...this.cache }
    delete next[provider]
    this.cache = next
    this.persist()
  }

  /** For a log line that needs to identify a key without revealing it. */
  hint(provider: ProviderId, index = 0): string {
    const key = this.secrets(provider)[index]
    return key ? maskKey(key) : 'none'
  }
}
