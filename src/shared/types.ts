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
  /**
   * An app-generated fact the model must act on — a capability change, for
   * instance. Sent as a system message, shown in the transcript as a chip.
   */
  notice?: boolean
  /**
   * A compaction summary standing in for earlier turns. Sent to the model as a
   * system message so it reads as context rather than as something it said.
   */
  summary?: boolean
  /** Number of messages this summary replaced, for the transcript chip. */
  summarised?: number
  /** The option picked for a `wumpy-ask` block in this message. */
  answered?: string
  /**
   * A question Wumpy itself is asking, with the options to choose from.
   * Used where the app knows a request is ambiguous and a model would only
   * guess — or deliberate for minutes without reaching an answer.
   */
  localAsk?: { question: string; options: string[]; kind: 'rename' }
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

export type ShellKind = 'powershell' | 'cmd' | 'bash'

export interface ShellResult {
  command: string
  shell: ShellKind
  cwd: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
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
  /**
   * What the tier may propose.
   *
   * 'read' lets Quick-mode tiers look things up — versions, files, whether
   * something is installed — while anything that changes the machine still
   * needs a Developer tier. The restriction is enforced in the main process
   * against an allowlist, not merely requested in the prompt.
   */
  tools: 'none' | 'read' | 'full'
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
  /**
   * The user renamed this chat, so automatic titling must leave it alone.
   */
  titleLocked?: boolean
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
  /**
   * Collapse when focus moves elsewhere. Off by default: the panel is meant to
   * stay visible over whatever you are working in until you dismiss it.
   */
  hideOnBlur: boolean
  /** Persist every chat as it happens, with no explicit save. */
  autoSave: boolean
  /** Summarise older turns automatically when the context fills up. */
  autoCompact: boolean
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
  /**
   * Reveal answers character by character instead of token by token.
   *
   * Off by default. It looks better, but it runs an animation frame loop and
   * re-parses markdown far more often, during generation, which is exactly
   * when the CPU is needed for tokens.
   */
  smoothText: boolean
  /**
   * Hard ceiling on a single turn, in ms. A reasoning model on CPU will
   * otherwise happily spend ten minutes on scratchpad.
   */
  maxTurnMs: number
  launchAtLogin: boolean
  /** Allow tiers that support it to propose shell commands. */
  shellEnabled: boolean
  /** Allow tiers that support it to propose web searches. */
  searchEnabled: boolean
  /**
   * Brave Search API key. Without one, search covers encyclopedic questions
   * only, via DuckDuckGo's Instant Answer API and Wikipedia.
   */
  searchApiKey: string
  /** Working directory for commands. Empty means the user's home directory. */
  shellCwd: string
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
  /**
   * Live facts the model has no other way to know. Without these it guesses
   * at things it could simply be told, like what the current chat is called.
   */
  context: {
    chatTitle: string | null
    messageCount: number
  }
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
  /**
   * Counted by Ollama rather than estimated. `promptTokens` is everything the
   * model read this turn, so prompt + completion is what the next turn starts
   * from — which is exactly what the context meter needs.
   */
  promptTokens?: number
  completionTokens?: number
}

/** What the context meter displays. */
export interface ContextUsage {
  /** Tokens the next request will start from. */
  used: number
  /** The active tier's context window. */
  limit: number
  /** True when `used` is a character-based estimate, not a counted value. */
  estimated: boolean
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
  chatsRename: 'chats:rename',
  chatCompact: 'chat:compact',
  chatTitle: 'chat:title',
  shellRun: 'shell:run',
  shellRisk: 'shell:risk',
  searchRun: 'search:run'
} as const
