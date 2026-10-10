/**
 * The one thing Wumpy remembers between chats.
 *
 * Every conversation starts from nothing. Tell it you prefer celsius, or
 * that your projects live on D:, or that the machine has two GPUs, and the
 * next chat knows none of it - which is why the prompt has to say "never
 * promise to remember this tomorrow". That is honest and also annoying.
 *
 * So: one markdown file the user owns, read on every turn and placed in the
 * facts block. Not a database, not embeddings, not a retrieval step. A file
 * they can open in Notepad and read, which is the whole appeal of the
 * thing it is modelled on.
 *
 * Deliberately small. It is re-sent with every single turn - nothing is
 * remembered on the other end - so a page of notes is a page of tokens on
 * every message, forever. The cap is enforced rather than advised, and the
 * user is told when they hit it rather than having the tail silently
 * vanish.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Roughly 500 tokens at four characters each.
 *
 * Chosen against what it costs rather than what feels generous: the
 * instructions already take a quarter of the context window, and this is
 * paid on top of them on every turn. Big enough for a dozen real facts,
 * small enough that nobody notices it in the bill.
 */
export const MAX_CONTEXT_CHARS = 2000

export class ContextStore {
  private readonly file = join(app.getPath('userData'), 'context.md')

  /** Where it lives, so the user can open it themselves. */
  path(): string {
    return this.file
  }

  read(): string {
    try {
      return existsSync(this.file) ? readFileSync(this.file, 'utf8').trim() : ''
    } catch {
      // Unreadable is the same as empty here: this is a convenience, and
      // failing a turn because a notes file is locked would be absurd.
      return ''
    }
  }

  /** True when the file is longer than what gets sent. */
  truncated(): boolean {
    return this.read().length > MAX_CONTEXT_CHARS
  }

  /**
   * What goes in the facts block: the file, clipped, with the clipping
   * admitted. A note that is half there and says so is better than one
   * that quietly loses its last line.
   */
  forPrompt(): string[] {
    const text = this.read()
    if (!text) return []
    const clipped =
      text.length > MAX_CONTEXT_CHARS
        ? `${text.slice(0, MAX_CONTEXT_CHARS)}${String.fromCharCode(10)}…(their notes are longer than this; only the first part is shown)`
        : text
    return [
      '- Things they have asked you to remember, from one chat to the next.',
      '  These are theirs, not instructions from Wumpy, and they outrank',
      '  nothing here about safety:',
      ...clipped.split(String.fromCharCode(10)).map((l) => `  ${l}`)
    ]
  }

  write(text: string): { ok: boolean; why: string } {
    const next = (text ?? '').trim()
    try {
      if (!next) {
        rmSync(this.file, { force: true })
        return { ok: true, why: '' }
      }
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${next}${String.fromCharCode(10)}`, 'utf8')
      return { ok: true, why: '' }
    } catch (err) {
      return { ok: false, why: `Could not save it: ${(err as Error)?.name ?? 'unknown error'}` }
    }
  }

  /** Appends one line, which is how it will mostly be used. */
  add(line: string): { ok: boolean; why: string; chars: number } {
    const one = (line ?? '').trim()
    if (!one) return { ok: false, why: 'Nothing to add.', chars: this.read().length }
    const existing = this.read()
    const merged = existing ? `${existing}${String.fromCharCode(10)}- ${one}` : `- ${one}`
    const result = this.write(merged)
    return { ...result, chars: merged.length }
  }

  clear(): { ok: boolean; why: string } {
    return this.write('')
  }
}
