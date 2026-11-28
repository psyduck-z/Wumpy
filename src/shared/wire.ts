/**
 * The conversation as it is sent, with what it no longer needs left out.
 *
 * "Make Wumpy more context efficient." Every turn re-sends the whole
 * conversation, and in a conversation that builds something most of it is
 * files: a 246-line snake.html written in a reply is about 2,500 tokens, and
 * it goes out again on every turn after - and again for each version, since a
 * fix is a whole new write. The build check that rewrote snake.html five
 * times was sending five copies of it, four of them out of date, ahead of
 * every question.
 *
 * The file is on disk; the copy in the conversation is only a record of
 * what was written. So a write's contents are left out of what is SENT
 * (the transcript keeps everything) when
 *
 *   - a later reply writes the same path: the old copy is out of date and
 *     can only mislead, or
 *   - KEEP_TURNS messages of theirs or handed back have come since: a fix
 *     asked for straight after still has the file in front of it, and one
 *     asked for later reads it, which the instructions already require
 *     ("When they say it does not work, READ THE FILE").
 *
 * The block is replaced by a sentence, not by a shortened block: a model
 * shown a wumpy-write with a placeholder for its contents would sooner or
 * later write one, and the placeholder would be what ended up in the file.
 *
 * Pure, so the sender (main/index.ts withContext) and the context meter
 * (App.tsx) count the same thing, and for scripts/check-wire.mjs.
 */
import { readWriteRequest } from './writefile'

/** Messages of theirs (or handed back) after which a write's contents are left out. */
export const KEEP_TURNS = 3

/** A file shorter than this costs little and is kept wherever it is. */
export const SMALL_FILE_LINES = 12

const LF = String.fromCharCode(10)

/* The block as Markdown.tsx reads it: an opening fence of three or more
   backticks tagged wumpy-write, and a closing fence at least as long. */
const WRITE_BLOCK = /^([ \t]{0,3})(`{3,})[ \t]*wumpy-write[ \t]*\n([\s\S]*?)\n[ \t]{0,3}\2`*[ \t]*$/gm

/** The paths written in one reply, in order. */
export function writtenPaths(text: string): string[] {
  if (!text.includes('wumpy-write')) return []
  const paths: string[] = []
  for (const m of text.matchAll(WRITE_BLOCK)) {
    const path = readWriteRequest(m[3]).path
    if (path) paths.push(path)
  }
  return paths
}

/** The same file, however it was spelled: ~/a and ~/./a, a trailing slash, a quote. */
const samePath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/\/+$/, '')

/**
 * One reply with the contents of its writes left out, each replaced by a
 * sentence saying what was written where. `later` holds paths a later reply
 * writes; `old` is whether enough has happened since that every write goes.
 */
export function withoutFileBodies(text: string, later: ReadonlySet<string>, old: boolean): string {
  if (!text.includes('wumpy-write')) return text
  return text.replace(WRITE_BLOCK, (whole, indent: string, _fence: string, body: string) => {
    const req = readWriteRequest(body)
    /* From an agent: no contents to leave out (see withoutRetypedCode for a retyped one). */
    if (!req.path || req.from) return whole
    const lines = req.content.split(LF).length
    if (lines < SMALL_FILE_LINES) return whole
    const superseded = later.has(samePath(req.path))
    if (!superseded && !old) return whole
    const why = req.reason ? ` ("${req.reason}")` : ''
    return superseded
      ? `${indent}_(Here Wumpy wrote ${req.path}${why}, ${lines} lines - an earlier version, replaced by a later write, so its contents are left out.)_`
      : `${indent}_(Here Wumpy wrote ${req.path}${why}, ${lines} lines. Its contents are not in this conversation any more; the file on disk has them. To change it, read it first with cat - never write it again from memory.)_`
  })
}

/**
 * The conversation with old and out-of-date file contents left out of the
 * assistant's replies. Everything else, and every reply with nothing to
 * leave out, is passed through as the same object.
 */
export function withoutOldFiles<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  if (!messages.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('wumpy-write'))) {
    return [...messages]
  }
  const out = [...messages]
  const later = new Set<string>()
  let since = 0
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === 'user') {
      since++
      continue
    }
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue
    const content = withoutFileBodies(m.content, later, since >= KEEP_TURNS)
    if (content !== m.content) out[i] = { ...m, content }
    for (const p of writtenPaths(m.content)) later.add(samePath(p))
  }
  return out
}
