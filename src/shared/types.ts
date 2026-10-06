/** Shared contracts between the main process, preload bridge and renderer. */

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** Reasoning text emitted by thinking models such as qwen3, kept separate from the answer. */
  thinking?: string
  createdAt: number
  model?: string
  error?: string
}

export interface WumpySettings {
  /** Base URL of the Ollama server. */
  ollamaHost: string
  /** Model used for the chat panel. */
  chatModel: string
  systemPrompt: string
  /** Accelerators tried in order; the first one the OS grants wins. */
  hotkeys: string[]
  /** Collapse the panel as soon as focus moves elsewhere. */
  hideOnBlur: boolean
  /** Let thinking-capable models reason before answering (slower, usually smarter). */
  thinking: boolean
  panelWidth: number
  launchAtLogin: boolean
}

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

export interface ChatRequest {
  requestId: string
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>
  model?: string
}

export interface ChatDelta {
  requestId: string
  content?: string
  thinking?: string
}

export interface ChatDone {
  requestId: string
  /** Tokens per second for the generated response, when Ollama reports timings. */
  tokensPerSecond?: number
  totalDurationMs?: number
  aborted?: boolean
}

export interface ChatError {
  requestId: string
  message: string
}

export interface HotkeyState {
  /** The accelerator RegisterHotKey granted, or null when every candidate was refused. */
  active: string | null
  failed: string[]
  /**
   * Key claimed by the low-level keyboard hook instead of RegisterHotKey.
   * This is how Win+C is taken, since the shell refuses to hand it over.
   */
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
  panelHide: 'panel:hide',
  panelPin: 'panel:pin',
  panelShown: 'panel:shown',
  hotkeyState: 'hotkey:state'
} as const
