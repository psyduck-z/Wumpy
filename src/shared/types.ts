/** Shared contracts between the main process, preload bridge and renderer. */

import type { AttachKind } from './attach'
import type { Fresh } from './cloud'

export type { AttachKind }

export type Role = 'user' | 'assistant' | 'system'

/**
 * A question Wumpy asks itself, with no model involved.
 *
 *   rename      which of two readings of a quoted title was meant
 *   model       which model, from `/model` said aloud or a name that fits several
 *   resume      which saved chat to open
 *   deletechat  which saved chat to delete (a confirm follows)
 *   confirm     yes or no before something that cannot be undone; the first
 *               option is yes
 *
 * `values` are what each option stands for (a model id, a chat id), in the
 * same order, for the kinds where the label is not the thing itself. `say`
 * is how it is read into the earbuds, and `aliases` what else each option
 * answers to out loud ("fastest").
 */
export interface LocalAsk {
  question: string
  options: string[]
  kind: 'rename' | 'model' | 'resume' | 'deletechat' | 'confirm'
  values?: string[]
  say?: string
  /** How many of the options `say` reads out, first to last. */
  spoken?: number
  aliases?: string[][]
  /**
   * What might be asked for out loud and cannot be picked, and why: a
   * model NVIDIA has withdrawn is "not answering right now", not "sorry,
   * which one?" as if it had been misheard.
   */
  unavailable?: Array<{ names: string[]; why: string }>
  /**
   * The options in each ranking's order, best first, by label: "the
   * fastest one" after "Nemotron" is the fastest Nemotron, which only the
   * ranking can say.
   */
  ranked?: Partial<Record<'balanced' | 'smarts' | 'speed', string[]>>
  /**
   * Each option as it is read out, when that is not the model-name way
   * (sayModel): a chat called "Taxes (2)" keeps its "(2)".
   */
  said?: string[]
}

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
   * Said through the earbuds in a voice turn, not typed at the screen. Shown
   * as a small mark on the message, and the reason the answer was short.
   */
  spoken?: boolean
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
  localAsk?: LocalAsk
  /**
   * A line saying what Wumpy just did — ran this, searched for that.
   *
   * Local, so the model never reads it: it is the person's receipt, not
   * context. The thing it is a receipt FOR has already gone to the model as
   * a hand-back, which is sent and not shown. See shared/notify.ts.
   */
  notification?: boolean
  /**
   * How many times this chip has happened, counting the first.
   *
   * Set only on a repeat, so an ordinary message carries nothing. A model
   * that re-proposes a command it has already run is this app's commonest
   * loop, and six identical lines in the transcript is the spam the count
   * exists to replace.
   */
  repeat?: number
  /**
   * This answer stopped rather than finished — the output cap, or a block.
   *
   * Shown under the message, because the one thing the transcript did was
   * make a truncated reply look complete: the dots go, the runtime is
   * printed, and half a sentence sits there as though it were all there was
   * to say.
   */
  cutOff?: string
  /**
   * What this note is a statement about, when it is one.
   *
   * Set on the notes that say what is true NOW rather than what just
   * happened - which mode commands run in, which model answers, whether the
   * panel is pinned. A second statement about the same thing replaces the
   * first instead of being added under it: cycling the approval mode three
   * times used to leave nine paragraphs in the transcript, six of them
   * describing modes that were no longer on. Reported with a screenshot of
   * exactly that: "since they fall under the same command or effect, just
   * replace, not add".
   *
   * See restatementOf in shared/notify.ts for when a statement is a
   * restatement and when it is a new thing worth saying.
   */
  topic?: NoteTopic
}

/**
 * The things a note can be a statement about.
 *
 * A closed list rather than a free string, because the whole value of the
 * field is that two notes agree they are about the same thing - and a typo
 * in a topic is a note that silently stops replacing the one before it.
 *
 * Finer than the command that produced it: `/think` and `/lean` are both the
 * 'setting' action and they are two different facts about the world.
 */
export type NoteTopic =
  /**
   * The `/log` report, which is a statement of state like any other - it
   * says what has happened AS OF NOW. Typing it twice put two copies of a
   * twenty-line block in the transcript, the first of them already out of
   * date: "make this stricter - no repeating annoying logs or
   * notifications. here, I typed /log twice".
   */
  | 'journal'
  /**
   * The other reports, for the same reason. Every one of them is a snapshot
   * of how things are right now - what is set, what has been spent, which
   * models are quickest, which keys answer - so a second copy under the
   * first is a page of transcript saying what the page above it said, with
   * the older one now wrong in whatever changed.
   */
  | 'settings'
  | 'usage'
  | 'rank'
  | 'probe'
  | 'help'
  | 'shortcuts'
  | 'approve'
  | 'pin'
  | 'model'
  | 'engine'
  | 'reasoning'
  | 'thinking'
  | 'lean'
  | 'voice'
  | 'voice-music'
  | 'startup'
  | 'voice-polish'
  | 'voice-autostop'
  | 'reflect'

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
  /**
   * No num_predict, and nothing in its place.
   *
   * It was the output cap - 4,000 tokens, chosen by hand - and the answer in
   * the panel stopped mid-sentence when a model wanted more than that.
   * "don't add a response limit": the request now asks for whatever the
   * window has left, which is a fact about the context rather than a
   * preference about length. See `maxTokensFor`.
   */
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
  /**
   * False when a LOOK at the screen sent no picture, only names.
   *
   * A screenshot is about 1,100 tokens and only a model with vision can read
   * one. Every model can read the control list, which is what the acting
   * steps work from anyway - press, focus, fill, read and reveal are lookups
   * by name, and `runPlan` only requires a frame for the two steps measured
   * in pixels. So a look can come back as names alone: free on the models
   * that cannot see at all, and 1,100 tokens a step cheaper on the ones that
   * can but do not need to.
   *
   * Absent means a picture, because every attachment before this was one.
   */
  picture?: boolean
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
  /**
   * What a vision model saw, when the answering model cannot see.
   *
   * Present only on a look with `picture: false`, which is the whole point:
   * no bytes were sent to the model answering, so this is the only thing it
   * has of how the screen LOOKS. Second-hand, and labelled as such in the
   * hand-back and on the card - the model that acts did not see this.
   */
  described?: string
  /** Which model described it, so the transcript says whose account it is. */
  describedBy?: string
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
  /**
   * Let the model reason before answering.
   *
   * The plumbing has been here since the first NVIDIA model - `thinking`
   * reaches `reasoningEffortFor`, `thinkingKwargsFor` and `maxTokensFor`,
   * each of which does something different with it - and it was wired to
   * a constant `false`. Fast was the only setting there was.
   *
   * Off by default, which is what it has been doing all along. Reasoning
   * is spent out of max_tokens BEFORE the first visible word, so it costs
   * latency on every turn including the ones that are just chat, and the
   * app is summoned over the top of whatever someone was already doing.
   */
  thinking: boolean
  /** Allow Wumpy to propose web searches. */
  searchEnabled: boolean
  /**
   * Brave Search API key. Without one, search covers encyclopedic questions
   * only, via DuckDuckGo's Instant Answer API and Wikipedia.
   */
  searchApiKey: string
  /**
   * What `/model check` last measured, by model id. See cloud.Fresh.
   *
   * Kept in settings rather than recomputed, because the check costs real
   * requests - eighteen of them, and several minutes - and the answer it
   * buys should outlive the reply it was printed in. The picker reads it
   * on the next launch exactly as it does on the next keystroke.
   */
  latencies: Record<string, Fresh>
  /**
   * Each key's measured limit, by "provider:index" (see @shared/limits):
   * what the pacer keeps to on that key instead of the provider's figure.
   */
  keyLimits?: Record<string, import('./limits').KeyLimit>
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
  /**
   * Hear and speak with NVIDIA's hosted speech models (Parakeet, Magpie) when
   * an NVIDIA key exists. Audio then goes to NVIDIA like a chat turn does;
   * off, dictation uses local Whisper and voice mode the system's own voice.
   */
  voiceCloud: boolean
  /** Magpie's voice for spoken answers, e.g. Magpie-Multilingual.EN-US.Aria. */
  speakVoice: string
  /**
   * How fast answers are spoken: 1 as made, 1.15 fifteen percent quicker,
   * at the same pitch (see renderer/stretch.ts). "Can you make him speak a
   * little bit faster? ...I'm able to listen faster."
   */
  speakRate: number
  /**
   * Pause whatever music is playing while Wumpy listens or talks - a voice
   * turn, or holding the spacebar - and resume it after. See main/music.ts.
   */
  pauseMusic: boolean
  /**
   * Self-reflection (/reflect): once the model has finished a task, a mentor
   * reviews it - on the other key where there are two - and the work goes
   * back for another pass until the mentor accepts it. See shared/reflect.ts.
   */
  reflect: boolean
  /** Reviews per task before it stops asking, accepted or not. */
  reflectRounds: number
  /** The mentor's model; empty means the same model as the worker. */
  reflectModel: string
  /**
   * Send the short form of the instructions.
   *
   * The preamble is the largest single cost of every turn, and most of what
   * made it large is remediation for one weak local model: worked wrong/right
   * pairs, the same rule written three ways, and accounts of past failures.
   * @shared/lean states the same contract once each and keeps the thirteen
   * rules that were measured to carry the benchmark - 4,553 tokens against
   * 7,059, which takes a plain turn from 7,841 to 5,335.
   *
   * Off by default, because what is verified about it is structural: every
   * load-bearing rule survives and every block is still named, both checked
   * across all thirty-two combinations. Whether the SHORTER WORDING holds up
   * on this model has not been measured, and the full text is what is known
   * to work. It is a setting rather than a silent default for that reason.
   */
  leanPrompt: boolean
  /**
   * Whether the one-time move off Google has already happened.
   *
   * Google left the picker, but `providerFor` still routes `gemini-*` so a
   * name typed by hand keeps working. That leaves a settings file holding
   * gemini-3.1-flash-lite pointing at a model nothing offers any more, and
   * it would answer normally, so the change would look like it had not
   * happened.
   *
   * Hence a migration, and hence a flag rather than a check on every read:
   * run every time, it would also bounce a user who deliberately typed
   * `/model gemini-3.5-flash` back off it at the next restart, which is the
   * opposite of leaving the door open.
   */
  movedOffGoogle: boolean
  /**
   * The voice and speed a settings file was last moved to (VOICE_CHOICE):
   * "can you set the voice to a male?", "I'll go with neutral Ray", "switch
   * back to Jason neutral... speak a little faster". Every settings file
   * names the default it started on, so a new default alone would reach
   * nobody. Remembered rather than checked on every read, so a voice or
   * speed chosen later by hand stays.
   */
  voiceChoice: string
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
  /**
   * Which question the model list is sorted on: balanced, smarts or speed.
   *
   * Asked for as tabs - "one of them is on smartness, one is on speed, and
   * one of them is balanced, so balance is basically the recommended one" -
   * and it is a setting rather than a per-visit choice because picking a
   * model is rare and the way somebody reads the list is not. A person who
   * wants the fastest thing on the list wants it next week too.
   *
   * A string, like `searchEngine`, and validated where it is read: a
   * settings file is a file, and the one thing a type cannot stop is
   * somebody editing it. See @shared/order.isOrdering.
   */
  modelOrder: string
  /**
   * Re-measure the models in the background, about once an hour.
   *
   * Asked for: one key does the ranking, the other answers questions, and
   * the ranking stops the moment the user needs the account. On unless
   * turned off, and it does nothing at all with fewer than two keys - see
   * @shared/ranking, which holds every rule about when it may go.
   */
  autoRank: boolean
}

/* ---------------------------------------------------------------- messaging */

export interface ChatRequest {
  requestId: string
  /**
   * `sentAt` on the messages the person wrote, when they sent them: stamped
   * onto the text on the way out (see @shared/sent).
   */
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'images'> & { sentAt?: number }>
  /**
   * Live facts the model has no other way to know. Without these it guesses
   * at things it could simply be told, like what the current chat is called.
   */
  context: {
    chatTitle: string | null
    /** Which chat, so the model can be told about its background agents. */
    chatId?: string | null
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
    /**
     * The person is on their earbuds in a voice turn, not at the screen: the
     * answer will be read aloud. See renderer/src/handsfree.ts.
     */
    handsFree?: boolean
  }
}

/** One background agent, as the panel shows it. See @shared/agents. */
export interface AgentView {
  id: string
  /** The block that asked for it: `${messageId}:${index}`. */
  key: string
  chatId: string
  /** Its number in its chat: "agent 2". */
  number: number
  title: string
  status: 'queued' | 'working' | 'reviewing' | 'done' | 'failed' | 'stopped'
  /** What it is doing, or did last: "ran df -h", "waiting for its key". */
  doing: string
  steps: Array<{ kind: 'run' | 'search' | 'page' | 'code'; what: string; ok: boolean }>
  startedAt: number
  endedAt?: number
  model: string
  /** "accepted on review", "revised once, then accepted", or empty. */
  review: string
  /** The report, once there is one. */
  report?: string
  /**
   * The file it works on, by name - "pacman.html" - from its brief or from
   * where its file was saved. Its card is named after it, so the agents
   * that build and then change one file show as one thing, not 1 and 2.
   */
  thing?: string
}

/** A monitor a chat set on its agents. */
export interface MonitorView {
  id: string
  key: string
  chatId: string
  note: string
  when: 'all' | 'each'
  agents: number[]
  fired: boolean
}

/** A report on its way to a chat, as one automatic message. */
export interface AgentDelivery {
  id: string
  chatId: string
  text: string
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
  /** 'length' or 'content_filter' when the answer stopped short. */
  cutOff?: string
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
  /** Text to speech: the main process answers with a WAV, or null. */
  voiceSpeak: 'voice:speak',
  /** Text to speech as it is made: pieces arrive on voiceAudio, then this resolves. */
  voiceSpeakStream: 'voice:speak-stream',
  voiceMicState: 'voice:mic-state',
  /** One piece of streamed speech: { id, pcm } with 16-bit mono PCM. */
  voiceAudio: 'voice:audio',
  /** Main tells the panel to run a spoken turn (wumpy --voice). */
  voiceTurn: 'voice:turn',
  reflectReview: 'reflect:review',
  /** Background agents (see @shared/agents): start the ones an answer asks for, and its monitors; stop one. */
  agentsStart: 'agents:start',
  agentsStop: 'agents:stop',
  /** Every agent there is, for the cards. */
  agentsList: 'agents:list',
  /** Main tells the panel the list changed. */
  agentsChanged: 'agents:changed',
  /** Reports waiting to be handed to a chat, and the panel saying one was. */
  agentsPending: 'agents:pending',
  agentsDelivered: 'agents:delivered',
  agentsFile: 'agents:file',
  /** The panel saved an agent's file: where, so its card can be named after it. */
  agentsSaved: 'agents:saved',
  /** Main tells the panel a report is ready for a chat. */
  agentsReady: 'agents:ready',
  musicHold: 'music:hold',
  musicRelease: 'music:release',
  /** The panel restarts Wumpy, naming the chat to come back to (/restart). */
  appRestart: 'app:restart',
  /** Main asks the panel to restart (tray, wumpy --restart), so the chat is saved first. */
  appRestartAsked: 'app:restart-asked',
  /** The chat a restart left, to open again: once, and null on an ordinary start. */
  appLaunchChat: 'app:launch-chat',
  /**
   * A line from a listening session, straight into wumpy.log.
   *
   * Because a long listen is the one thing in this app that runs for an hour
   * with nobody watching, and until now it wrote NOTHING ANYWHERE. The only
   * `[listen]` lines in the codebase were on failure paths, so a session
   * that started cleanly and transcribed nothing left a log identical to a
   * session that was never started - which is exactly the question that
   * could not be answered when one was reported as having heard silence.
   *
   * Narrow on purpose, and one-way. The renderer's console only reaches the
   * file through the dev-only console-message forwarder in panel.ts, at
   * warning level or above, so the honest instrumentation of a working
   * feature would have had to be logged as warnings and would vanish in a
   * packaged build. This is a channel for facts.
   */
  listenLog: 'listen:log',
  linkOpen: 'link:open',
  linkCheck: 'link:check',
  linkSearch: 'link:search',
  writeFile: 'write:file',
  writtenCheck: 'write:checked',
  writeCheck: 'write:check',
  usageGet: 'usage:get',
  /**
   * What Wumpy costs the machine: memory and CPU, per process.
   *
   * Sampled on demand and nowhere else. Reading it takes two readings half
   * a second apart, which is a measurement rather than a poll - nothing in
   * the app asks for it unless the user does.
   */
  usageFootprint: 'usage:footprint',
  /**
   * The background re-ranking: what it is doing, and whether it may.
   *
   * Read by `/rank` and by the settings sheet. The decision itself is pure
   * and lives in @shared/ranking; this hands over the three things it
   * needs that only the main process knows.
   */
  rankState: 'rank:state',
  /** Turn it on or off, or start a sweep now. */
  rankSet: 'rank:set',
  usageReset: 'usage:reset',
  /**
   * What Wumpy has done, with the time it happened. Read by `/log`.
   *
   * Kept by the main process, because the things worth looking up happen
   * where no page is watching - the hourly ranking, the tray menu, a
   * provider's refusal. See @shared/journal.
   */
  journalGet: 'journal:get',
  /**
   * Forget it.
   *
   * Reachable only from `/log clear`, typed out. `/log` is offered as a
   * button in an answer and this deliberately is not: the list exists so
   * that what the app did is not a matter of opinion, and a one-click way
   * to erase it would be the first thing worth planting in a web page.
   */
  journalClear: 'journal:clear',
  /**
   * A line was added, finished or cleared.
   *
   * One way, main to page, and with no payload: the panel fetches the list
   * again only if it has a `/log` on screen to keep up to date, so a
   * machine nobody is watching sends a few bytes an hour and nothing else.
   */
  journalChanged: 'journal:changed',
  /**
   * Ask every model in the catalogue whether it answers.
   *
   * Costs one real request per model, so there is deliberately no caller but
   * `/model check` - nothing polls this, and nothing runs it at startup.
   * Reports ids and verdicts; no key, masked or otherwise, is in the reply.
   */
  modelsProbe: 'models:probe',
  contextGet: 'context:get',
  contextSet: 'context:set',
  /** Makes, replaces or removes a skill (see @shared/skills). */
  skillSave: 'skill:save',
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
  doRun: 'do:run',
  /**
   * Open a picture that is already on the disk, so the model can see it.
   *
   * Like the screenshot, only on a click: the path the model chose is shown
   * on a card first, because this is the one read that SENDS what it reads.
   */
  lookFile: 'look:file'
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
/** What `/rank` and the settings sheet are told about the background ranking. */
export interface RankView {
  on: boolean
  keys: number
  sinceProbeMs: number
  sinceSweepMs: number
  left: number
  lastSweepMs: number
  traffic: {
    busy: boolean
    sinceTurnMs: number
    lastMinute: number
    perMinute: number
    sinceLimitedMs: number
  }
}

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
  /**
   * The keyless providers whose daemon answered on this machine lately -
   * Ollama, when it is installed and running. A keyless provider is ready
   * when it is here, not merely because it needs no key.
   */
  local?: ProviderName[]
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
export type ProviderName = 'google' | 'groq' | 'mistral' | 'nvidia' | 'ollama'

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
  /**
   * A web page, loaded out of sight once written (main/pagecheck.ts): what
   * its console said went wrong. Absent when it is not a page, or no
   * browser could load it.
   */
  page?: { errors: string[]; context?: string }
  /**
   * A program - Python, C or C++, JavaScript, a shell script - checked
   * without running it (main/codecheck.ts). Absent when nothing could check
   * it here.
   */
  code?: { lang: import('./codecheck').CodeLang; errors: string[]; missing: string[]; how: string; context?: string }
}

/** What the card needs to describe a destination before anything is written. */
export interface WriteTarget {
  ok: boolean
  path: string
  why: string | null
  exists: boolean
  /** What is there already is exactly what would be written: asked only with the content. */
  same?: boolean
}
