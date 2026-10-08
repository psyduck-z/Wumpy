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
  /** A notice the user wrote with /also while a turn was still running. */
  aside?: boolean
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

/**
 * Which half of the app is answering.
 *
 * Wumpy is two assistants sharing one window. Local runs on Ollama: free,
 * private, offline, and limited by this machine's memory bandwidth to about
 * 13 tokens a second. API runs on a hosted model: ten times faster and
 * markedly better at code, at the cost of a quota, a network, and sending the
 * conversation to someone else.
 *
 * Neither is a fallback for the other. They have different models, different
 * output budgets and different prompts - a 3.8B model needs worked examples
 * and short-answer rules that only hold a capable model back - so the choice
 * is explicit and visible rather than inferred.
 */
export type Backend = 'local' | 'api'

/** Rough expectation set for the user before they commit to a slow answer. */
export type SpeedHint = 'instant' | 'quick' | 'slow' | 'slowest'

export interface TierOptions {
  num_ctx: number
  num_predict: number
  temperature: number
  top_p?: number
}

export type ShellKind = 'powershell' | 'cmd' | 'bash'

/**
 * How much the model may do without being asked.
 *
 * - `manual`: every command waits for a click. The default.
 * - `auto`: commands that only read run themselves; anything that writes asks.
 * - `all`: everything runs. Commands matching a destructive pattern still raise
 *   a native dialog unless `confirmRisky` is turned off, because the model
 *   wrote them and a wrong path is not recoverable.
 */
export type ApprovalMode = 'manual' | 'auto' | 'all'

/** What the main process decided about one proposed command. */
export interface CommandVerdict {
  /** Why it looks destructive, or null. */
  risk: string | null
  /** Whether this tier may run it at all. */
  allowed: boolean
  scope: 'none' | 'read' | 'full'
  /** True when it should run without waiting for a click. */
  auto: boolean
  /** True when it only reads. */
  readOnly: boolean
}

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
  /**
   * Whether this only read something, as judged by the main process.
   *
   * Carried back so the panel can tell a silent success apart from a silent
   * answer: `Remove-Item` printing nothing is finished, while `Get-Command`
   * printing nothing means the tool is absent, which the model still has to
   * read.
   */
  readOnly: boolean
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
  /** Preferred local model; falls back through `alternates` when not installed. */
  model: string
  alternates: string[]
  /** The hosted model this tier uses on the API backend. */
  apiModel: string
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
  /**
   * Overrides for the API backend, where the constraints are different.
   *
   * num_predict is the one that matters. Locally it is a patience budget: at
   * 13 tok/s, 800 tokens is a minute of waiting. On a hosted model at 170
   * tok/s the same 800 tokens is five seconds, and the cap stops being a
   * kindness and starts being a truncation.
   */
  apiOptions?: Partial<TierOptions>
  systemPrompt: string
  /**
   * The system prompt for the API backend.
   *
   * Separate because the local one is shaped around a 3.8B model's failure
   * modes - told to stop talking, kept to one or two sentences, given worked
   * examples to imitate - and those are instructions to be less useful when
   * the model on the other end does not need them.
   */
  apiSystemPrompt?: string
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
  /** How much runs without being asked. */
  approvalMode: ApprovalMode
  /** Keep the native dialog for destructive commands even in `all`. */
  confirmRisky: boolean
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
  /**
   * Local (Ollama) or API (hosted). Local by default: Wumpy works with no
   * account, no network and no quota, and switching away from that should be
   * something the user did on purpose.
   */
  backend: Backend
  /**
   * Dictation. Off until a transcriber is actually installed, because turning
   * it on without one would put a microphone button in the panel that only ever
   * reports an error.
   */
  voiceEnabled: boolean
  /**
   * Send the transcript through the local model to punctuate it.
   *
   * The vocabulary table in shared/dictation.ts runs either way; this is only
   * the part that needs judgement, and it costs a second or so.
   */
  voicePolish: boolean
  /** Stop recording by itself once you stop talking. */
  voiceAutoStop: boolean
  /** Let the model propose opening a page in the real browser. */
  browserEnabled: boolean
  /** Which engine `/open` and a proposed search use. */
  searchEngine: string
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
  settingsChanged: 'settings:changed',
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
  historyGet: 'history:get',
  historyAdd: 'history:add',
  chatsList: 'chats:list',
  chatsSave: 'chats:save',
  chatsLoad: 'chats:load',
  chatsDelete: 'chats:delete',
  chatsRename: 'chats:rename',
  chatCompact: 'chat:compact',
  chatTitle: 'chat:title',
  shellRun: 'shell:run',
  shellRisk: 'shell:risk',
  searchRun: 'search:run',
  voiceStatus: 'voice:status',
  voiceStatusChanged: 'voice:status-changed',
  voiceStart: 'voice:start',
  voiceTranscribe: 'voice:transcribe',
  linkOpen: 'link:open',
  linkCheck: 'link:check',
  linkSearch: 'link:search',
  writeFile: 'write:file',
  writeCheck: 'write:check',
  usageGet: 'usage:get',
  usageReset: 'usage:reset',
  keyStatus: 'key:status',
  keySet: 'key:set',
  keyClear: 'key:clear'
} as const

/* --------------------------------------------------------------------- keys */

/**
 * What the renderer may know about API keys: which providers have one, and
 * nothing else.
 *
 * No key, no prefix, no masked form ever crosses this boundary. The panel is a
 * web page and whatever reaches it reaches anything that manages to run script
 * in it; the only code that handles the plaintext is the fetch that sends it.
 */
/** What `/usage` shows. */
export interface UsageReport {
  lines: import('./usage').UsageLine[]
  backend: Backend
  date: string
}

export interface KeyStatus {
  configured: ProviderName[]
  /** False when the OS cannot encrypt, in which case Wumpy stores nothing. */
  canStore: boolean
}

/** Mirrors ProviderId in @shared/cloud, kept here so types.ts stays leaf-level. */
export type ProviderName = 'google' | 'groq'

/* --------------------------------------------------------------------- voice */

/** Whether a local transcriber is available, and if not, what is missing. */
export type VoiceStatus =
  | { kind: 'unknown' }
  | { kind: 'absent'; detail: string }
  | { kind: 'starting' }
  | { kind: 'ready'; model: string; loadMs: number }
  | { kind: 'failed'; detail: string }

/** One clip, as the transcriber returned it. */
export interface Transcript {
  text: string
  ms: number
  audioSeconds: number
  /** 0..1, from the model's own per-token log probabilities. */
  confidence: number
}

/** A finished dictation, ready for the composer. */
export interface Dictation {
  /** What to put in the box. */
  text: string
  /**
   * What was heard before any correction.
   *
   * Kept and shown, because a transcript the user cannot check against is a
   * transcript they have to trust blindly.
   */
  heard: string
  /** True when the polish pass ran and its result passed the guard. */
  polished: boolean
  /** True when it ran and was rejected, which is worth saying out loud. */
  polishRefused: boolean
  confidence: number
  /** Transcription time only, excluding polish. */
  ms: number
}

/* -------------------------------------------------------------------- links */

/** What came of trying to open a link. */
export interface LinkResult {
  opened: boolean
  /** The normalised URL, for the note in the transcript. */
  url: string
  /** The host as a browser resolves it, punycoded. */
  host: string
  error?: string
}

/* --------------------------------------------------------------- file writes */

/** What came of writing a file the user approved. */
export interface WriteResult {
  written: boolean
  /** The absolute path, resolved. */
  path: string
  bytes: number
  /** True when something was already there. */
  overwrote: boolean
  error?: string
}

/** What the card needs to describe a destination before anything is written. */
export interface WriteTarget {
  ok: boolean
  path: string
  why: string | null
  exists: boolean
}
