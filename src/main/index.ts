import { app, ipcMain, nativeImage, Tray } from 'electron'
import { IPC } from '@shared/types'
import type { ChatRequest, HotkeyState, WumpySettings } from '@shared/types'
import { SettingsStore } from './store'
import { OllamaClient } from './ollama'
import { Panel } from './panel'
import { createTray, resourcePath } from './tray'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { LowLevelHook } from './lowlevelhook'

// Only one Wumpy may own the tray icon and the global hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setAppUserModelId('dev.psyduckz.wumpy')
// Registering any handler here overrides Electron's quit-on-last-window
// behaviour, which is what keeps Wumpy alive in the tray with no window open.
app.on('window-all-closed', () => {})

let settings: SettingsStore
let ollama: OllamaClient
let panel: Panel
let tray: (Tray & { refresh(): void }) | null = null
let hotkeyState: HotkeyState = { active: null, failed: [], intercepted: null }
let lowLevelHook: LowLevelHook | null = null

function applyHotkeys(): void {
  const intercepted = hotkeyState.intercepted
  hotkeyState = registerHotkeys(settings.get('hotkeys'), () => panel.toggle())
  // The low-level hook is owned separately; preserve what it already claimed.
  hotkeyState.intercepted = intercepted

  if (!hotkeyState.active) {
    console.warn('[wumpy] no accelerator could be registered:', hotkeyState.failed.join(', '))
  } else {
    console.log(`[wumpy] accelerator active: ${hotkeyState.active}`)
  }
  tray?.refresh()
  panel.send(IPC.hotkeyState, hotkeyState)
}

/**
 * Claims Win+C through the helper process. RegisterHotKey cannot take it
 * because the shell holds it for Copilot, so we intercept it a layer lower.
 */
async function startLowLevelHook(): Promise<void> {
  lowLevelHook = new LowLevelHook('C', () => panel.toggle())
  const ok = await lowLevelHook.start()
  hotkeyState.intercepted = ok ? 'Super+C' : null
  if (!ok) {
    lowLevelHook = null
    console.warn('[wumpy] Win+C interception unavailable; using the accelerator fallback')
  }
  tray?.refresh()
  panel.send(IPC.hotkeyState, hotkeyState)
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settings.all())

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WumpySettings>) => {
    const next = settings.patch(patch)
    if (patch.ollamaHost) ollama.setHost(next.ollamaHost)
    if (patch.hotkeys) applyHotkeys()
    if (patch.panelWidth) panel.applyWidth()
    if (patch.launchAtLogin !== undefined) syncLaunchAtLogin(patch.launchAtLogin)
    tray?.refresh()
    return next
  })

  ipcMain.handle(IPC.ollamaStatus, () => ollama.status())
  ipcMain.handle(IPC.ollamaModels, () => ollama.models())

  ipcMain.handle(IPC.chatSend, async (_e, req: ChatRequest) => {
    const { systemPrompt, chatModel, thinking } = settings.all()
    const model = req.model ?? chatModel
    const messages = systemPrompt
      ? [{ role: 'system' as const, content: systemPrompt }, ...req.messages]
      : req.messages

    await ollama.chat(req.requestId, model, messages, { thinking }, {
      onDelta: (delta) => panel.send(IPC.chatDelta, { requestId: req.requestId, ...delta }),
      onDone: (stats) => panel.send(IPC.chatDone, { requestId: req.requestId, ...stats }),
      onError: (message) => panel.send(IPC.chatError, { requestId: req.requestId, message })
    })
  })

  ipcMain.on(IPC.chatAbort, (_e, requestId: string) => ollama.abort(requestId))
  ipcMain.on(IPC.panelHide, () => panel.hide())
  ipcMain.on(IPC.panelPin, (_e, pinned: boolean) => panel.setPinned(pinned))
  ipcMain.handle(IPC.hotkeyState, () => hotkeyState)
}

/**
 * Keeps the configured model honest: a settings file can outlive the model it
 * names (uninstalled, renamed, pulled on another machine), and a stale name
 * would make every message fail with a raw 404 from Ollama.
 */
async function reconcileModel(): Promise<void> {
  const installed = await ollama.models()
  if (installed.length === 0) return

  const configured = settings.get('chatModel')
  if (installed.some((m) => m.name === configured)) return

  // Prefer a tag that differs only by suffix (e.g. `qwen3:4b` vs `qwen3:latest`).
  const base = configured.split(':')[0]
  const fallback = installed.find((m) => m.name.startsWith(`${base}:`)) ?? installed[0]

  console.warn(`[wumpy] model "${configured}" is not installed; using "${fallback.name}"`)
  settings.patch({ chatModel: fallback.name })
  tray?.refresh()
}

function syncLaunchAtLogin(enabled: boolean): void {
  // Packaged builds only — in dev this would register the Electron binary itself.
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

void app.whenReady().then(() => {
  settings = new SettingsStore()
  ollama = new OllamaClient(settings.get('ollamaHost'))
  panel = new Panel(settings)

  registerIpc()
  panel.create()

  const icon = nativeImage.createFromPath(resourcePath('icon.png'))
  if (!icon.isEmpty()) panel.browserWindow?.setIcon(icon)

  tray = createTray({
    panel,
    settings,
    getHotkeyState: () => hotkeyState,
    onToggleLaunchAtLogin: syncLaunchAtLogin
  }) as Tray & { refresh(): void }

  applyHotkeys()
  void startLowLevelHook()
  syncLaunchAtLogin(settings.get('launchAtLogin'))
  void reconcileModel()

  // Launched by the login item: stay in the tray instead of popping up.
  if (!process.argv.includes('--hidden')) panel.show()
})

app.on('second-instance', () => panel?.show())

app.on('will-quit', () => {
  unregisterHotkeys()
  lowLevelHook?.stop()
  ollama?.abortAll()
})
