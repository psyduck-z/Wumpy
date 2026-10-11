import { desktopCapturer, screen, type BrowserWindow } from 'electron'
import type { Attachment } from '@shared/types'
import type { ShotFrame } from '@shared/steps'

/**
 * What the last screenshot was of, so a click can be put back where it
 * belongs.
 *
 * The model points at a pixel in an image. That image is one display,
 * captured at its size in device-independent pixels and then shrunk to fit
 * 1568px, so turning the pixel back into a screen coordinate needs both the
 * shrink factor and the display's own origin - which is not (0,0) on a
 * second monitor, and is exactly the term whose absence sends every click to
 * the wrong screen.
 *
 * Held here rather than passed through the renderer and the chat file: it is
 * a fact about a photograph taken moments ago, not part of the conversation,
 * and a stale copy of it arriving back from the page would be a click aimed
 * by whatever the page last said.
 */
let lastFrame: ShotFrame | null = null

export function lastShot(): ShotFrame | null {
  return lastFrame
}

/** Forgotten when a chat is cleared, so a click cannot use yesterday's frame. */
export function forgetShot(): void {
  lastFrame = null
}

/**
 * A photograph of the screen, taken only when the user clicks.
 *
 * The model cannot look at anything by itself. It proposes a `wumpy-screen`
 * block saying why it wants to see, that becomes a card, and nothing is
 * captured until the button is pressed. The image is then shown in the
 * transcript, so what was sent is never a question - the user is looking at
 * the same picture the model got.
 *
 * It goes to Google, like every other turn, which is the reason the card
 * says so rather than just saying "Screenshot".
 */

/**
 * 1568px on the long edge, the same ceiling as a pasted image.
 *
 * Measured against synthetic text at known sizes: this is where ordinary
 * UI type stops surviving the downscale. Smaller saves bytes and buys
 * nothing - an image costs about the same in tokens whatever its size, so
 * the only thing shrinking protects is the chat file.
 */
const MAX_EDGE = 1568

/** Enough quality to read a menu, not enough to matter in a chat file. */
const JPEG_QUALITY = 72

/**
 * Which screen the user is actually looking at.
 *
 * The panel is docked on one display and that is where their attention is.
 * Capturing the primary display instead would, on a two-monitor desk, hand
 * the model a photograph of the screen the user is not using.
 */
function displayFor(panel: BrowserWindow | null): Electron.Display {
  if (!panel) return screen.getPrimaryDisplay()
  const bounds = panel.getBounds()
  return screen.getDisplayMatching(bounds)
}

/**
 * Capture the screen behind the panel.
 *
 * setContentProtection keeps Wumpy out of its own photograph. Measured: a
 * window covering 199,447 pixels of the capture contributed none of them
 * with it on. The alternative was hiding the panel for the duration, and
 * hiding it means showing it again - which is the autofocus problem, and
 * not a price worth paying for a screenshot.
 *
 * Turned off again afterwards, because a window that is permanently
 * invisible to capture is one the user cannot screenshot either, and they
 * may well want to.
 */
export async function captureScreen(panel: BrowserWindow | null): Promise<Attachment> {
  const display = displayFor(panel)
  const { width, height } = display.size
  const hidWumpy = Boolean(panel) && !panel!.isDestroyed()

  if (hidWumpy) {
    panel!.setContentProtection(true)
    // One compositor frame, or the exclusion has not taken effect yet.
    await new Promise((r) => setTimeout(r, 120))
  }
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    })
    const source =
      sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
    if (!source) throw new Error('no screen to capture')

    const shot = source.thumbnail
    const size = shot.getSize()
    const longest = Math.max(size.width, size.height)
    const scaled =
      longest > MAX_EDGE
        ? shot.resize(
            size.width >= size.height
              ? { width: MAX_EDGE }
              : { height: MAX_EDGE }
          )
        : shot
    const jpeg = scaled.toJPEG(JPEG_QUALITY)
    const out = scaled.getSize()
    /*
     * bounds, not size: size is the display's dimensions and bounds carries
     * its position in the virtual desktop too. SetCursorPos takes the latter.
     */
    const b = display.bounds
    lastFrame = {
      displayX: b.x,
      displayY: b.y,
      displayWidth: b.width,
      displayHeight: b.height,
      imageWidth: out.width,
      imageHeight: out.height
    }
    return {
      kind: 'image',
      dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      name: 'screen.jpg',
      width: out.width,
      height: out.height,
      bytes: jpeg.length
    }
  } finally {
    if (hidWumpy && !panel!.isDestroyed()) panel!.setContentProtection(false)
  }
}
