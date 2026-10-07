import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** Kept short: this is for reaching back a few messages, not an archive. */
const LIMIT = 200

/** Anything longer than this was pasted, not typed, and is not worth recalling. */
const MAX_LENGTH = 4000

/**
 * What the user has typed into the composer, newest last.
 *
 * Separate from the chats themselves on purpose: it survives starting a new
 * chat, deleting one, and quitting, because "what did I ask it last night" is a
 * question about what you typed, not about which conversation it landed in.
 */
export class InputHistory {
  private readonly file = join(app.getPath('userData'), 'input-history.json')
  private entries: string[]

  constructor() {
    this.entries = this.read()
  }

  private read(): string[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.filter((e): e is string => typeof e === 'string').slice(-LIMIT)
    } catch {
      return []
    }
  }

  all(): string[] {
    return [...this.entries]
  }

  /** Records a line and returns the list as it now stands. */
  add(text: string): string[] {
    const entry = text.trim()
    if (!entry || entry.length > MAX_LENGTH) return this.all()

    // Repeating yourself should not mean pressing Up twice to get past it, so
    // an entry already present moves to the end rather than being appended.
    this.entries = [...this.entries.filter((e) => e !== entry), entry].slice(-LIMIT)

    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.entries, null, 0)}\n`, 'utf8')
    } catch (err) {
      console.error('[wumpy] could not persist input history:', err)
    }
    return this.all()
  }

  clear(): void {
    this.entries = []
    try {
      writeFileSync(this.file, '[]\n', 'utf8')
    } catch {
      // Nothing useful to do; the in-memory list is already empty.
    }
  }
}
