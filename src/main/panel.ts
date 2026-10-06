import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import type { SettingsStore } from './store'

/** Gap between the panel card and the screen edges, in px. */
const EDGE_MARGIN = 12

/**
 * The overlay window: a frameless, transparent, always-on-top strip pinned to the
 * right edge of whichever display the cursor is on. It is created once at startup
 * and only ever shown/hidden, so the hotkey feels instant instead of booting a
 * renderer on every press.
 */
export class Panel {
  private window: BrowserWindow | null = null
  /** While pinned the panel survives focus loss, so the user can work alongside it. */
  private pinned = false

  constructor(private readonly settings: SettingsStore) {}

  create(): BrowserWindow {
    const width = this.settings.get('panelWidth') + EDGE_MARGIN * 2

    this.window = new BrowserWindow({
      width,
      height: 800,
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

  /** Re-anchors the panel to the display the cursor currently sits on. */
  private reposition(): void {
    if (!this.window) return
    const cursor = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(cursor)
    const width = this.settings.get('panelWidth') + EDGE_MARGIN * 2
    const height = workArea.height - EDGE_MARGIN * 2

    this.window.setBounds({
      x: workArea.x + workArea.width - width,
      y: workArea.y + EDGE_MARGIN,
      width,
      height
    })
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

  applyWidth(): void {
    if (this.window?.isVisible()) this.reposition()
  }

  send(channel: string, payload: unknown): void {
    this.window?.webContents.send(channel, payload)
  }

  get browserWindow(): BrowserWindow | null {
    return this.window
  }
}
