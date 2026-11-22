import { desktopCapturer, nativeImage, screen, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
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
/*
 * Linux on Wayland: grim, not the screen-share portal.
 *
 * Electron captures a Wayland screen through xdg-desktop-portal, which is a
 * screen-share request - on Hyprland, a picker the person has to answer,
 * every time. For a look now and then that is a nuisance; for a meeting
 * whose screen is watched every twenty seconds it is unusable. grim reads the
 * compositor directly, with no prompt, from the monitor hyprctl says is
 * focused. One difference: Wumpy's own panel is in the picture if it is
 * showing - content protection is a Windows and macOS thing.
 */
const run = (cmd: string, args: string[]): Promise<Buffer | null> =>
  new Promise((resolve) =>
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 96 * 1024 * 1024, timeout: 8000 }, (err, out) =>
      resolve(err ? null : (out as Buffer))
    )
  )

async function grimShot(): Promise<{ image: Electron.NativeImage; display: Electron.Display } | null> {
  if (process.platform !== 'linux' || process.env.XDG_SESSION_TYPE !== 'wayland') return null
  let output: string | undefined
  let at: { x: number; y: number } | undefined
  const monitors = await run('hyprctl', ['monitors', '-j'])
  if (monitors) {
    try {
      const list = JSON.parse(monitors.toString()) as Array<{ name: string; x: number; y: number; focused: boolean }>
      const focused = list.find((m) => m.focused) ?? list[0]
      if (focused) {
        output = focused.name
        at = { x: focused.x, y: focused.y }
      }
    } catch {
      /* Not Hyprland, or not its JSON: grim takes every output, below. */
    }
  }
  const png = await run('grim', output ? ['-o', output, '-'] : ['-'])
  if (!png?.length) return null
  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) return null
  const display =
    (at && screen.getAllDisplays().find((d) => d.bounds.x === at!.x && d.bounds.y === at!.y)) ?? screen.getPrimaryDisplay()
  return { image, display }
}

export async function captureScreen(panel: BrowserWindow | null): Promise<Attachment> {
  const grim = await grimShot()
  if (grim) return encode(grim.image, grim.display)
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

    return encode(source.thumbnail, display)
  } finally {
    if (hidWumpy && !panel!.isDestroyed()) panel!.setContentProtection(false)
  }
}

/** A capture, shrunk to MAX_EDGE, as the JPEG attachment every look hands on; and the frame a click is aimed by. */
function encode(shot: Electron.NativeImage, display: Electron.Display): Attachment {
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
}
