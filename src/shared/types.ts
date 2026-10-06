/** Shared contracts between the main process, preload bridge and renderer. */

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** Reasoning text emitted by thinking models, kept separate from the answer. */
  thinking?: string
  createdAt: number
  model?: string
  tier?: TierId
  error?: string
  /**
   * Written by the app rather than the model (command output, confirmations).
   * Shown in the transcript but never sent back as conversation history.
   */
  local?: boolean
}

/* ------------------------------------------------------------------ tiers */

export type TierId = 'flash' | 'fast' | 'thinker' | 'deep'

/**
 * Which half of the app a tier belongs to. `quick` is the light, get-an-answer
 * mode; `dev` is the dark mode for work worth waiting on.
 */
export type Mode = 'quick' | 'dev'

/** Rough expectation set for the user before they commit to a slow answer. */
export type SpeedHint = 'instant' | 'quick' | 'slow' | 'slowest'

export interface TierOptions {
  num_ctx: number
  num_predict: number
  temperature: number
  top_p?: number
}

export interface Tier {
  id: TierId
  label: string
  blurb: string
  mode: Mode
  speed: SpeedHint
  /** Preferred model; falls back through `alternates` when not installed. */
  model: string
  alternates: string[]
  /** Ask a reasoning-capable model to reason. Never sends `think: false`. */
  thinking: boolean
  options: TierOptions
  systemPrompt: string
}

export interface TierStatus {
  id: TierId
  /** The model actually resolved for this tier, or null when none is installed. */
  resolvedModel: string | null
  installed: boolean
  /** True once the model is resident in Ollama, so answers start instantly. */
  warm: boolean
}

/* ------------------------------------------------------------- panel shape */

/**
 * Where the panel sits. `left`/`right` are the full-height bar; the four
 * corners are the compact quarter-screen card.
 */
export type Dock = 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const TALL_DOCKS: Dock[] = ['left', 'right']

export function isTall(dock: Dock): boolean {
  return dock === 'left' || dock === 'right'
}

/* ----------------------------------------------------------------- storage */

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  tier: TierId
}

export interface SavedChat extends ChatSummary {
  messages: ChatMessage[]
}

/* ---------------------------------------------------------------- settings */

export interface WumpySettings {
  ollamaHost: string
  /** Which tier set and theme the panel opens in. */
  mode: Mode
  /** Selected tier within the current mode. */
  tier: TierId
  dock: Dock
  /** Width of the full-height bar, in px. */
  tallWidth: number
  /** Size of the compact corner card, in px. */
  compactWidth: number
  compactHeight: number
  hideOnBlur: boolean
  /** Show a reasoning model's scratchpad rather than hiding it. */
  showReasoning: boolean
  /**
   * Extra accelerators, tried in order. Empty by default: Win+C is claimed by
   * the low-level keyboard hook, since Windows reserves it from RegisterHotKey.
   */
  hotkeys: string[]
  /**
   * How long Ollama keeps a model resident. This is the single biggest lever on
   * perceived speed: a cold load costs ~3.5s, a warm one ~8ms.
   */
  keepAlive: string
  /** Preload tier models at startup so the first question is instant. */
  warmOnStart: boolean
  launchAtLogin: boolean
  /** Per-tier model overrides, keyed by tier id. */
  tierModels: Partial<Record<TierId, string>>
}

/* ------------------------------------------------------------------- ollama */

export interface OllamaModel {
  name: string
  size: number
  family: string
  parameterSize: string
}

export interface OllamaStatus {
  reachable: boolean
  version?: string
  error?: string
}

/* ---------------------------------------------------------------- messaging */

export interface ChatRequest {
  requestId: string
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>
  tier: TierId
}

export interface ChatDelta {
  requestId: string
  content?: string
  thinking?: string
}

export interface ChatDone {
  requestId: string
  tokensPerSecond?: number
  totalDurationMs?: number
  /** Milliseconds spent loading the model; near zero means it was warm. */
  loadMs?: number
}

export interface ChatError {
  requestId: string
  message: string
}

export interface HotkeyState {
  active: string | null
  failed: string[]
  /** Key claimed by the low-level keyboard hook rather than RegisterHotKey. */
  intercepted: string | null
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatDelta: 'chat:delta',
  chatDone: 'chat:done',
  chatError: 'chat:error',
  ollamaStatus: 'ollama:status',
  ollamaModels: 'ollama:models',
  tiersStatus: 'tiers:status',
  tiersWarm: 'tiers:warm',
  panelHide: 'panel:hide',
  panelPin: 'panel:pin',
  panelDock: 'panel:dock',
  panelShown: 'panel:shown',
  hotkeyState: 'hotkey:state',
  chatsList: 'chats:list',
  chatsSave: 'chats:save',
  chatsLoad: 'chats:load',
  chatsDelete: 'chats:delete',
  chatsRename: 'chats:rename'
} as const
