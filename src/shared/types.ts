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
   * Sent by the app on the user's behalf, not typed by them.
   *
   * A screenshot coming back, or the result of a plan of clicks. It has to
   * go to the model - the model asked for it and cannot continue without it
   * - but it is not something the user said, and showing it as their own
   * message was the thing they objected to: "I notice that I auto-send
   * something to it... but it makes it look funky, so don't show things
   * like that."
   *
   * So it is sent and not shown. The MODEL is also told, in the text
   * itself, that it arrived automatically rather than from the person - a
   * model that thinks the user is narrating their own screenshots will
   * thank them for it.
   */
  automatic?: boolean
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
   * Images the user attached, pasted or dropped onto the panel.
   *
   * Carried on the message rather than held separately so that reopening a
   * saved chat shows what was actually asked. They are downscaled before
   * they get here - see shrinkImage - so a saved chat does not become a
   * photo album.
   */
  images?: Attachment[]
  /**
   * A question Wumpy itself is asking, with the options to choose from.
   * Used where the app knows a request is ambiguous and a model would only
   * guess — or deliberate for minutes without reaching an answer.
   */
  localAsk?: { question: string; options: string[]; kind: 'rename' }
}

/* -------------------------------------------------------- the one assistant */

/**
 * Wumpy used to be eight assistants: four tiers, each in a local and a hosted
 * form, chosen by hand. That made sense while the local models were the point
 * - a 3.8B model needs worked examples and a short-answer rule that only hold
 * a capable model back, and a 14B one needs a patience budget rather than a
 * truncation limit, so a single config could not serve both.
 *
 * It stopped making sense once the measurements came in. Codestral scored 8/8
 * on block, compile, on-task and legal path - the only model to take every
 * column - at 0.51s to first token and 511 billed tokens a call, which is
 * 25,000 questions a day against a free tier that reports no daily meter at
 * all. There is no question in this app that wants a worse answer, slower, and
 * no budget to ration between tiers.
 *
 * So there is one assistant now. The tier picker, the quick/dev split, the
 * local backend and the model warm-up are gone with it.
 */
export interface GenerationOptions {
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
 * - `all`: everything runs, including the destructive ones. No card to click
 *   and no native dialog, and `confirmRisky` does not override it. A risky
 *   command is still labelled and outlined in red as it runs - showing is not
 *   asking - but nothing stops it. The protection in this mode is the command
 *   the model chose, not a question afterwards.
 */
export type ApprovalMode = 'manual' | 'auto' | 'all'

/** One step of a desktop plan, after it ran. */
export interface DesktopStep {
  step: string
  ok: boolean
  detail: string
}

/** What came back from running a plan of clicks and keystrokes. */
export interface DesktopResult {
  ran: DesktopStep[]
  /** Set when nothing ran at all, with the reason. */
  refused: string | null
  /** Lines in the block that were not steps. */
  problems: string[]
  /** The screen afterwards, so the model can see what it did. */
  after: Attachment | null
}

/** What the main process decided about one proposed command. */
export interface CommandVerdict {
  /** Why it looks destructive, or null. */
  risk: string | null
  /** Whether Wumpy may run it at all. */
  allowed: boolean
  scope: 'none' | 'read' | 'full'
  /** True when it should run without waiting for a click. */
  auto: boolean
  /** True when it only reads. */
  readOnly: boolean
  /**
   * How bad, not merely whether.
   *
   * 'reversible' is an uninstall: undone by installing it again, so
   * accept-all runs it rather than interrupting. 'severe' is deleting
   * files, disabling Defender, writing into Startup or reading a private
   * key - no mode runs those unasked.
   */
  level: 'none' | 'reversible' | 'severe'
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

/** A chunk of output from a command that has not finished yet. */
export interface ShellProgress {
  /** Which run it belongs to, so a card only shows its own output. */
  runId: string
  /** Everything printed so far, already clipped to what is worth showing. */
  text: string
}

/**
 * An image attached to a message.
 *
 * Held as a data URL, which is what both the thumbnail and the API want, so
 * nothing has to be read back off disk or re-encoded on the way out. The
 * cost of that is the chat file: an image lives in the transcript, so it is
 * shrunk hard before it ever becomes one of these.
 */
export interface Attachment {
  /**
   * Which it is, because the two behave differently everywhere.
   *
   * An image is shrunk and costs a flat ~1,100 tokens. A video is passed
   * through whole and costs about 105 tokens a second, so a one-minute clip
   * is six thousand - the one number worth showing before it is sent.
   */
  kind: 'image' | 'video'
  /** `data:image/jpeg;base64,…` or `data:video/mp4;base64,…`. */
  dataUrl: string
  /** The file it came from, when it came from one. Pasted images have none. */
  name?: string
  width: number
  height: number
  /** Size of the encoded file, for the "too big" guard and the UI. */
  bytes: number
  /** How long a video runs, rounded. Zero when the header did not say. */
  seconds?: number
  /**
   * Where the bytes live once the chat has been saved.
   *
   * Set only on disk. A saved chat keeps the filename and drops the data
   * URL, because list() parses every chat file in full to read six header
   * fields off each one — free for a few kilobytes of text, not free for
   * four base64 screenshots, and emphatically not free for a video.
   * Reading one back puts the dataUrl straight back, so nothing above
   * ChatStore ever sees this.
   */
  file?: string
  /**
   * What is on screen and what it is called, when the shot is a screenshot.
   *
   * From the accessibility tree, not from the image. The model points at a
   * name instead of estimating a pixel, which is the difference between a
   * mistake it can correct and the same wrong click forever.
   */
  elements?: Array<{ name: string; role: string; x: number; y: number }>
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface Assistant {
  /** The hosted model to answer with. */
  model: string
  /** Ask a reasoning-capable model to reason. */
  thinking: boolean
  /**
   * What Wumpy may propose.
   *
   * Kept as a field rather than hard-wired to 'full' because turning it down
   * is the one honest way to make the app safe on a machine where you do not
   * want it proposing changes - /shell off writes 'none' here. The restriction
   * is enforced in the main process against an allowlist, not requested in the
   * prompt.
   */
  tools: 'none' | 'read' | 'full'
  options: GenerationOptions
  systemPrompt: string
}

/** Whether the hosted model can actually be reached, for the status bar. */
export interface AssistantStatus {
  model: string
  /** False when no key is saved for the provider this model belongs to. */
  ready: boolean
  /** Why not, when it is not. */
  why: string
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
}

export interface SavedChat extends ChatSummary {
  messages: ChatMessage[]
}

/* ---------------------------------------------------------------- settings */

export interface WumpySettings {
  /** The hosted model to answer with. One model, no tiers. */
  model: string
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
   * Reveal answers character by character instead of token by token.
   *
   * Off by default. It looks better, but it runs an animation frame loop and
   * re-parses markdown far more often, during generation, which is exactly
   * when the CPU is needed for tokens.
   */
  smoothText: boolean
  /** Hard ceiling on a single turn, in ms. */
  maxTurnMs: number
  launchAtLogin: boolean
  /** Allow Wumpy to propose shell commands. */
  shellEnabled: boolean
  /** How much runs without being asked. */
  approvalMode: ApprovalMode
  /** Keep the native dialog for destructive commands even in `all`. */
  confirmRisky: boolean
  /** Allow Wumpy to propose web searches. */
  searchEnabled: boolean
  /**
   * Brave Search API key. Without one, search covers encyclopedic questions
   * only, via DuckDuckGo's Instant Answer API and Wikipedia.
   */
  searchApiKey: string
  /** Working directory for commands. Empty means the user's home directory. */
  shellCwd: string
  /**
   * Try another model from the same provider when this one is rate limited.
   *
   * On by default, and always announced in the reply. It used to mean "fall
   * back to the local model", which mattered more: a silent downgrade to a
   * 3.8B model would have made the answer untrustworthy in the way that counts,
   * because you would not know which model you were reading. The announcement
   * stays for the same reason even though the step sideways is now smaller.
   */
  apiFallback: boolean
  /**
   * Dictation. Off until a transcriber is actually installed, because turning
   * it on without one would put a microphone button in the panel that only ever
   * reports an error.
   */
  voiceEnabled: boolean
  /**
   * Send the transcript through the model to punctuate it.
   *
   * The vocabulary table in shared/dictation.ts runs either way; this is only
   * the part that needs judgement.
   *
   * This used to be guaranteed local, and that guarantee is gone with Ollama.
   * Polishing now sends what you dictated to the hosted provider, like every
   * other turn - so it is off by default and the setting says what it does.
   */
  voicePolish: boolean
  /** Stop recording by itself once you stop talking. */
  voiceAutoStop: boolean
  /** Let the model propose opening a page in the real browser. */
  browserEnabled: boolean
  /**
   * Whether the model may ASK to look at the screen.
   *
   * Off means it is never offered and never mentioned in the instructions,
   * so the model does not propose something that cannot happen. On does not
   * mean it can look - the capture still needs a click every time, whatever
   * the approval mode.
   */
  screenEnabled: boolean
  /** Which engine `/open` and a proposed search use. */
  searchEngine: string
}

/* ---------------------------------------------------------------- messaging */

export interface ChatRequest {
  requestId: string
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'images'>>
  /**
   * Live facts the model has no other way to know. Without these it guesses
   * at things it could simply be told, like what the current chat is called.
   */
  context: {
    chatTitle: string | null
    messageCount: number
    /**
     * What Wumpy has already done in this chat, stated by the app.
     *
     * Not the model's recollection: the code that ran the command writes
     * these. Asked whether it had opened Spotify, the model denied it three
     * times - truthfully, as far as its own memory of its own intent went,
     * because the prompt had called that command "the installed-check". The
     * app has the receipt, so the app says.
     */
    actions: string[]
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
  assistantStatus: 'assistant:status',
  panelHide: 'panel:hide',
  panelPin: 'panel:pin',
  panelDock: 'panel:dock',
  panelShown: 'panel:shown',
  /**
   * The renderer reporting that it still does not hold the keyboard.
   *
   * Sent only when the page has given up trying: document.hasFocus() is the
   * only place the truth lives, and the main process cannot see it.
   * win.isFocused() is a proxy and can say true while Windows has not
   * actually handed the foreground over, which is why the first fix guarded
   * on it and did nothing.
   */
  panelRefocus: 'panel:refocus',
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
  /**
   * Output from a command that is still running.
   *
   * The result only arrives when the process exits, which for an installer
   * is minutes of a card saying nothing. The bytes are already there as the
   * child writes them; this is only the main process passing them on.
   */
  shellProgress: 'shell:progress',
  searchRun: 'search:run',
  voiceStatus: 'voice:status',
  voiceStatusChanged: 'voice:status-changed',
  voiceStart: 'voice:start',
  voiceTranscribe: 'voice:transcribe',
  voiceTidy: 'voice:tidy',
  linkOpen: 'link:open',
  linkCheck: 'link:check',
  linkSearch: 'link:search',
  writeFile: 'write:file',
  writeCheck: 'write:check',
  usageGet: 'usage:get',
  usageReset: 'usage:reset',
  contextGet: 'context:get',
  contextSet: 'context:set',
  keyStatus: 'key:status',
  keySet: 'key:set',
  keyAdd: 'key:add',
  keyClear: 'key:clear',
  /**
   * Take a photograph of the screen.
   *
   * Only ever in response to a click on a card. There is deliberately no
   * channel that captures without one, and no way for the model to reach
   * this except by proposing a block the user then presses.
   */
  screenCapture: 'screen:capture',
  /* Clicking and typing on the real desktop, aimed by the last screenshot. */
  doRun: 'do:run'
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
  /** The model currently answering, so the report names what it is counting. */
  model: string
  date: string
}

export interface KeyStatus {
  configured: ProviderName[]
  /** False when the OS cannot encrypt, in which case Wumpy stores nothing. */
  canStore: boolean
  /**
   * How many keys each provider has, because the limit is per project and
   * several keys is the whole point. A count is not a key and is safe to
   * send; the keys themselves still never cross this boundary.
   */
  counts: Partial<Record<ProviderName, number>>
}

/**
 * Mirrors ProviderId in @shared/cloud, kept here so types.ts stays leaf-level.
 *
 * check-cloud asserts the two are the same set, because nothing here would
 * fail to compile if they drifted - a provider missing from this copy would be
 * accepted by the key command and rejected by the IPC handler.
 */
export type ProviderName = 'google' | 'groq' | 'mistral' | 'nvidia'

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
