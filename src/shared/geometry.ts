import { isTall, type Dock } from './types'

/**
 * Where the panel sits, worked out without a screen attached.
 *
 * Pulled out of panel.ts so the arithmetic can be checked. It is the kind of
 * code that looks obviously right and is off by a title bar.
 */

/** Gap between the panel card and the screen edges, in px. */
export const EDGE_MARGIN = 12

/**
 * Room left at the top for the window underneath.
 *
 * The panel docks against the top of the work area, and a maximised window
 * keeps its minimise, maximise and close buttons in exactly that strip at the
 * top right - so a right-docked panel sat on top of them and they could
 * neither be seen nor clicked. Reported with a screenshot of precisely that.
 *
 * 44 is the Windows 11 caption strip (32dip) plus the usual edge margin.
 * Bounds are in device-independent pixels, so this holds at any display
 * scaling without being multiplied by anything.
 */
export const TITLEBAR_CLEARANCE = 44

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelSizes {
  tallWidth: number
  compactWidth: number
  compactHeight: number
}

/**
 * The window rectangle for a dock within a work area.
 *
 * The margin is carried INSIDE the window - the window is wider and taller
 * than the visible card - so that the card can have a drop shadow and rounded
 * corners with nothing clipping them.
 */
export function geometryFor(dock: Dock, workArea: Rect, sizes: PanelSizes): Rect {
  if (isTall(dock)) {
    /* Never more than half a small screen, however wide it was set. */
    const width = Math.min(sizes.tallWidth, Math.max(320, Math.round(workArea.width / 2))) + EDGE_MARGIN * 2
    /* Top clearance, bottom margin: not symmetric any more, on purpose. */
    const height = Math.max(120, workArea.height - TITLEBAR_CLEARANCE - EDGE_MARGIN)
    const x = dock === 'right' ? workArea.x + workArea.width - width : workArea.x
    return { x, y: workArea.y + TITLEBAR_CLEARANCE, width, height }
  }

  // Compact card: clamped so it still fits on small displays.
  const width = Math.min(sizes.compactWidth, workArea.width - EDGE_MARGIN * 2) + EDGE_MARGIN * 2
  const tallest = workArea.height - TITLEBAR_CLEARANCE - EDGE_MARGIN
  const height = Math.min(sizes.compactHeight, Math.max(120, tallest)) + EDGE_MARGIN * 2
  const right = dock === 'top-right' || dock === 'bottom-right'
  const bottom = dock === 'bottom-left' || dock === 'bottom-right'

  return {
    x: right ? workArea.x + workArea.width - width : workArea.x,
    /*
     * A top-docked card needs the same clearance, less the margin already
     * baked into its own height.
     */
    y: bottom
      ? workArea.y + workArea.height - height
      : workArea.y + TITLEBAR_CLEARANCE - EDGE_MARGIN,
    width,
    height
  }
}

/** The visible card's top edge, which is what the user actually sees. */
export function cardTop(dock: Dock, workArea: Rect, sizes: PanelSizes): number {
  const r = geometryFor(dock, workArea, sizes)
  return isTall(dock) ? r.y : r.y + EDGE_MARGIN
}
