import { BrowserWindow, screen, shell, app } from 'electron'
import { join } from 'node:path'
import { IPC, isTall, type Dock } from '@shared/types'
import type { SettingsStore } from './store'

/** Gap between the panel card and the screen edges, in px. */
const EDGE_MARGIN = 12

/**
 * The overlay window: frameless, transparent and always on top.
 *
 * It docks either as a full-height bar on the left or right edge, or as a
 * compact card in one of the four corners. The window is created once at
 * startup and only ever shown or hidden, so the hotkey feels instant rather
 * than booting a renderer on every press.
 */
export class Panel {
  private window: BrowserWindow | null = null
  /** While pinned the panel survives focus loss, so the user can work alongside it. */
  private pinned = false

  constructor(private readonly settings: SettingsStore) {}

  create(): BrowserWindow {
    const { width, height } = this.geometryFor(this.settings.get('dock'))

    this.window = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      // Keeps the panel out of Alt+Tab so it reads as an overlay, not a window.
      type: 'toolbar',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })

    // 'screen-saver' is the only level that reliably floats over fullscreen browsers.
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    this.window.on('blur', () => {
      if (this.pinned) return
      if (!this.settings.get('hideOnBlur')) return
      this.hide()
    })

    this.window.on('closed', () => {
      this.window = null
    })

    // Surface renderer errors in the dev terminal; without this they are only
    // visible in devtools, which an overlay window rarely has open.
    if (!app.isPackaged) {
      this.window.webContents.on('console-message', (_e, level, message, line, source) => {
        if (level < 2) return // warnings and errors only
        const where = source ? ` (${source.split('/').pop()}:${line})` : ''
        console.error(`[renderer] ${message}${where}`)
      })
      this.window.webContents.on('render-process-gone', (_e, details) =>
        console.error('[renderer] process gone:', details.reason)
      )
    }

    // Never let the overlay navigate; links belong in the real browser.
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return this.window
  }

  /** Window bounds for a dock, on whichever display the cursor is on. */
  private geometryFor(dock: Dock): { x: number; y: number; width: number; height: number } {
    const cursor = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(cursor)
    const s = this.settings.all()

    if (isTall(dock)) {
      const width = s.tallWidth + EDGE_MARGIN * 2
      const height = workArea.height - EDGE_MARGIN * 2
      const x =
        dock === 'right' ? workArea.x + workArea.width - width : workArea.x
      return { x, y: workArea.y + EDGE_MARGIN, width, height }
    }

    // Compact card: clamped so it still fits on small displays.
    const width = Math.min(s.compactWidth, workArea.width - EDGE_MARGIN * 2) + EDGE_MARGIN * 2
    const height = Math.min(s.compactHeight, workArea.height - EDGE_MARGIN * 2) + EDGE_MARGIN * 2
    const right = dock === 'top-right' || dock === 'bottom-right'
    const bottom = dock === 'bottom-left' || dock === 'bottom-right'

    return {
      x: right ? workArea.x + workArea.width - width : workArea.x,
      y: bottom ? workArea.y + workArea.height - height : workArea.y,
      width,
      height
    }
  }

  private reposition(): void {
    if (!this.window) return
    this.window.setBounds(this.geometryFor(this.settings.get('dock')))
  }

  setDock(dock: Dock): void {
    this.settings.patch({ dock })
    this.reposition()
    this.window?.webContents.send(IPC.panelDock, dock)
  }

  show(): void {
    const win = this.window ?? this.create()
    this.reposition()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.show()
    win.moveTop()
    win.focus()
    win.webContents.send(IPC.panelShown)
  }

  hide(): void {
    if (!this.window?.isVisible()) return
    // hide() hands the foreground back to whatever the user was working in.
    this.window.hide()
  }

  toggle(): void {
    if (this.window?.isVisible() && this.window.isFocused()) {
      this.hide()
    } else {
      this.show()
    }
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned
  }

  isPinned(): boolean {
    return this.pinned
  }

  /** Re-applies geometry after a size setting changes. */
  applyGeometry(): void {
    if (this.window?.isVisible()) this.reposition()
  }

  send(channel: string, payload: unknown): void {
    this.window?.webContents.send(channel, payload)
  }

  get browserWindow(): BrowserWindow | null {
    return this.window
  }
}
