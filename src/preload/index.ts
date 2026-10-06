import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type {
  ChatDelta,
  ChatDone,
  ChatError,
  ChatMessage,
  ChatRequest,
  ChatSummary,
  Dock,
  HotkeyState,
  OllamaModel,
  OllamaStatus,
  SavedChat,
  TierId,
  TierStatus,
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
  tiers: {
    status: (): Promise<TierStatus[]> => ipcRenderer.invoke(IPC.tiersStatus),
    warm: (id: TierId): Promise<TierStatus[]> => ipcRenderer.invoke(IPC.tiersWarm, id),
    onStatus: (cb: (s: TierStatus[]) => void) => on(IPC.tiersStatus, cb)
  },
  chat: {
    send: (req: ChatRequest): Promise<void> => ipcRenderer.invoke(IPC.chatSend, req),
    abort: (requestId: string): void => ipcRenderer.send(IPC.chatAbort, requestId),
    onDelta: (cb: (d: ChatDelta) => void) => on(IPC.chatDelta, cb),
    onDone: (cb: (d: ChatDone) => void) => on(IPC.chatDone, cb),
    onError: (cb: (d: ChatError) => void) => on(IPC.chatError, cb),
    /** Summarise older turns; resolves to the summary text, or null on failure. */
    compact: (req: {
      tier: TierId
      messages: Array<{ role: string; content: string }>
    }): Promise<string | null> => ipcRenderer.invoke(IPC.chatCompact, req)
  },
  chats: {
    list: (): Promise<ChatSummary[]> => ipcRenderer.invoke(IPC.chatsList),
    load: (id: string): Promise<SavedChat | null> => ipcRenderer.invoke(IPC.chatsLoad, id),
    save: (chat: {
      id: string
      title?: string
      messages: ChatMessage[]
      tier: TierId
    }): Promise<ChatSummary | null> => ipcRenderer.invoke(IPC.chatsSave, chat),
    rename: (id: string, title: string): Promise<ChatSummary | null> =>
      ipcRenderer.invoke(IPC.chatsRename, id, title),
    /** Pass '*' to clear every saved chat; resolves to the number removed. */
    delete: (id: string): Promise<boolean | number> => ipcRenderer.invoke(IPC.chatsDelete, id)
  },
  panel: {
    hide: (): void => ipcRenderer.send(IPC.panelHide),
    setPinned: (pinned: boolean): void => ipcRenderer.send(IPC.panelPin, pinned),
    setDock: (dock: Dock): void => ipcRenderer.send(IPC.panelDock, dock),
    onShown: (cb: () => void) => on(IPC.panelShown, cb),
    onDock: (cb: (d: Dock) => void) => on(IPC.panelDock, cb)
  },
  hotkey: {
    get: (): Promise<HotkeyState> => ipcRenderer.invoke(IPC.hotkeyState),
    onChange: (cb: (s: HotkeyState) => void) => on(IPC.hotkeyState, cb)
  }
}

export type WumpyApi = typeof api

contextBridge.exposeInMainWorld('wumpy', api)
