import { desktopCapturer, screen, type BrowserWindow } from 'electron'
import type { Attachment } from '@shared/types'

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
