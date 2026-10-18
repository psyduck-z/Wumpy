/**
 * Looking at a file that is already on the disk.
 *
 * Wumpy could photograph the whole screen and could not open a picture. The
 * fences are run, ask, write, search, open, screen and do - seven ways to
 * act and no way to say "look at this one". So "what does the error in
 * D:\shots\build.png say" had no answer: the model could propose a command
 * that printed the file's SIZE, and nothing that let it see the thing.
 *
 * Asked for in those words - that looking at an image in a specific file is
 * not convenient even on a model that reads pictures. It was not
 * inconvenient, it was impossible.
 *
 * The screenshot path already does every hard part of this: the model asks,
 * a card appears, the user presses it, and an image arrives in the next turn
 * where they can see exactly what was sent. This is the same shape with a
 * path instead of a camera.
 *
 * WHY A READ NEEDS A CLICK AT ALL. Reading a file changes nothing, so the
 * usual argument for approval does not apply. The argument that does: this
 * one SENDS it. A path the model chose becomes bytes on someone else's
 * server, and the only person who can say whether that is the picture they
 * meant is the one looking at the path on the card. So the path is shown
 * before it is read, every time, in exactly the words the model proposed.
 *
 * Pure, so every path rule can be driven from a check without a disk.
 */
import { kindFor, looksLikeText, mimeFor, sendsBytes, MAX_SEND_BYTES, sizeLabel } from './attach'
import type { AttachKind } from './attach'

/** Windows device names, which are not files however much they look like one. */
const DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export interface LookCheck {
  ok: boolean
  /** The resolved absolute path, when it resolved. */
  path: string
  /** Why not, in words for the user rather than for a log. */
  why: string
}

/**
 * Is this a path worth trying to open, before anything touches the disk?
 *
 * Mirrors `checkWritePath` and deliberately differs in one place: there is
 * no home-directory restriction. Writing outside home can destroy something
 * the user did not name; reading outside home shows them a file they DID
 * name, on a card, before it goes anywhere. Their pictures live on whatever
 * drive they live on - this machine's repo is on D: - and refusing to look
 * at D:\shots\build.png would be the same unhelpfulness that prompted the
 * feature.
 */
export function checkLookPath(
  raw: string,
  env: { home: string; cwd: string; resolve(...parts: string[]): string }
): LookCheck {
  const text = (raw ?? '').trim().replace(/^["']|["']$/g, '')
  if (!text) return { ok: false, path: '', why: 'No file was named.' }
  if (text.length > 400) return { ok: false, path: '', why: 'That path is too long.' }
  if (/[\u0000-\u001f]/.test(text)) {
    return { ok: false, path: '', why: 'That path has control characters in it.' }
  }
  if (/[*?]/.test(text)) {
    return { ok: false, path: '', why: 'Name one file. A wildcard is not a file.' }
  }

  /* The spellings a model actually produces for the home directory. Same
     list as the write path, because the models are the same. */
  const expanded = text
    .replace(/^~(?=[\\/]|$)/, env.home)
    .replace(/\$env:USERPROFILE/gi, env.home)
    .replace(/%USERPROFILE%/gi, env.home)
    .replace(/\$HOME/g, env.home)
    .replace(/\$\{HOME\}/g, env.home)

  /* A UNC path reaches another machine. Reading one and posting it to a
     model is someone else's file leaving someone else's server. */
  if (/^\\\\/.test(expanded)) {
    return { ok: false, path: '', why: 'That is a network path, not a file on this PC.' }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(expanded)) {
    return { ok: false, path: '', why: 'That is a URL. This opens files on this PC.' }
  }

  const absolute = env.resolve(env.cwd || env.home, expanded)
  const base = absolute.split(/[\\/]/).pop() ?? ''
  if (DEVICES.test(base)) {
    return { ok: false, path: '', why: `${base} is a reserved Windows device name.` }
  }
  if (!base || base === '.' || base === '..') {
    return { ok: false, path: '', why: 'That path has no file name on the end.' }
  }
  return { ok: true, path: absolute, why: '' }
}

/**
 * The path out of a `wumpy-look` block, ignoring the reason line.
 *
 * One path per block. A model that lists three gets the first and is told
 * so, rather than having two silently dropped - the same choice the write
 * block makes, and for the same reason: a quiet partial success is the
 * hardest kind of bug for the user to notice.
 */
export function readLookRequest(raw: string): { path: string; why: string; extra: number } {
  const lines = (raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const why = lines.find((l) => l.startsWith('#'))?.replace(/^#\s*/, '') ?? ''
  const paths = lines.filter((l) => !l.startsWith('#'))
  return { path: paths[0] ?? '', why, extra: Math.max(0, paths.length - 1) }
}

/**
 * Can this kind of file be looked at, and is it worth saying why not?
 *
 * Images and documents carry their meaning in their bytes and are what the
 * feature is for. Text is refused HERE and not generally: a .ts or a .log
 * is better read with a command, which costs a quarter of the tokens and
 * can be quoted back exactly - the attach rules say so already, and a look
 * block that quietly became a worse file read would undercut them.
 */
export function canLookAt(kind: AttachKind): boolean {
  return kind === 'image' || kind === 'document'
}

export function whyNotLook(kind: AttachKind): string {
  if (kind === 'text') {
    return 'That is a text file. Read it with a command instead — exact, and a quarter of the cost.'
  }
  if (kind === 'video' || kind === 'audio') {
    return `A ${kind} file cannot be attached this way. Ask the user to attach it with the + button.`
  }
  return 'That file is not a picture or a document.'
}

/** What a file of this size and kind would cost to send, for the card. */
export function lookCost(bytes: number, kind: AttachKind): string {
  return `${sizeLabel(bytes)}${kind === 'image' ? ', about 1,100 tokens' : ''}`
}

/** The whole decision for one file, once its bytes are known. */
export function lookVerdict(
  name: string,
  bytes: number,
  sample: Uint8Array
): { ok: boolean; kind: AttachKind; mime: string; why: string } {
  /**
   * THE BYTES OVERRULE THE NAME HERE, which is the opposite of `kindFor`.
   *
   * That function lets the name win and says why: ".ts" is a stronger
   * signal than a heuristic, and someone who drags holiday.png knows what
   * they dragged. Correct for a file a PERSON chose.
   *
   * A look block is a path a MODEL chose, sometimes from a directory
   * listing and sometimes from memory, and nobody has opened it. A text
   * file called notes.png would go up as `data:image/png` carrying prose -
   * rejected by the endpoint at best, and at worst a turn spent on an
   * image the model cannot read and cannot explain. Caught here rather
   * than in `kindFor`, so the drag-and-drop behaviour that has its own
   * reasoning keeps it.
   */
  if (sample.length && looksLikeText(sample)) {
    return { ok: false, kind: 'text', mime: '', why: whyNotLook('text') }
  }
  const kind = kindFor({ name }, sample)
  if (!canLookAt(kind) || !sendsBytes(kind)) {
    return { ok: false, kind, mime: '', why: whyNotLook(kind) }
  }
  if (bytes > MAX_SEND_BYTES) {
    return {
      ok: false,
      kind,
      mime: '',
      why: `That file is ${sizeLabel(bytes)}, over the ${sizeLabel(MAX_SEND_BYTES)} limit.`
    }
  }
  if (bytes === 0) return { ok: false, kind, mime: '', why: 'That file is empty.' }
  return { ok: true, kind, mime: mimeFor({ name }, kind), why: '' }
}

/**
 * What the model is told about it.
 *
 * Sent with the picture rules rather than always, because it is only ever
 * needed by a turn that is already about an image - and the always-sent
 * half has twenty-two tokens of headroom, which this does not fit in.
 */
export const LOOK_PROMPT = [
  'YOU CAN OPEN A PICTURE THAT IS ALREADY ON THEIR DISK. A wumpy-look block, a',
  '# line saying why, then ONE path and nothing else:',
  '',
  '```wumpy-look',
  '# Read the error in the screenshot they saved',
  'D:' + String.fromCharCode(92) + 'shots' + String.fromCharCode(92) + 'build.png',
  '```',
  '',
  'The user presses it and the picture arrives on your next turn, as an image.',
  'Use it whenever they point at one. Images and PDFs only: a .ts, .log or .csv',
  'is NOT this — read those with a command, which is exact and a quarter of the',
  'cost. Do not guess a path; find it with a command first.'
].join(String.fromCharCode(10))
