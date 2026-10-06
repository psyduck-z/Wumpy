import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type {
  ChatDelta,
  ChatDone,
  ChatError,
  ChatRequest,
  HotkeyState,
  OllamaModel,
  OllamaStatus,
  WumpySettings
} from '@shared/types'

/** Returns an unsubscribe function so React effects can clean up properly. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  settings: {
    get: (): Promise<WumpySettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<WumpySettings>): Promise<WumpySettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  ollama: {
    status: (): Promise<OllamaStatus> => ipcRenderer.invoke(IPC.ollamaStatus),
    models: (): Promise<OllamaModel[]> => ipcRenderer.invoke(IPC.ollamaModels)
  },
  chat: {
    send: (req: ChatRequest): Promise<void> => ipcRenderer.invoke(IPC.chatSend, req),
    abort: (requestId: string): void => ipcRenderer.send(IPC.chatAbort, requestId),
    onDelta: (cb: (d: ChatDelta) => void) => on(IPC.chatDelta, cb),
    onDone: (cb: (d: ChatDone) => void) => on(IPC.chatDone, cb),
    onError: (cb: (d: ChatError) => void) => on(IPC.chatError, cb)
  },
  panel: {
    hide: (): void => ipcRenderer.send(IPC.panelHide),
    setPinned: (pinned: boolean): void => ipcRenderer.send(IPC.panelPin, pinned),
    onShown: (cb: () => void) => on(IPC.panelShown, cb)
  },
  hotkey: {
    get: (): Promise<HotkeyState> => ipcRenderer.invoke(IPC.hotkeyState),
    onChange: (cb: (s: HotkeyState) => void) => on(IPC.hotkeyState, cb)
  }
}

export type WumpyApi = typeof api

contextBridge.exposeInMainWorld('wumpy', api)
