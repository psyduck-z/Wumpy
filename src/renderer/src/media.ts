/**
 * Getting a pasted screenshot down to something worth sending.
 *
 * A Win+Shift+S capture off this machine is 2560 wide and two or three
 * megabytes of PNG. Base64 adds a third again, and every one of those bytes
 * goes up the wire on THIS turn and lives in the saved chat file afterwards,
 * so an unshrunk screenshot is a four-megabyte line in a JSON file that is
 * re-read every time the chat is opened.
 *
 * None of that buys anything. The model stops gaining detail well before
 * 2560 pixels; 1568 on the long edge is where Claude's own guidance puts the
 * ceiling and Gemini is no hungrier. JPEG rather than PNG because a
 * screenshot of a window is a photograph as far as the encoder is concerned
 * once it has been scaled, and the difference is an order of magnitude.
 *
 * What this does NOT save is tokens. Measured against gemini-3.5-flash: a
 * 96x96 square billed 1,104 prompt tokens, an 800x450 billed 1,115, and a
 * 1568x882 billed 1,115 as well. The charge is essentially flat, so the
 * shrink buys upload time, memory and a chat file that is not a photo
 * album — and an attached image costs about eleven hundred tokens whatever
 * is done to it, which is the number worth knowing before attaching four.
 *
 * PNG is kept for images that are small already: a 200x80 crop of text
 * re-encoded as JPEG picks up ringing around the letters, which is the one
 * case where the file was never the problem.
 */
import type { Attachment } from '@shared/types'

/** The long edge, past which more pixels are not more information. */
export const MAX_EDGE = 1568

/** Encoded size to aim under, before base64 inflates it by a third. */
export const TARGET_BYTES = 900_000

/** Anything already smaller than this is left exactly as it is. */
const KEEP_AS_IS = 120_000

/** Hard ceiling. Past it the attachment is refused rather than sent. */
export const MAX_BYTES = 6_000_000

/**
 * What kind of thing this is, or null if it is not one Wumpy can send.
 *
 * Both go up the same way. Measured against the live API: a three-second
 * mp4 handed to the OpenAI-compatible endpoint as a data URL inside an
 * image_url part came back "Red / Green / Blue" for a clip that is a second
 * each of red, green and blue, at 203 prompt tokens - against 14 for the
 * same question with nothing attached. So there is no second code path to
 * build; there is only a wider idea of what an attachment is.
 */
export type MediaKind = 'image' | 'video'

export function kindOf(file: { type?: string; name?: string }): MediaKind | null {
  if (file.type?.startsWith('image/')) return 'image'
  if (file.type?.startsWith('video/')) return 'video'
  const name = file.name ?? ''
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi|m4v|mpe?g|wmv|3gp)$/i.test(name)) return 'video'
  return null
}

export function isImageFile(file: { type?: string; name?: string }): boolean {
  return kindOf(file) === 'image'
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
    reader.readAsDataURL(blob)
  })
}

function load(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('that file is not an image Windows can decode'))
    img.src = dataUrl
  })
}

/** Bytes behind a data URL, without decoding it. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** The scale that brings the long edge under the ceiling, never above 1. */
export function scaleFor(width: number, height: number, maxEdge = MAX_EDGE): number {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return 1
  return maxEdge / longest
}

/**
 * Reads a file or a pasted blob and returns something sendable.
 *
 * Throws with a sentence worth showing the user rather than a code: this is
 * driven by a paste, and a paste that does nothing and says nothing is the
 * worst of the possible outcomes.
 */
export async function shrinkImage(blob: Blob, name?: string): Promise<Attachment> {
  if (blob.size > MAX_BYTES) {
    throw new Error(`That image is ${Math.round(blob.size / 1_000_000)}MB. Six is the limit.`)
  }
  const original = await readAsDataUrl(blob)
  const img = await load(original)
  const scale = scaleFor(img.naturalWidth, img.naturalHeight)

  if (scale === 1 && blob.size <= KEEP_AS_IS) {
    return {
      kind: 'image',
      dataUrl: original,
      name,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: blob.size
    }
  }

  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not resize that image.')
  ctx.drawImage(img, 0, 0, width, height)

  /**
   * Two passes at most, and only when the first one misses.
   *
   * Quality is a guess about content, not about size: a screenshot of text
   * compresses to a tenth of a photograph at the same setting. Rather than
   * search for a quality that hits the target, this takes one good one and
   * only drops if the result is still large.
   */
  let out = canvas.toDataURL('image/jpeg', 0.82)
  if (dataUrlBytes(out) > TARGET_BYTES) out = canvas.toDataURL('image/jpeg', 0.6)

  return { kind: 'image', dataUrl: out, name, width, height, bytes: dataUrlBytes(out) }
}

/** Every image on a clipboard or drop event, in the order they arrive. */
export function mediaIn(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return []
  const files: File[] = []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as DataTransferItem | File
    const file = 'getAsFile' in entry ? entry.getAsFile() : entry
    if (file && kindOf(file)) files.push(file)
  }
  return files
}

/**
 * How many tokens a clip will cost, near enough to warn with.
 *
 * Measured by countTokens against gemini-3.5-flash: a 3-second 320x240 clip
 * came to 376 and a 30-second 640x360 clip to 3,165, so about 105 a second
 * and barely sensitive to the frame size. That makes a one-minute clip
 * roughly 6,300 tokens and a five-minute one 31,500 - which is why the
 * length is on the chip. An image, by contrast, is a flat ~1,100 however
 * big it is.
 */
export const TOKENS_PER_SECOND = 105

/** Videos are passed through whole: there is no canvas trick for a clip. */
export const MAX_VIDEO_BYTES = 15_000_000

/**
 * A video, read as it is.
 *
 * Nothing is re-encoded. Shrinking an image is a canvas call; shrinking a
 * video means a codec, and the tokens barely move with frame size anyway -
 * it is the SECONDS that cost, and trimming those is a decision only the
 * person who shot it can make. So the cap is on bytes, the length is shown,
 * and the choice is theirs.
 */
export async function readVideo(file: Blob, name?: string): Promise<Attachment> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(
      `That video is ${Math.round(file.size / 1_000_000)}MB. ` +
        `${Math.round(MAX_VIDEO_BYTES / 1_000_000)} is the limit — the whole request has to fit in one.`
    )
  }
  const dataUrl = await readAsDataUrl(file)
  const probe = await measureVideo(dataUrl)
  return { kind: 'video', dataUrl, name, bytes: file.size, ...probe }
}

/** Dimensions and length, from the browser's own decoder. */
function measureVideo(
  dataUrl: string
): Promise<{ width: number; height: number; seconds: number }> {
  return new Promise((resolve) => {
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.muted = true
    const done = (): void =>
      resolve({
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        // A stream with no duration in its header reports Infinity. Zero is
        // the honest answer there, and the chip simply says nothing.
        seconds: Number.isFinite(el.duration) ? Math.round(el.duration) : 0
      })
    el.onloadedmetadata = done
    // Still sendable if Chromium cannot read the header: the model gets the
    // bytes either way, and all that is lost is the length on the chip.
    el.onerror = () => resolve({ width: 0, height: 0, seconds: 0 })
    el.src = dataUrl
  })
}

/** Reads whichever kind it is. */
export async function readMedia(file: File): Promise<Attachment> {
  return kindOf(file) === 'video'
    ? readVideo(file, file.name || undefined)
    : shrinkImage(file, file.name || undefined)
}
