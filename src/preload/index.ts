import { contextBridge, ipcRenderer } from 'electron'
import type { ReflectReview } from '@shared/reflect'
import { IPC } from '@shared/types'
import type { LinkCheck } from '@shared/links'
import type { ProbeResult } from '@shared/probe'
import type { Footprint } from '@shared/footprint'
import type { Entry } from '@shared/journal'
import type { RankView, SyncInfo } from '@shared/types'
import type { FirewallVerdict } from '@shared/firewall'
import type { EnrolAnswer, VoiceprintState, WhoseAnswer } from '@shared/types'
import type { Listening } from '@shared/meeting'
import type { Skill, SkillSummary } from '@shared/skills'
import type { LookResult } from '../main/look'
import type {
  AgentDelivery,
  AgentView,
  MonitorView,
  Attachment,
  DesktopResult,
  ChatDelta,
  ChatDone,
  ChatError,
  ChatMessage,
  ChatRequest,
  ChatSummary,
  CommandVerdict,
  Dock,
  HotkeyState,
  KeyStatus,
  ProviderName,
  UsageReport,
  AssistantStatus,
  UpdateState,
  SavedChat,
  Dictation,
  LinkResult,
  SearchResult,
  WriteResult,
  WriteTarget,
  ShellKind,
  ShellResult,
  ShellProgress,
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
  /** 'win32', 'linux' or 'darwin': the panel is an overlay on Windows, an app window on Linux. */
  platform: process.platform as string,
  settings: {
    get: (): Promise<WumpySettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<WumpySettings>): Promise<WumpySettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
    onChange: (cb: (s: WumpySettings) => void) => on<WumpySettings>(IPC.settingsChanged, cb)
  },
  assistant: {
    status: (): Promise<AssistantStatus> => ipcRenderer.invoke(IPC.assistantStatus),
    onStatus: (cb: (s: AssistantStatus) => void) => on(IPC.assistantStatus, cb)
  },
  chat: {
    send: (req: ChatRequest): Promise<void> => ipcRenderer.invoke(IPC.chatSend, req),
    abort: (requestId: string): void => ipcRenderer.send(IPC.chatAbort, requestId),
    onDelta: (cb: (d: ChatDelta) => void) => on(IPC.chatDelta, cb),
    onDone: (cb: (d: ChatDone) => void) => on(IPC.chatDone, cb),
    onError: (cb: (d: ChatError) => void) => on(IPC.chatError, cb),
    /** Summarise older turns; resolves to the summary text, or null on failure. */
    compact: (req: {
      messages: Array<{ role: string; content: string }>
    }): Promise<string | null> => ipcRenderer.invoke(IPC.chatCompact, req),
    /** Names a conversation from its opening exchange. */
    title: (req: { messages: Array<{ role: string; content: string }> }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.chatTitle, req)
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
      /** Tags the live output below, so a card only shows its own. */
      runId?: string
    }): Promise<ShellResult | null> => ipcRenderer.invoke(IPC.shellRun, req),
    /**
     * Output from a command that is still going.
     *
     * One way, main to page, and only ever the text the command itself
     * printed - the same text the finished result carries, arriving while
     * it is still interesting rather than afterwards.
     */
    onProgress: (cb: (p: ShellProgress) => void) => on(IPC.shellProgress, cb),
    /**
     * Whether Wumpy may run the command, and why it looks risky if it does.
     * Drives the card: a command it may not run gets no Run button.
     */
    check: (req: { command: string }): Promise<CommandVerdict> =>
      ipcRenderer.invoke(IPC.shellRisk, req)
  },
  screen: {
    /**
     * Capture the screen, returning the image. Resolves only after the user
     * has clicked the card that asked for it; nothing here can be reached
     * from a model reply on its own.
     */
    capture: (): Promise<Attachment> => ipcRenderer.invoke(IPC.screenCapture)
  },
  desktop: {
    /**
     * Runs an approved plan of clicks and keystrokes, and returns what each
     * step did plus a fresh screenshot of the result.
     *
     * The block's text crosses as text and is parsed on the other side. The
     * renderer parses it too, for the card, but that copy is only ever shown
     * - main never trusts it, because a renderer is reachable from a model's
     * output and a main process is not.
     */
    run: (body: string): Promise<DesktopResult> => ipcRenderer.invoke(IPC.doRun, { body })
  },
  search: {
    /** Runs an approved web search. */
    run: (
      query: string
    ): Promise<{
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
    /**
     * Back in the tray. document.hidden cannot answer this: the window turns
     * off backgroundThrottling, so Chromium calls the page visible for as
     * long as it exists.
     */
    onTucked: (cb: () => void) => on(IPC.panelTucked, cb),
    /** Where things stand for a page that has only just loaded. */
    visible: (): Promise<boolean> => ipcRenderer.invoke(IPC.panelVisible),
    /** "I am visible and the keyboard is still somewhere else." */
    requestFocus: (): void => ipcRenderer.send(IPC.panelRefocus),
    onDock: (cb: (d: Dock) => void) => on(IPC.panelDock, cb)
  },
  /**
   * One way, text only. The page's own clipboard API needs document focus and
   * this window often does not have it, so every Copy button was a coin toss.
   * Nothing here reads the clipboard back.
   */
  clipboard: {
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.clipboardWrite, text)
  },
  hotkey: {
    get: (): Promise<HotkeyState> => ipcRenderer.invoke(IPC.hotkeyState),
    onChange: (cb: (s: HotkeyState) => void) => on(IPC.hotkeyState, cb)
  },
  usage: {
    /** Today's totals, per model. Counts only — no prompt text is kept. */
    get: (): Promise<UsageReport> => ipcRenderer.invoke(IPC.usageGet),
    reset: (): Promise<UsageReport> => ipcRenderer.invoke(IPC.usageReset),
    /**
     * What Wumpy itself costs: memory and CPU per process.
     *
     * Takes half a second, because it is two readings rather than one -
     * see the handler. Nothing calls it but `/usage`.
     */
    footprint: (): Promise<Footprint> => ipcRenderer.invoke(IPC.usageFootprint)
  },
  /**
   * What Wumpy has done, with the time. Read-only but for `/log clear`,
   * and nothing in here is a secret: see @shared/journal for what is
   * deliberately never recorded.
   */
  journal: {
    get: (): Promise<Entry[]> => ipcRenderer.invoke(IPC.journalGet),
    /** Resolves to how many lines there were to forget. */
    clear: (): Promise<number> => ipcRenderer.invoke(IPC.journalClear),
    /** Something happened. The page decides whether it cares. */
    onChange: (cb: () => void) => on(IPC.journalChanged, cb)
  },
  /**
   * The background re-ranking: one key measuring the models while the
   * other answers questions. See @shared/ranking for when it may run.
   */
  rank: {
    state: (): Promise<RankView> => ipcRenderer.invoke(IPC.rankState),
    set: (req: { on?: boolean; now?: boolean }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.rankSet, req)
  },
  look: {
    /**
     * Read one picture off the disk, after the user has pressed the card.
     *
     * The path crosses as the model wrote it and comes back resolved, so
     * what the user approved and what was opened are the same string.
     */
    file: (path: string): Promise<LookResult> => ipcRenderer.invoke(IPC.lookFile, { path })
  },
  models: {
    /**
     * Which models answer right now, asked one real request at a time.
     *
     * No argument, on purpose: the catalogue decides what is asked, so the
     * page cannot name a host or an id of its own and have it dialled.
     */
    probe: (runs?: number): Promise<ProbeResult[]> =>
      ipcRenderer.invoke(IPC.modelsProbe, { runs })
  },
  /**
   * The notes Wumpy carries between chats. Plain text the user owns - no
   * secret passes through here, so unlike keys it reads back freely.
   */
  context: {
    get: (): Promise<{ text: string; path: string; truncated: boolean }> =>
      ipcRenderer.invoke(IPC.contextGet),
    set: (
      text: string,
      append = false
    ): Promise<{ ok: boolean; why: string; text: string; truncated: boolean }> =>
      ipcRenderer.invoke(IPC.contextSet, { text, append })
  },
  /** Skills: files the user owns, made or changed by a <skill> tag (see @shared/skills). */
  skills: {
    save: (skill: {
      name: string
      description?: string
      triggers?: string[]
      body: string
      argumentHint?: string
      aliases?: string[]
    }): Promise<{ ok: boolean; why: string; name: string; did: 'saved' | 'replaced' | 'removed' }> =>
      ipcRenderer.invoke(IPC.skillSave, skill),
    /** Every skill, for the command palette and /skills. */
    list: (): Promise<SkillSummary[]> => ipcRenderer.invoke(IPC.skillList),
    /** One skill, whole, to run as a command. */
    get: (name: string): Promise<Skill | null> => ipcRenderer.invoke(IPC.skillGet, name),
    /** Opens the skills folder; resolves to its path. */
    folder: (open: boolean): Promise<string> => ipcRenderer.invoke(IPC.skillFolder, open),
    /** Skills on every device: over Wi-Fi (main/lansync.ts) and GitHub (main/skillsync.ts). */
    sync: (req: {
      action: 'now' | 'on' | 'off' | 'key' | 'status' | 'pair' | 'unpair'
      token?: string
      arg?: string
    }): Promise<{ ok: boolean; on: boolean; message: string; changed?: boolean; account?: string }> => ipcRenderer.invoke(IPC.skillSync, req),
    /** Paired devices and GitHub, for the Settings tab. */
    syncInfo: (): Promise<SyncInfo> => ipcRenderer.invoke(IPC.syncInfo),
    /** The firewall for Wi-Fi sync: checked again, or opened (with the system's password pop-up). */
    firewall: (req: { allow?: boolean }): Promise<FirewallVerdict> => ipcRenderer.invoke(IPC.firewall, req),
    /** Something about Wi-Fi sync they did not just ask for: "Paired with desk." */
    onNote: (cb: (text: string) => void) => on<string>(IPC.syncNote, cb),
    /** Another device's skills arrived. */
    onChanged: (cb: () => void) => on<null>(IPC.skillsChanged, () => cb())
  },
  keys: {
    /**
     * Which providers have a key. Deliberately no getter for a key itself -
     * there is no handler on the other side either. This boundary is one-way.
     */
    status: (): Promise<KeyStatus> => ipcRenderer.invoke(IPC.keyStatus),
    /** Replaces every key for a provider; accepts several at once. */
    set: (
      provider: ProviderName,
      key: string
    ): Promise<{ ok: boolean; why: string; label?: string; total?: number }> =>
      ipcRenderer.invoke(IPC.keySet, { provider, key }),
    /** Adds one or more without disturbing the keys already stored. */
    add: (
      provider: ProviderName,
      key: string
    ): Promise<{ ok: boolean; why: string; label?: string; total?: number }> =>
      ipcRenderer.invoke(IPC.keyAdd, { provider, key }),
    clear: (provider: ProviderName): Promise<{ ok: boolean; why: string }> =>
      ipcRenderer.invoke(IPC.keyClear, { provider }),
    /**
     * Which keys still work. Answered with a models listing per key, so it
     * costs nothing from the day's allowance, and it comes back as POSITIONS
     * - never a key, not even masked.
     */
    check: (
      provider: ProviderName
    ): Promise<{
      ok: boolean
      why: string
      label?: string
      keys: Array<{ number: number; ok: boolean; status: number; why: string }>
    }> => ipcRenderer.invoke(IPC.keyCheck, { provider }),
    /** Removes keys by position - the only handle this side ever has. */
    drop: (
      provider: ProviderName,
      numbers: number[]
    ): Promise<{ ok: boolean; why: string; removed?: number[]; total?: number; label?: string }> =>
      ipcRenderer.invoke(IPC.keyDrop, { provider, numbers })
  },
  files: {
    /** Writes a file the user approved. The main process vets the path again. */
    write: (path: string, content: string): Promise<WriteResult> =>
      ipcRenderer.invoke(IPC.writeFile, { path, content }),
    /** Resolves a destination so the card can show where the file would land. */
    check: (path: string, content?: string): Promise<WriteTarget> => ipcRenderer.invoke(IPC.writeCheck, path, content),
    /** A page played, or a program compiled, once it is written. */
    tested: (path: string, content: string): Promise<Pick<WriteResult, 'page' | 'code'>> =>
      ipcRenderer.invoke(IPC.writtenCheck, { path, content })
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
    /**
     * The cleanup half on its own, for text already transcribed in pieces
     * while the user was speaking. Skips Whisper, keeps everything after it.
     */
    tidy: (text: string, commands?: string[]): Promise<Dictation> =>
      ipcRenderer.invoke(IPC.voiceTidy, { text, commands }),
    /**
     * One line about a listening session, into wumpy.log.
     *
     * `send`, not `invoke`: a session writing its heartbeat must never be
     * able to wait on the main process, and nothing here wants an answer.
     * Main flattens and caps whatever arrives - see IPC.listenLog.
     */
    log: (line: string): void => ipcRenderer.send(IPC.listenLog, line),
    onStatus: (cb: (s: VoiceStatus) => void) => on<VoiceStatus>(IPC.voiceStatusChanged, cb),
    /** Text to speech: a WAV to play, or null to use the system voice. */
    speak: (text: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke(IPC.voiceSpeak, { text }),
    /** The same, streamed: pieces arrive through onAudio, then this resolves with their count. */
    speakStream: (
      id: string,
      text: string
    ): Promise<{ pieces: number; rate: number; firstMs: number; ms: number; streamed: boolean } | null> =>
      ipcRenderer.invoke(IPC.voiceSpeakStream, { id, text }),
    onAudio: (cb: (piece: { id: string; pcm: ArrayBuffer }) => void) =>
      on<{ id: string; pcm: ArrayBuffer }>(IPC.voiceAudio, cb),
    /** Whether the earbuds' own mic is running yet (Linux; 'none' elsewhere). See main/btmic.ts. */
    micState: (): Promise<{ mic: 'none' | 'absent' | 'switching' | 'running'; earbudsOut: boolean | null }> =>
      ipcRenderer.invoke(IPC.voiceMicState),
    /** Whose voice a conversation's clip was: the WAV sent to the transcriber, how long the talking was, the mic. */
    whose: (audio: ArrayBuffer, talkedMs: number, device: string, answer = false): Promise<WhoseAnswer> =>
      ipcRenderer.invoke(IPC.voiceWhose, { audio, talkedMs, device, answer }),
    /** The clip `whose` gave this token for was words: learn the voice from it. */
    learn: (token: string): Promise<boolean> => ipcRenderer.invoke(IPC.voiceprintLearn, token),
    print: (): Promise<VoiceprintState> => ipcRenderer.invoke(IPC.voiceprintState),
    setPrint: (change: { on?: boolean; forget?: boolean }): Promise<VoiceprintState> =>
      ipcRenderer.invoke(IPC.voiceprintSet, change),
    /** Calibrating: start, one sentence read at a time, then finish (or cancel). */
    enrolStart: (): Promise<{ ready: boolean; needed: number }> => ipcRenderer.invoke(IPC.voiceprintEnrolStart),
    enrolClip: (audio: ArrayBuffer, device: string): Promise<EnrolAnswer> =>
      ipcRenderer.invoke(IPC.voiceprintEnrolClip, { audio, device }),
    enrolFinish: (): Promise<VoiceprintState> => ipcRenderer.invoke(IPC.voiceprintEnrolFinish),
    enrolCancel: (): Promise<void> => ipcRenderer.invoke(IPC.voiceprintEnrolCancel),
    /** The screen, while a meeting is being watched: a note of it if it changed since the last look. */
    meetingLook: (fresh: boolean): Promise<{ changed: boolean; text?: string; why?: string; by?: string }> =>
      ipcRenderer.invoke(IPC.meetingLook, fresh),
    /** The live meeting notes brought up to date: the notes so far, and what is new since `since` ms. */
    meetingNotes: (req: { session: Listening; previous: string; since: number }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.meetingNotes, req),
    /** A spoken turn was asked for (wumpy --voice, the tray). */
    onTurn: (cb: () => void) => on<void>(IPC.voiceTurn, cb)
  },
  /** Background agents and their monitors. See @shared/agents and main/agents.ts. */
  agents: {
    /** Starts what a finished answer's wumpy-agent and wumpy-monitor blocks ask for. */
    start: (
      chatId: string,
      messageId: string,
      text: string
    ): Promise<{ started?: AgentView[]; monitors?: MonitorView[]; refused?: string } | null> =>
      ipcRenderer.invoke(IPC.agentsStart, { chatId, messageId, text }),
    list: (): Promise<{ agents: AgentView[]; monitors: MonitorView[] }> => ipcRenderer.invoke(IPC.agentsList),
    stop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.agentsStop, id),
    /** Reports waiting for a chat, and the panel saying it handed one over. */
    pending: (chatId: string): Promise<AgentDelivery[]> => ipcRenderer.invoke(IPC.agentsPending, chatId),
    delivered: (id: string): Promise<void> => ipcRenderer.invoke(IPC.agentsDelivered, id),
    /** The file an agent handed back, as it wrote it - for a write block's `from:`. */
    file: (id: string): Promise<string | null> => ipcRenderer.invoke(IPC.agentsFile, id),
    /** A game the chat wrote itself, handed to an agent instead: false when none can take it. */
    takeOver: (chatId: string, messageId: string, request: string, path: string): Promise<{ started: boolean }> =>
      ipcRenderer.invoke(IPC.agentsTakeOver, { chatId, messageId, request, path }),
    /** Its file was saved there: the card takes the file's name. */
    saved: (id: string, path: string): Promise<void> => ipcRenderer.invoke(IPC.agentsSaved, id, path),
    onChanged: (cb: (list: { agents: AgentView[]; monitors: MonitorView[] }) => void) =>
      on<{ agents: AgentView[]; monitors: MonitorView[] }>(IPC.agentsChanged, cb),
    onReady: (cb: (delivery: AgentDelivery) => void) => on<AgentDelivery>(IPC.agentsReady, cb)
  },
  app: {
    /** Restart Wumpy and open this chat again; null starts on an empty one. */
    restart: (chatId: string | null, why: string): void =>
      ipcRenderer.send(IPC.appRestart, { chatId, why }),
    /** Main wants a restart (the tray, wumpy --restart): save, then restart. */
    onRestartAsked: (cb: (why: string) => void) => on<string>(IPC.appRestartAsked, cb),
    /** The chat the last restart left, once; null on an ordinary start. */
    launchChat: (): Promise<string | null> => ipcRenderer.invoke(IPC.appLaunchChat)
  },
  update: {
    /** Wumpy's own update: 'off' on Linux and dev runs (main/updater.ts). */
    state: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateState),
    onState: (cb: (s: UpdateState) => void) => on<UpdateState>(IPC.updateState, cb),
    check: (): void => ipcRenderer.send(IPC.updateCheck),
    /** `/update`: update now if there is anything to update to (main/updater.ts updateNow). */
    now: (force: boolean): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.updateNow, force)
  },
  music: {
    /** Pause what is playing while Wumpy listens or talks (main/music.ts). */
    hold: (): Promise<void> => ipcRenderer.invoke(IPC.musicHold),
    /** And resume it, once the last hold lets go. */
    release: (): Promise<void> => ipcRenderer.invoke(IPC.musicRelease)
  },
  reflect: {
    /** One mentor review of the task so far; null when none could be had. */
    review: (transcript: string): Promise<ReflectReview | null> =>
      ipcRenderer.invoke(IPC.reflectReview, { transcript })
  }
}

export type WumpyApi = typeof api

contextBridge.exposeInMainWorld('wumpy', api)
