/** Shared contracts between the main process, preload bridge and renderer. */

import type { AttachKind } from './attach'

export type { AttachKind }

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
  /**
   * Set when the plan was abandoned part-way because somebody else was
   * using the machine, or the window it was aiming at went away.
   */
  stopped: string | null
  /**
   * The window the plan worked in when it was not the one in front - which
   * is the normal case, because the panel holds the keyboard while the user
   * is talking to it. Null when there was nothing to say.
   */
  acting?: string | null
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
   * Which it is, because they behave differently everywhere.
   *
   * An image is shrunk and costs a flat ~1,100 tokens. A video is passed
   * through whole and costs about 105 tokens a second, so a one-minute clip
   * is six thousand - the one number worth showing before it is sent. A text
   * file costs its own length over four and goes up as characters rather than
   * as bytes. An `opaque` file goes up as a sentence saying what it is: see
   * @shared/attach for why a .docx is attached and not sent.
   */
  kind: AttachKind
  /**
   * `data:image/jpeg;base64,…`, `data:video/mp4;base64,…`, and so on.
   *
   * Empty for `text` and `opaque`: one carries its characters instead and the
   * other carries nothing at all. Nothing should read this without checking
   * the kind first - `sendsBytes(kind)` is the question being asked.
   */
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
   * The characters of a text file, already cut to the per-file cap.
   *
   * Held here rather than pasted into the message so the transcript keeps
   * showing what the user typed, with the file as a chip beside it. The wire
   * folds the two together at the last moment - see `foldAttachments`.
   */
  text?: string
  /** How long the file was, which is not `text.length` when it was cut. */
  chars?: number
  /** True when only the first part of the file is in `text`. */
  truncated?: boolean
  /** The media type, for the data URL and for naming the thing in the UI. */
  mime?: string
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
  /**
   * Which window those names came from.
   *
   * Added because they once came from the wrong one and nothing said so. The
   * panel is normally the window in front when a screenshot is taken - the
   * user has just typed into it - and the list was read from whatever had
   * the foreground, so the model was handed sixty controls out of Wumpy's own
   * transcript and told they were what was on screen. It then pressed one of
   * them: `PRESS FAILED` on an element named `Press "Inbox - zechariah"`,
   * which is the text of Wumpy's own card. Naming the window makes that
   * kind of mistake visible in one line instead of ten turns.
   */
  window?: string
  /**
   * How many usable controls that window has in total.
   *
   * The list is capped - sixty names is already most of a screenshot's worth
   * of tokens - and Gmail reports 673 named elements. Saying only the sixty
   * invites the conclusion that nothing else exists, when in fact PRESS,
   * FOCUS, FILL, REVEAL and READ all search the whole tree: a name that is
   * not on the list can still be found.
   */
  elementTotal?: number
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
  /**
   * The instructions, which are re-sent in full on every turn.
   *
   * Shown separately because they are most of the number and none of the
   * conversation: thirteen thousand tokens of preamble against a 32k budget
   * means a chat that looks nearly empty is already 40% full, and compacting
   * cannot touch it. Without this the meter read as a mystery.
   */
  instructions?: number
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
   * The panel has gone back into the tray.
   *
   * There is no way for the page to work this out for itself. The window
   * disables backgroundThrottling - deliberately, so the focus retry and the
   * open animation survive a hidden window - and Chromium then keeps
   * reporting document.visibilityState as 'visible' for the life of the
   * page. Measured on a window that had never been shown at all: 'visible',
   * hasFocus false. Anything that waits for "nobody is looking" has to be
   * told, which is what this is.
   */
  panelTucked: 'panel:tucked',
  /** Is the panel on screen right now? Asked once, by a page just loaded. */
  panelVisible: 'panel:visible',
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
  /**
   * Copying text, through the main process rather than the page.
   *
   * navigator.clipboard.writeText REQUIRES the document to have focus, and
   * this window frequently does not - that is the whole autofocus saga, and
   * document.hasFocus() has been logged as false while the caret sat in the
   * composer. So every Copy button was a coin toss, and the one bound to
   * Ctrl+Shift+C announced "Copied the last answer." either way:
   *
   *   ERROR [renderer] Uncaught (in promise) NotAllowedError: Failed to
   *   execute 'writeText' on 'Clipboard': Write permission denied.
   *
   * Electron's own clipboard has no such requirement. Text only, one way:
   * nothing here ever READS the clipboard on the renderer's behalf.
   */
  clipboardWrite: 'clipboard:write',
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
   * Are these keys still good?
   *
   * Answered with a models listing per key, which authenticates without
   * spending any of the day's allowance. The reply names POSITIONS - key 1,
   * key 2 - and never a key or a masked form of one, like everything else
   * that crosses this boundary.
   */
  keyCheck: 'key:check',
  /**
   * Remove keys by position, so three dead ones can go without re-pasting
   * the seventeen that work. Positions are all the renderer has - a key
   * never crosses this boundary in either direction.
   */
  keyDrop: 'key:drop',
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
  /**
   * The key pool behind the current model: how many can still answer, what
   * they have spent and when the rest come back. Null for a local model, or
   * before any key exists.
   *
   * Positions and counts only. A key is never named here, or anywhere else
   * the renderer can see.
   */
  pool: import('./pool').PoolView | null
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
