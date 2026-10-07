import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type { LinkCheck } from '@shared/links'
import type {
  ChatDelta,
  ChatDone,
  ChatError,
  ChatMessage,
  ChatRequest,
  ChatSummary,
  CommandVerdict,
  Dock,
  HotkeyState,
  OllamaModel,
  OllamaStatus,
  SavedChat,
  Dictation,
  LinkResult,
  SearchResult,
  WriteResult,
  WriteTarget,
  ShellKind,
  ShellResult,
  TierId,
  TierStatus,
  VoiceStatus,
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
      ipcRenderer.invoke(IPC.settingsSet, patch),
    onChange: (cb: (s: WumpySettings) => void) => on<WumpySettings>(IPC.settingsChanged, cb)
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
    }): Promise<string | null> => ipcRenderer.invoke(IPC.chatCompact, req),
    /** Names a conversation from its opening exchange. */
    title: (req: {
      messages: Array<{ role: string; content: string }>
    }): Promise<string | null> => ipcRenderer.invoke(IPC.chatTitle, req)
  },
  /** What the user has typed before, oldest first. */
  history: {
    get: (): Promise<string[]> => ipcRenderer.invoke(IPC.historyGet),
    add: (text: string): Promise<string[]> => ipcRenderer.invoke(IPC.historyAdd, text)
  },
  chats: {
    list: (): Promise<ChatSummary[]> => ipcRenderer.invoke(IPC.chatsList),
    load: (id: string): Promise<SavedChat | null> => ipcRenderer.invoke(IPC.chatsLoad, id),
    save: (chat: {
      id: string
      title?: string
      messages: ChatMessage[]
      tier: TierId
      titleLocked?: boolean
    }): Promise<ChatSummary | null> => ipcRenderer.invoke(IPC.chatsSave, chat),
    rename: (id: string, title: string): Promise<ChatSummary | null> =>
      ipcRenderer.invoke(IPC.chatsRename, id, title),
    /** Pass '*' to clear every saved chat; resolves to the number removed. */
    delete: (id: string): Promise<boolean | number> => ipcRenderer.invoke(IPC.chatsDelete, id)
  },
  shell: {
    /** Runs an approved command. Resolves null if the user cancelled. */
    run: (req: {
      command: string
      shell: ShellKind
      tier: TierId
    }): Promise<ShellResult | null> => ipcRenderer.invoke(IPC.shellRun, req),
    /**
     * Whether this tier may run the command, and why it looks risky if it does.
     * Drives the card: a command the tier cannot run gets no Run button.
     */
    check: (req: { command: string; tier: TierId }): Promise<CommandVerdict> =>
      ipcRenderer.invoke(IPC.shellRisk, req)
  },
  search: {
    /** Runs an approved web search. */
    run: (query: string): Promise<{
      results: SearchResult[]
      provider: string
      error?: string
    }> => ipcRenderer.invoke(IPC.searchRun, query)
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
  },
  files: {
    /** Writes a file the user approved. The main process vets the path again. */
    write: (path: string, content: string): Promise<WriteResult> =>
      ipcRenderer.invoke(IPC.writeFile, { path, content }),
    /** Resolves a destination so the card can show where the file would land. */
    check: (path: string): Promise<WriteTarget> => ipcRenderer.invoke(IPC.writeCheck, path)
  },
  links: {
    /** Opens a page. The main process checks it again before anything happens. */
    open: (url: string): Promise<LinkResult> => ipcRenderer.invoke(IPC.linkOpen, url),
    /** Opens a search for a query, in whichever engine is configured. */
    search: (query: string): Promise<LinkResult> => ipcRenderer.invoke(IPC.linkSearch, query),
    /** Describes a link so the card can show where it goes, without opening it. */
    check: (url: string): Promise<LinkCheck> => ipcRenderer.invoke(IPC.linkCheck, url)
  },
  voice: {
    status: (): Promise<VoiceStatus> => ipcRenderer.invoke(IPC.voiceStatus),
    /** Loads the model. Slow the first time, so the panel says it is happening. */
    start: (): Promise<VoiceStatus> => ipcRenderer.invoke(IPC.voiceStart),
    /**
     * Transcribes a recorded clip.
     *
     * The audio is sent as a plain ArrayBuffer, which the structured clone
     * algorithm moves across without copying it into a string first - a few
     * seconds of Opus is small, but base64 would make it bigger and slower for
     * no reason.
     */
    transcribe: (audio: ArrayBuffer, extension: string, commands: string[]): Promise<Dictation> =>
      ipcRenderer.invoke(IPC.voiceTranscribe, { audio, extension, commands }),
    onStatus: (cb: (s: VoiceStatus) => void) => on<VoiceStatus>(IPC.voiceStatusChanged, cb)
  }
}

export type WumpyApi = typeof api

contextBridge.exposeInMainWorld('wumpy', api)
