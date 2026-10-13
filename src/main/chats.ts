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
import type { Attachment, ChatMessage, ChatSummary, SavedChat } from '@shared/types'
import { sendsBytes } from '@shared/attach'

/**
 * Saved conversations, one JSON file per chat under the user data directory.
 *
 * A file per chat rather than one index keeps deletes atomic and means a single
 * corrupt file costs one conversation instead of the whole history.
 */
export class ChatStore {
  private readonly dir = join(app.getPath('userData'), 'chats')

  /**
   * Attached images, beside the chats rather than inside them.
   *
   * list() reads and parses EVERY chat file in full just to read six header
   * fields off each one, which was free while a chat was a few kilobytes of
   * text. A base64 screenshot is three hundred kilobytes, and four of them
   * in one conversation would mean megabytes of JSON parsed every time the
   * resume picker opens.
   *
   * So the bytes live in their own files and the chat keeps a filename. The
   * chat files stay the size they have always been, load() reads the images
   * back for the one conversation being opened, and the pictures are
   * ordinary jpegs in a folder the user can open — which is the same reason
   * the notes are a markdown file.
   */
  private readonly imageDir = join(app.getPath('userData'), 'chats', 'images')

  constructor() {
    try {
      mkdirSync(this.imageDir, { recursive: true })
    } catch (err) {
      console.error('[wumpy] could not create chat directory:', err)
    }
  }

  /** Writes each image out and leaves a filename in its place. */
  private externalise(id: string, messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m, mi) => {
      if (!m.images?.length) return m
      const images = m.images.map((img, i) => {
        if (!img.dataUrl?.startsWith('data:')) return img
        const name = `${safeId(id)}-${mi}-${i}.${extFor(img.dataUrl)}`
        try {
          const base64 = img.dataUrl.slice(img.dataUrl.indexOf(',') + 1)
          writeFileSync(join(this.imageDir, name), Buffer.from(base64, 'base64'))
        } catch (err) {
          // Keep the image in the JSON rather than losing it. A slow listing
          // is a worse outcome than a missing picture only in the abstract.
          console.error('[wumpy] could not write chat image:', err)
          return img
        }
        return { ...img, dataUrl: '', file: name }
      })
      return { ...m, images }
    })
  }

  /** Reads them back for the one chat being opened. */
  private inline(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
      if (!m.images?.length) return m
      const images = m.images.map((img) => {
        if (img.dataUrl || !img.file) return img
        try {
          const bytes = readFileSync(join(this.imageDir, img.file))
          return { ...img, dataUrl: `data:${mimeFor(img.file)};base64,${bytes.toString('base64')}` }
        } catch {
          // The file is gone. The message still reads correctly without it,
          // and an <img> with no src is better than failing the whole load.
          return img
        }
      })
      /*
       * An attachment with no bytes is not a broken attachment.
       *
       * This dropped anything without a data URL, which was right while every
       * attachment was a picture whose file might have gone missing. A text
       * file carries characters instead of bytes and a .docx carries neither
       * by design, so both were being deleted from the chat the moment it was
       * reopened - the one place where losing the file is silent.
       */
      return {
        ...m,
        images: images.filter((img): img is Attachment =>
          sendsBytes(img.kind ?? 'image') ? Boolean(img.dataUrl) : true
        )
      }
    })
  }

  /** Every image file belonging to one chat, for when it is deleted. */
  private imagesOf(id: string): string[] {
    try {
      return readdirSync(this.imageDir).filter((f) => f.startsWith(`${safeId(id)}-`))
    } catch {
      return []
    }
  }

  private pathFor(id: string): string {
    const safe = safeId(id)
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
      const chat = JSON.parse(readFileSync(this.pathFor(id), 'utf8')) as SavedChat
      return { ...chat, messages: this.inline(chat.messages ?? []) }
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
      messages: this.externalise(chat.id, chat.messages)
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
      // The pictures go with the conversation. Left behind they would be
      // unreachable bytes in the user data directory forever.
      for (const file of this.imagesOf(id)) {
        try {
          unlinkSync(join(this.imageDir, file))
        } catch {
          // Already gone, or locked. Not worth failing the delete over.
        }
      }
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

/** Ids are generated internally, but never trust one into a path join. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

/**
 * The file extension for a data URL's type, defaulting to jpg.
 *
 * The family is matched as well as the subtype, because a PDF written out as
 * `.pdf` has to come back as `application/pdf` rather than as an image of
 * that name - see `mimeFor`, which reads the extension in the other direction.
 */
function extFor(dataUrl: string): string {
  const m = /^data:(image|video|audio|application)\/([a-z0-9.+-]+)/i.exec(dataUrl)
  const kind = (m?.[2] ?? 'jpeg').toLowerCase()
  if (kind === 'jpeg') return 'jpg'
  if (kind === 'pdf') return 'pdf'
  if (kind === 'mpeg' && /^data:audio/i.test(dataUrl)) return 'mp3'
  return kind.replace(/[^a-z0-9]/g, '')
}

/**
 * And back again, for reading one in.
 *
 * The family has to come from the extension too, not be assumed: an mp4
 * written out as `image/mp4` is a data URL no decoder will touch, and the
 * failure is a chat that reopens with a dead player in it.
 */
const VIDEO_EXT = /^(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|wmv|3gp)$/
const AUDIO_EXT = /^(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|aiff?)$/

function mimeFor(file: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? 'jpg').toLowerCase()
  if (ext === 'pdf') return 'application/pdf'
  if (VIDEO_EXT.test(ext)) return `video/${ext === 'm4v' ? 'mp4' : ext}`
  if (AUDIO_EXT.test(ext)) return `audio/${ext === 'mp3' ? 'mpeg' : ext}`
  return `image/${ext === 'jpg' ? 'jpeg' : ext}`
}

/** First user line, trimmed to something that fits a sidebar row. */
function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.trim()
  if (!first) return 'Untitled chat'
  const line = first.split('\n')[0]
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}
