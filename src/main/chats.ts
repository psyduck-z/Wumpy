import { app } from 'electron'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync
} from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ChatSummary, SavedChat } from '@shared/types'

/**
 * Saved conversations, one JSON file per chat under the user data directory.
 *
 * A file per chat rather than one index keeps deletes atomic and means a single
 * corrupt file costs one conversation instead of the whole history.
 */
export class ChatStore {
  private readonly dir = join(app.getPath('userData'), 'chats')

  constructor() {
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      console.error('[wumpy] could not create chat directory:', err)
    }
  }

  private pathFor(id: string): string {
    // Ids are generated internally, but never trust one into a path join.
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safe) throw new Error('invalid chat id')
    return join(this.dir, `${safe}.json`)
  }

  list(): ChatSummary[] {
    let files: string[]
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }

    const out: ChatSummary[] = []
    for (const file of files) {
      try {
        const chat = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as SavedChat
        out.push({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages?.length ?? 0,
          titleLocked: chat.titleLocked
        })
      } catch {
        // Skip unreadable files rather than failing the whole listing.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  load(id: string): SavedChat | null {
    try {
      return JSON.parse(readFileSync(this.pathFor(id), 'utf8')) as SavedChat
    } catch {
      return null
    }
  }

  save(chat: {
    id: string
    title?: string
    messages: ChatMessage[]
    createdAt?: number
    titleLocked?: boolean
  }): ChatSummary | null {
    const now = Date.now()
    const existing = this.load(chat.id)
    const record: SavedChat = {
      id: chat.id,
      title: chat.title?.trim() || existing?.title || titleFrom(chat.messages),
      createdAt: existing?.createdAt ?? chat.createdAt ?? now,
      updatedAt: now,
      messageCount: chat.messages.length,
      titleLocked: chat.titleLocked ?? existing?.titleLocked,
      messages: chat.messages
    }

    try {
      writeFileSync(this.pathFor(chat.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (err) {
      console.error('[wumpy] could not save chat:', err)
      return null
    }

    const { messages: _messages, ...summary } = record
    return summary
  }

  rename(id: string, title: string): ChatSummary | null {
    const chat = this.load(id)
    if (!chat) return null
    // An explicit rename pins the title against automatic retitling.
    return this.save({ ...chat, title, titleLocked: true })
  }

  delete(id: string): boolean {
    try {
      const path = this.pathFor(id)
      if (!existsSync(path)) return false
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  deleteAll(): number {
    let count = 0
    for (const summary of this.list()) {
      if (this.delete(summary.id)) count += 1
    }
    return count
  }
}

/** First user line, trimmed to something that fits a sidebar row. */
function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.trim()
  if (!first) return 'Untitled chat'
  const line = first.split('\n')[0]
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}
