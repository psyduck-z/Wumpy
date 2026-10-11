import { BrowserWindow, screen, app } from 'electron'
import { log } from './log'
import { openLink } from './browser'
import { join } from 'node:path'
import { IPC, type Dock } from '@shared/types'
import { geometryFor as layoutFor, type Rect } from '@shared/geometry'
import type { SettingsStore } from './store'

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

  /**
   * Who to ask when this window needs the keyboard.
   *
   * Set by index.ts to the keyboard helper, which is the process that
   * received the hotkey and therefore the only one Windows will let change
   * the foreground. Null when the helper is not running, in which case the
   * old polite route is all there is.
   */
  private activator: ((hwnd: bigint) => void) | null = null

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
      /**
       * NOT type: 'toolbar'.
       *
       * That maps to WS_EX_TOOLWINDOW on Windows, which keeps the panel out
       * of Alt+Tab - the reason it was set - and also makes the window one
       * Windows will not activate. Measured over the DevTools protocol with
       * the panel open: the caret was in the composer and document.hasFocus()
       * was false. The renderer had done its job and the keystrokes were
       * going to whatever was underneath.
       *
       * Three separate attempts to fix autofocus were spent in the renderer
       * because of that split: active element right, window focus wrong, and
       * only one of the two is visible from inside the page.
       *
       * skipTaskbar alone keeps it off the taskbar and out of Alt+Tab, and
       * leaves it activatable.
       */
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        /**
         * The panel spends most of its life hidden, and has to work the
         * instant it is not.
         *
         * Chromium throttles hidden windows: requestAnimationFrame stops and
         * timers are held back. That is right for a background tab and wrong
         * for this, because everything that has to happen the moment the
         * panel appears - putting the caret in the box above all - runs in
         * exactly the window where the throttle is still on. The focus retry
         * loop was driven by rAF and simply never got a second attempt.
         */
        backgroundThrottling: false
      }
    })

    /**
     * The microphone, and nothing else.
     *
     * Chromium asks the embedder for every permission a page requests, and
     * Electron's default is to refuse - so without this, dictation fails with a
     * NotAllowedError that looks exactly like the user saying no. Granting it
     * wholesale would hand the panel the camera, the clipboard, notifications and
     * the screen as well, so each request is answered on its own: audio capture
     * for our own page, nothing for anything else.
     */
    this.window.webContents.session.setPermissionRequestHandler(
      (contents, permission, done, details) => {
        const own = contents === this.window?.webContents
        if (!own) return done(false)
        if (permission !== 'media') return done(false)
        // mediaTypes is absent on some requests; audio-only is the only shape we want.
        const types = (details as { mediaTypes?: string[] }).mediaTypes
        done(types === undefined ? true : types.length === 1 && types[0] === 'audio')
      }
    )

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

    /**
     * Never let the overlay navigate; links belong in the real browser.
     *
     * Through openLink rather than straight to the shell. This used to pass
     * whatever the link contained, and the links in here come from a model which
     * is fed web pages - so `[docs](steam://run/570)` or a `file://` UNC path in
     * an answer was a click away from launching something. openLink refuses
     * anything that is not http or https.
     */
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      void openLink(url)
      return { action: 'deny' }
    })

    // And never navigate the panel itself, whatever a link's target says.
    this.window.webContents.on('will-navigate', (e, url) => {
      const page = process.env.ELECTRON_RENDERER_URL
      if (page && url.startsWith(page)) return
      e.preventDefault()
      void openLink(url)
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return this.window
  }

  /** Window bounds for a dock, on whichever display the cursor is on. */
  private geometryFor(dock: Dock): Rect {
    const cursor = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(cursor)
    const s = this.settings.all()
    return layoutFor(dock, workArea, s)
  }

  private reposition(): void {
    if (!this.window) return
    this.window.setBounds(this.geometryFor(this.settings.get('dock')))
  }

  /**
   * The live window, for the one or two things that need the object itself.
   *
   * Named apart from the private field it returns. Screen capture needs it
   * to work out which display the user is looking at, and to keep the panel
   * out of its own photograph.
   */
  liveWindow(): BrowserWindow | null {
    return this.window
  }

  /** Wire up whoever can take the foreground on this window's behalf. */
  setActivator(activate: (hwnd: bigint) => void): void {
    this.activator = activate
  }

  /**
   * This window's Win32 handle, for the helper that will activate it.
   *
   * getNativeWindowHandle returns the raw pointer bytes; on x64 that is a
   * 64-bit little-endian value. Read as anything narrower it is silently
   * wrong on exactly the machines where the top bits are set.
   */
  private handle(win: BrowserWindow): bigint | null {
    try {
      const buf = win.getNativeWindowHandle()
      return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
    } catch {
      return null
    }
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

    /**
     * Taking the keyboard needs more than show() on Windows, and more than
     * app.focus() too.
     *
     * The foreground belongs to whatever the user was working in, and Windows
     * refuses to hand it to a process that is not already there - which Wumpy
     * never is, because the hotkey arrives in a background hook. show(),
     * focus() and app.focus({ steal: true }) all return happily and none of
     * them wins the foreground.
     *
     * Measured over the DevTools protocol, with another app made foreground
     * first and the panel then shown the way the hotkey shows it:
     *
     *   document.activeElement  the composer textarea   (right)
     *   document.hasFocus()     false                   (wrong)
     *
     * The caret was in the box and the keystrokes were going elsewhere. Three
     * attempts at this were spent in the renderer, because from inside the
     * page the first line looks like success.
     *
     * minimize() then restore() is what actually works. Restoring a minimized
     * window is a path Windows does grant activation to, where showing a
     * hidden one is not. It is a hack and it is worth it: the alternative is
     * a panel that opens on a keystroke and then ignores the keyboard.
     *
     * Only when the ordinary route failed, so the usual case pays nothing and
     * there is no flicker unless there would otherwise have been a bug.
     */
    app.focus({ steal: true })
    win.focus()
    /**
     * Immediately, not later, when the polite route has already lost.
     *
     * Whatever right to change the foreground this process has, it has it
     * now - measured, the same minimize/restore run about 600ms later
     * through an IPC round trip does not work, while run here it does.
     * isFocused() is only a proxy for the truth, but it is the only one
     * available synchronously, and acting on it costs nothing when it is
     * wrong in the harmless direction.
     */
    const polite = win.isFocused()
    if (!polite) {
      /**
       * The fallback, and no longer the mechanism.
       *
       * The hook now calls AllowSetForegroundWindow before it reports the
       * toggle, so focus() above usually just works and this never runs.
       * It is kept for the paths with no keystroke behind them - the tray
       * icon, a second instance - where nothing has granted anything.
       *
       * It flickers, which is what the user saw. Hiding that behind
       * setOpacity(0) was the obvious fix and is measurably wrong: making
       * the window layered stopped Windows activating it at all, taking
       * real hotkey presses from 2-of-3 to 0-of-3. Left visible rather than
       * broken quietly.
       */
      win.minimize()
      win.restore()
      win.focus()
    }
    win.webContents.focus()

    /**
     * And then ask the one process that can actually do it.
     *
     * Everything above is Wumpy asking Windows for the foreground, which
     * Windows is entitled to refuse and does: this process did not receive
     * the keystroke, so it has no right to take the foreground from whatever
     * the user was working in. Five fixes were built downstream of that
     * fact without addressing it.
     *
     * The helper did receive the keystroke. Now that the window is visible,
     * it can hand it the keyboard directly. Harmless on the paths with no
     * keystroke behind them - the tray, a second instance - where it simply
     * reports that it could not.
     */
    const hwnd = this.handle(win)
    if (hwnd !== null) this.activator?.(hwnd)

    win.webContents.send(IPC.panelShown)
    this.watchKeyboard(polite ? 'focus()' : 'minimize/restore')
  }

  /**
   * Did the keyboard actually arrive, and when?
   *
   * One line in the log for every time the panel opens, because "it still
   * does not autofocus" has been reported five times and never once with a
   * number attached. document.hasFocus() is the only honest answer and it
   * lives in the page, so this asks the page - repeatedly, because the
   * handover is asynchronous and the interesting part is how long it took.
   *
   * win.isFocused() is not a substitute: it has been observed true while
   * Windows had handed over nothing, which is how an earlier guard came to
   * do nothing at all.
   */
  private watchKeyboard(route: string): void {
    const win = this.window
    if (!win) return
    const startedAt = Date.now()
    const probe = (): void => {
      if (!this.window || this.window.isDestroyed() || win !== this.window) return
      if (!win.isVisible()) return // closed again before it ever mattered
      void win.webContents
        .executeJavaScript(
          '({ has: document.hasFocus(), active: (document.activeElement && ' +
            'document.activeElement.tagName || "none").toLowerCase() })'
        )
        .then((r: { has: boolean; active: string }) => {
          const ms = Date.now() - startedAt
          if (r.has) {
            log(`[focus] keyboard arrived after ${ms}ms via ${route}, caret on ${r.active}`)
            return
          }
          if (ms >= 1200) {
            log(
              `[focus] NO KEYBOARD after ${ms}ms via ${route}; caret on ${r.active}. ` +
                'Keystrokes are going to whatever is underneath.'
            )
            return
          }
          setTimeout(probe, 40)
        })
        .catch(() => {})
    }
    probe()
  }

  /**
   * Take the foreground by force, because the polite route lost.
   *
   * The last resort, after show() has already tried everything it can do
   * synchronously.
   *
   * Called when the renderer reports that it still does not hold the
   * keyboard after half a second of trying. That report is the only
   * trustworthy signal there is: document.hasFocus() is the truth, it lives
   * in the page, and the main process cannot read it - win.isFocused() is a
   * proxy that can say true while Windows has handed over nothing.
   *
   * Measured: this works far less often than the same calls made inside
   * show(), because by now the brief right to change the foreground is
   * gone. It is here for the case where show()'s own attempt lost and
   * something can still be salvaged, not as the main mechanism.
   */
  forceFocus(): void {
    const win = this.window
    if (!win || !win.isVisible()) return
    console.log('[wumpy] renderer reports no keyboard; forcing the foreground')

    /**
     * Ask the helper first, because it is the one with the right.
     *
     * The calls below are this process asking Windows for something Windows
     * has already refused once. The helper received the keystroke, so it is
     * the one that can insist - and unlike minimize/restore it does not
     * flicker.
     */
    const hwnd = this.handle(win)
    if (hwnd !== null) this.activator?.(hwnd)

    win.minimize()
    /**
     * Whether that did anything at all, which has never been checked.
     *
     * The window is created with minimizable: false, and this fallback is
     * built entirely on minimize/restore being the one route Windows grants
     * activation to. If Electron is refusing the minimize, the "fallback"
     * has been doing nothing on every path that reached it.
     */
    if (!win.isMinimized()) log('[focus] minimize() did nothing - the window refuses to minimise')
    win.restore()
    win.setAlwaysOnTop(true, 'screen-saver')
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    win.webContents.send(IPC.panelShown)

    /**
     * Says whether it worked, which it never used to.
     *
     * This fired and nobody found out what happened next - the renderer
     * asked for help, help was attempted, and the only way to know the
     * outcome was to watch the screen. Asking the page afterwards costs
     * one round trip on a path that has already given up half a second,
     * and it is the difference between a bug report and a measurement.
     */
    setTimeout(() => {
      if (!this.window || this.window.isDestroyed()) return
      void this.window.webContents
        .executeJavaScript('document.hasFocus()')
        .then((got: boolean) => {
          console.log(`[wumpy] forced foreground ${got ? 'worked' : 'DID NOT WORK'}`)
        })
        .catch(() => {})
    }, 250)
  }

  hide(): void {
    if (!this.window?.isVisible()) return
    // hide() hands the foreground back to whatever the user was working in.
    this.window.hide()
  }

  /**
   * Shows or hides, once per press.
   *
   * The guard is for repeats, not for the user. Holding a hotkey down makes
   * Windows deliver the keystroke over and over, and the helper process now
   * reports one TOGGLE per press - but RegisterHotKey, which is what any extra
   * accelerator in the settings goes through, repeats the same way and has no
   * such filter. Without this, holding one of those flashed the panel open and
   * shut at the keyboard's repeat rate.
   *
   * It has to stay short enough that deliberately tapping twice - open, then
   * immediately shut again - still lands. 120ms is several times a repeat
   * interval and well under a double tap.
   */
  private lastToggle = 0

  toggle(): void {
    const now = Date.now()
    if (now - this.lastToggle < 120) return
    this.lastToggle = now

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
