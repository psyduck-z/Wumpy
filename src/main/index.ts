import { app, dialog, ipcMain, nativeImage, Tray } from 'electron'
import { homedir } from 'node:os'
import { IPC } from '@shared/types'
import type {
  ChatMessage,
  CommandVerdict,
  ShellKind,
  ShellResult,
  ChatRequest,
  ChatSummary,
  Dock,
  HotkeyState,
  Tier,
  TierId,
  TierStatus,
  WumpySettings
} from '@shared/types'
import {
  TIERS,
  TIER_ORDER,
  SHELL_PROMPT,
  READ_SHELL_PROMPT,
  NO_SHELL_PROMPT,
  APP_PROMPT,
  ASK_PROMPT,
  SEARCH_PROMPT,
  OPEN_PROMPT,
  shellExamples,
  NUM_CTX
} from '@shared/tiers'
import { SettingsStore } from './store'
import { ChatStore } from './chats'
import { InputHistory } from './history'
import { OllamaClient } from './ollama'
import { Panel } from './panel'
import { createTray, resourcePath } from './tray'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { LowLevelHook } from './lowlevelhook'
import { runCommand, assessRisk, isReadOnly } from './shell'
import { PriorityManager } from './priority'
import { webSearch } from './search'
import { cleanTitle } from './titles'
import { Speech } from './speech'
import { openLink, openSearch } from './browser'
import { checkLink, isSearchEngine } from '@shared/links'
import { POLISH_PROMPT, polishAcceptable, tidyTranscript } from '@shared/dictation'

// Only one Wumpy may own the tray icon and the global hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setAppUserModelId('dev.psyduckz.wumpy')
// Registering any handler here overrides Electron's quit-on-last-window
// behaviour, which is what keeps Wumpy alive in the tray with no window open.
app.on('window-all-closed', () => {})

let settings: SettingsStore
let chats: ChatStore
let inputHistory: InputHistory
let ollama: OllamaClient
let panel: Panel
let tray: (Tray & { refresh(): void }) | null = null
let hotkeyState: HotkeyState = { active: null, failed: [], intercepted: null }
let lowLevelHook: LowLevelHook | null = null
let priority: PriorityManager
let speech: Speech

/** Models installed in Ollama, refreshed whenever we look. */
let installedModels: string[] = []

/* ------------------------------------------------------------------- tiers */

/**
 * Resolves a tier to a model that is actually installed, preferring the tier's
 * first choice and then its alternates. Returns null when none are present, so
 * the UI can say "not installed" instead of failing at send time.
 */
function resolveTierModel(id: TierId): string | null {
  const override = settings.get('tierModels')[id]
  if (override && installedModels.includes(override)) return override

  const tier = TIERS[id]
  const candidates = [tier.model, ...tier.alternates]
  return candidates.find((m) => installedModels.includes(m)) ?? null
}

function tierStatuses(): TierStatus[] {
  return TIER_ORDER.map((id) => {
    const resolvedModel = resolveTierModel(id)
    return {
      id,
      resolvedModel,
      installed: resolvedModel !== null,
      warm: resolvedModel ? ollama.isWarm(resolvedModel) : false
    }
  })
}

async function refreshModels(): Promise<void> {
  installedModels = (await ollama.models()).map((m) => m.name)
  // Reconcile with what Ollama already holds, so restarting Wumpy does not
  // report models cold when they are in fact still resident.
  ollama.markWarm(await ollama.resident())
  panel.send(IPC.tiersStatus, tierStatuses())
  tray?.refresh()
}

/**
 * Preloads a tier's model so the next question skips the load entirely.
 * Measured: cold first-word 4.7s, warm 0.19s.
 */
/**
 * The live facts block, built in exactly one place.
 *
 * Deliberately no clock time and no message count. Both changed on every turn
 * and bought nothing, while making this block differ each time.
 */
function factsFor(tierLabel: string, chatTitle: string | null): string {
  const now = new Date()
  return [
    'Facts about right now. If the user asks about any of these, just state the answer.',
    `- Today is ${now.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })}.`,
    `- The current tier is ${tierLabel}.`,
    `- This chat is titled ${chatTitle ? `"${chatTitle}"` : 'untitled so far'}.`,
    `- The user is on Windows. Commands run from ${settings.get('shellCwd') || homedir()}.`
  ].join('\n')
}

/** The chat title the panel last sent, so priming can reproduce the real shape. */
let lastChatTitle: string | null = null

/**
 * The system prompt for a tier, built in exactly one place.
 *
 * It was built twice - once to prime the cache at startup, once per turn - and
 * the two copies had already drifted: only one filtered out the empty string
 * left behind when web search is off. With search off they differed by a blank
 * line, which is enough for llama.cpp to find no common prefix and re-process
 * the whole preamble on every single turn. Nothing would look wrong; it would
 * just be slow for a reason nobody could see.
 */
function systemPromptFor(tier: Tier, scope: 'none' | 'read' | 'full'): string {
  return [
    tier.systemPrompt,
    APP_PROMPT,
    scope === 'full' ? SHELL_PROMPT : scope === 'read' ? READ_SHELL_PROMPT : NO_SHELL_PROMPT,
    scope !== 'none' && settings.get('searchEnabled') ? SEARCH_PROMPT : '',
    scope !== 'none' && settings.get('browserEnabled') ? OPEN_PROMPT : '',
    ASK_PROMPT
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * What the KV cache was last primed with.
 *
 * Keyed on the preamble rather than the model, because two tiers can share a
 * model and send different rules: Fast and Thinker are both phi4-mini, one
 * allowed to read and one allowed to act. Skipping the prime because the model
 * was already resident would leave the cache holding the other tier's prompt,
 * and the first question after a mode switch would pay full prefill for a
 * preamble nothing had primed.
 */
let primedWith: string | null = null

async function warmTier(id: TierId): Promise<void> {
  const model = resolveTierModel(id)
  if (!model) return

  // Prime with exactly the shape a real turn has, so the cache it leaves
  // behind is the one the user's first message will hit.
  //
  // "Exactly" turned out to matter far more than expected. Priming with the
  // system prompt and the examples, but without the live facts block that sits
  // behind them, left the first question paying 7.3-8.6s of prefill. Priming
  // with the facts block in place as well took that to 0.85-0.97s — the same
  // 780 tokens, measured twice from an unloaded model. For reference, no prime
  // at all is 30.6-36.2s. A prefix that is nearly right is worth much less than
  // one that is right.
  const tier = TIERS[id]
  const scope = settings.get('shellEnabled') ? tier.tools : 'none'
  const systemPrompt = systemPromptFor(tier, scope)
  const facts = factsFor(tier.label, lastChatTitle)

  const key = `${model}|${scope}|${systemPrompt.length}|${facts}|${tier.options.num_ctx}`
  if (primedWith === key && ollama.isWarm(model)) return
  primedWith = key

  await ollama.warm(model, settings.get('keepAlive'), {
    systemPrompt,
    facts,
    examples: scope === 'none' ? [] : shellExamples(scope),
    // Must match what the turn itself will ask for, or the primed cache is
    // discarded and the first question pays full prefill.
    options: tier.options
  })
  panel.send(IPC.tiersStatus, tierStatuses())
}

/* ----------------------------------------------------------------- hotkeys */

function applyHotkeys(): void {
  const intercepted = hotkeyState.intercepted
  hotkeyState = registerHotkeys(settings.get('hotkeys'), () => panel.toggle())
  // The low-level hook is owned separately; preserve what it already claimed.
  hotkeyState.intercepted = intercepted

  if (hotkeyState.active) {
    console.log(`[wumpy] accelerator active: ${hotkeyState.active}`)
  } else if (hotkeyState.failed.length > 0) {
    console.warn('[wumpy] no accelerator could be registered:', hotkeyState.failed.join(', '))
  }
  // An empty candidate list is the default and not worth a warning: Win+C comes
  // from the low-level hook, so extra accelerators are opt-in.
  tray?.refresh()
  panel.send(IPC.hotkeyState, hotkeyState)
}

/**
 * Claims Win+C through the helper process. RegisterHotKey cannot take it
 * because the shell holds it for Copilot, so we intercept it a layer lower.
 */
async function startLowLevelHook(): Promise<void> {
  lowLevelHook = new LowLevelHook('C', () => panel.toggle())
  const ok = await lowLevelHook.start()
  hotkeyState.intercepted = ok ? 'Super+C' : null
  if (!ok) {
    lowLevelHook = null
    console.warn('[wumpy] Win+C interception unavailable; use the tray icon')
  }
  tray?.refresh()
  panel.send(IPC.hotkeyState, hotkeyState)
}

/* --------------------------------------------------------------------- IPC */

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settings.all())

  // Whoever changed them - the panel, the tray menu - every window hears about
  // it, so what the status bar shows is what this process will actually do.
  settings.onChange((next) => panel.send(IPC.settingsChanged, next))

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WumpySettings>) => {
    const next = settings.patch(patch)
    if (patch.ollamaHost) ollama.setHost(next.ollamaHost)
    if (patch.hotkeys) applyHotkeys()
    if (patch.tallWidth || patch.compactWidth || patch.compactHeight) panel.applyGeometry()
    if (patch.launchAtLogin !== undefined) syncLaunchAtLogin(patch.launchAtLogin)
    if (patch.tier) void warmTier(patch.tier)
    tray?.refresh()
    return next
  })

  ipcMain.handle(IPC.ollamaStatus, () => ollama.status())
  ipcMain.handle(IPC.ollamaModels, () => ollama.models())

  ipcMain.handle(IPC.tiersStatus, async () => {
    await refreshModels()
    return tierStatuses()
  })
  ipcMain.handle(IPC.tiersWarm, async (_e, id: TierId) => {
    await warmTier(id)
    return tierStatuses()
  })

  ipcMain.handle(IPC.chatSend, async (_e, req: ChatRequest) => {
    const tier = TIERS[req.tier] ?? TIERS.fast
    const model = resolveTierModel(req.tier)

    if (!model) {
      panel.send(IPC.chatError, {
        requestId: req.requestId,
        message:
          `No model installed for ${tier.label}. Install one with ` +
          `\`ollama pull ${tier.model}\`, then reopen Wumpy.`
      })
      return
    }

    const scope = settings.get('shellEnabled') ? tier.tools : 'none'
    // The model is told what it can do in this tier, both ways round: with the
    // shell rules when it can act, and with an explicit "you cannot, say so"
    // when it cannot. Without the second half it invents having checked.
    // The system prompt must stay byte-identical between turns.
    //
    // llama.cpp reuses the KV cache for the longest common prefix of a request.
    // Live facts (the clock, the chat title) change every turn, so putting them
    // here invalidated the cache for the whole prompt *and* the conversation
    // behind it. Measured on llama3.2:3b with a 262-token prompt: 6-8s of
    // prefill per turn with volatile text first, 1.2-1.6s with it last, and
    // 165ms when the prefix is untouched. The facts now go in just ahead of the
    // latest question, so only they and that question are reprocessed.
    const systemPrompt = systemPromptFor(tier, scope)

    // Stand aside for the duration of the turn: tokens matter more than UI.
    priority.yieldToModel()
    await ollama.chat(req.requestId, model, withContext(req, tier.label, scope), {
      thinking: tier.thinking,
      options: tier.options,
      keepAlive: settings.get('keepAlive'),
      maxTurnMs: settings.get('maxTurnMs'),
      systemPrompt
    }, {
      onDelta: (delta) => panel.send(IPC.chatDelta, { requestId: req.requestId, ...delta }),
      onDone: (stats) => {
        priority.restore()
        panel.send(IPC.chatDone, { requestId: req.requestId, ...stats })
      },
      onError: (message) => {
        priority.restore()
        panel.send(IPC.chatError, { requestId: req.requestId, message })
      }
    })
  })

  /**
   * Summarises older turns so a long conversation keeps fitting in the model's
   * context window. Returns the summary text; the renderer decides what to
   * replace with it.
   */
  ipcMain.handle(
    IPC.chatCompact,
    async (_e, req: { tier: TierId; messages: Array<{ role: string; content: string }> }) => {
      // Summarising is a simple job, so always use the quickest installed model
      // rather than the active tier. Compacting on a 14B model would take
      // minutes, and the user is waiting to send their actual message.
      const model = resolveTierModel('flash') ?? resolveTierModel(req.tier)
      if (!model || req.messages.length === 0) return null

      const transcript = req.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n')

      return ollama.complete(
        model,
        [
          {
            role: 'system',
            content:
              'You compress conversations so they can be carried forward as context. ' +
              'Write a dense summary in the third person. Preserve decisions, facts, ' +
              'names, file paths, code identifiers and anything the user asked for. ' +
              'Drop pleasantries and repetition. No preamble, no headings.'
          },
          { role: 'user', content: `Summarise this conversation:\n\n${transcript}` }
        ],
        { keepAlive: settings.get('keepAlive'), numPredict: 500, numCtx: NUM_CTX }
      )
    }
  )

  /**
   * Names a conversation from its opening exchange. Runs on the quickest
   * installed model and caps output hard, because this happens in the
   * background right after an answer lands and must not compete with it.
   */
  ipcMain.handle(
    IPC.chatTitle,
    async (_e, req: { messages: Array<{ role: string; content: string }> }) => {
      const model = resolveTierModel('flash') ?? resolveTierModel('fast')
      const question = req.messages.find((m) => m.role === 'user')?.content.trim()
      if (!model || !question) return null

      // Title from the question alone, never the answer.
      //
      // Feeding the assistant's reply in made the model title the reply: asking
      // "what is speculative fiction" came back as "Exploring the Realm of
      // Speculative". Measured on llama3.2:3b, the question alone is both
      // accurate and about twice as fast.
      const raw = await ollama.complete(
        model,
        [
          {
            role: 'system',
            content:
              'Name the topic of the user’s question in 2 to 5 words, as a noun phrase. ' +
              'Reply with the name only. No quotes, no punctuation at the end, no preamble.'
          },
          { role: 'user', content: `User asked: ${question.slice(0, 500)}` }
        ],
        { keepAlive: settings.get('keepAlive'), numPredict: 20, numCtx: NUM_CTX }
      )

      return raw ? cleanTitle(raw, question) : null
    }
  )

  /* ------------------------------------------------------------------ browser */

  /**
   * Opens a page in the real browser.
   *
   * Reached three ways, and they are not equivalent: the user typing `/open`,
   * the user clicking a card the model proposed, and a card opening itself under
   * accept-all. All three come through here, and here re-checks the link - the
   * renderer's own check is for telling the user what will happen, not for
   * deciding, because the renderer is downstream of model output.
   */
  ipcMain.handle(IPC.linkOpen, async (_e, raw: string) => {
    if (!settings.get('browserEnabled')) {
      return { opened: false, url: '', host: '', error: 'Opening pages is turned off in settings.' }
    }
    return openLink(raw)
  })

  ipcMain.handle(IPC.linkSearch, async (_e, query: string) => {
    if (!settings.get('browserEnabled')) {
      return { opened: false, url: '', host: '', error: 'Opening pages is turned off in settings.' }
    }
    const engine = settings.get('searchEngine')
    return openSearch(query, isSearchEngine(engine) ? engine : 'duckduckgo')
  })

  /** What the panel needs to describe a link before anything is opened. */
  ipcMain.handle(IPC.linkCheck, (_e, raw: string) => checkLink(raw))

  /* ------------------------------------------------------------------- voice */

  ipcMain.handle(IPC.voiceStatus, () => speech.status())

  // Starting the transcriber loads a model, so it is done when the panel asks
  // rather than at launch: someone who never dictates never pays for it.
  ipcMain.handle(IPC.voiceStart, async () => {
    await speech.start()
    const status = speech.status()
    panel.send(IPC.voiceStatusChanged, status)
    return status
  })

  /**
   * Turns a recorded clip into text for the composer.
   *
   * Three stages, and only the first is unavoidable. Whisper transcribes;
   * `tidyTranscript` applies the table of things an acoustic model cannot know
   * about this app; and then, optionally, the local model punctuates it. The
   * result goes into the box, never straight to the model - dictation is typing,
   * and a mis-heard sentence has to be as easy to correct as a mistyped one.
   */
  ipcMain.handle(
    IPC.voiceTranscribe,
    async (_e, req: { audio: ArrayBuffer; extension?: string; commands?: string[] }) => {
        const clip = await speech.transcribe(new Uint8Array(req.audio), req.extension ?? 'webm')

        const heard = clip.text.trim()
        // The command list comes from the panel, which owns it, so a command added
        // later is dictatable without this file having to hear about it.
        const tidied = tidyTranscript(heard, { commands: req.commands ?? [] })
      if (!tidied) {
        return { text: '', heard, polished: false, polishRefused: false, confidence: clip.confidence, ms: clip.ms }
      }

      if (!settings.get('voicePolish')) {
        return { text: tidied, heard, polished: false, polishRefused: false, confidence: clip.confidence, ms: clip.ms }
      }

      // The quickest installed model, for the same reason titles use it: the user
      // is waiting to read this and press Enter.
      const model = resolveTierModel('flash') ?? resolveTierModel('fast')
      if (!model) {
        return { text: tidied, heard, polished: false, polishRefused: false, confidence: clip.confidence, ms: clip.ms }
      }

      const polished = await ollama.complete(
        model,
        [
          { role: 'system', content: POLISH_PROMPT },
          { role: 'user', content: tidied }
        ],
        { keepAlive: settings.get('keepAlive'), numPredict: 120, numCtx: NUM_CTX }
      )

      const accepted = polished !== null && polishAcceptable(tidied, polished)
      if (polished !== null && !accepted) {
        console.warn(`[wumpy] polish refused: ${JSON.stringify(polished.slice(0, 120))}`)
      }

      return {
        text: accepted ? polished!.trim() : tidied,
        heard,
        polished: accepted,
        polishRefused: polished !== null && !accepted,
        confidence: clip.confidence,
        ms: clip.ms
      }
    }
  )

  /**
   * Runs a web search the user approved. Like commands, the query leaves this
   * machine only after a click: a model can put anything in it, including
   * whatever it has just read.
   */
  ipcMain.handle(IPC.searchRun, async (_e, query: string) => {
    if (!settings.get('searchEnabled')) {
      return { results: [], provider: 'none', error: 'Search is turned off in settings.' }
    }
    console.log(`[wumpy] searching: ${query}`)
    return webSearch(query, settings.get('searchApiKey') || undefined)
  })

  /**
   * The single place that decides what happens to a proposed command.
   *
   * The renderer asks and obeys; it never works this out for itself, so a bug
   * or a tampered page cannot widen what is permitted.
   */
  function judge(command: string, tier: TierId): CommandVerdict {
    const scope = settings.get('shellEnabled') ? (TIERS[tier]?.tools ?? 'none') : 'none'
    const readOnly = isReadOnly(command)
    const allowed = scope === 'full' || (scope === 'read' && readOnly)
    const risk = assessRisk(command)
    const mode = settings.get('approvalMode')

    // Risky commands never run unprompted while confirmRisky stands, whatever
    // the mode: the model wrote them, and a wrong path does not come back.
    const risky = risk !== null && settings.get('confirmRisky')
    const auto = allowed && !risky && (mode === 'all' || (mode === 'auto' && readOnly))

    return { risk, allowed, scope, auto, readOnly }
  }

  ipcMain.handle(IPC.shellRisk, (_e, req: { command: string; tier: TierId }) =>
    judge(req.command, req.tier)
  )

  /**
   * Runs a command the user approved in the panel.
   *
   * The click in the renderer is the permission gate: the model only ever emits
   * text, and nothing reaches this handler without a person pressing Run. For
   * commands that match a risky pattern there is a second, native confirmation
   * that the page cannot draw or dismiss itself.
   */
  ipcMain.handle(
    IPC.shellRun,
    async (_e, req: { command: string; shell: ShellKind; tier: TierId }): Promise<ShellResult | null> => {
      const command = req.command.trim()
      if (!command) return null

      // The tier's scope is enforced here, not in the renderer and not by
      // asking the model nicely. A Quick tier may look things up; anything that
      // changes the machine needs a Developer tier.
      const verdict = judge(command, req.tier)
      if (!verdict.allowed) {
        const scope = verdict.scope
        return {
          command,
          shell: req.shell,
          cwd: '',
          stdout: '',
          stderr:
            scope === 'read'
              ? 'This tier may only read. Switch to Developer mode (Ctrl+D) to change anything.'
              : 'Running commands is not available in this tier.',
          exitCode: -1,
          durationMs: 0,
          timedOut: false,
          truncated: false,
          readOnly: verdict.readOnly
        }
      }

      if (!settings.get('shellEnabled')) {
        return {
          command,
          shell: req.shell,
          cwd: '',
          stdout: '',
          stderr: 'Running commands is turned off in settings (shellEnabled).',
          exitCode: -1,
          durationMs: 0,
          timedOut: false,
          truncated: false,
          readOnly: verdict.readOnly
        }
      }

      // A risky command still raises the dialog even when the mode would have
      // run it, unless the user has explicitly turned that off.
      const risk = settings.get('confirmRisky') ? verdict.risk : null
      if (risk) {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Run anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Wumpy wants to run a command',
          message: `This command ${risk}.`,
          detail: `${req.shell}

${command}`
        })
        if (response !== 1) return null
      }

      console.log(`[wumpy] running (${req.shell}): ${command}`)
      return runCommand(command, req.shell, settings.get('shellCwd') || undefined)
    }
  )

  ipcMain.on(IPC.chatAbort, (_e, requestId: string) => ollama.abort(requestId))
  ipcMain.on(IPC.panelHide, () => panel.hide())
  ipcMain.on(IPC.panelPin, (_e, pinned: boolean) => panel.setPinned(pinned))
  ipcMain.on(IPC.panelDock, (_e, dock: Dock) => panel.setDock(dock))
  ipcMain.handle(IPC.hotkeyState, () => hotkeyState)

  // ---- what the user typed, for the composer's history ----
  ipcMain.handle(IPC.historyGet, () => inputHistory.all())
  ipcMain.handle(IPC.historyAdd, (_e, text: string) => inputHistory.add(text))

  // ---- saved chats ----
  ipcMain.handle(IPC.chatsList, (): ChatSummary[] => chats.list())
  ipcMain.handle(IPC.chatsLoad, (_e, id: string) => chats.load(id))
  ipcMain.handle(
    IPC.chatsSave,
    (_e, chat: { id: string; title?: string; messages: ChatMessage[]; tier: TierId }) =>
      chats.save(chat)
  )
  ipcMain.handle(IPC.chatsRename, (_e, id: string, title: string) => chats.rename(id, title))
  ipcMain.handle(IPC.chatsDelete, (_e, id: string) =>
    id === '*' ? chats.deleteAll() : chats.delete(id)
  )
}

function syncLaunchAtLogin(enabled: boolean): void {
  // Packaged builds only — in dev this would register the Electron binary itself.
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

/* ------------------------------------------------------------------ bootup */

void app.whenReady().then(async () => {
  settings = new SettingsStore()
  chats = new ChatStore()
  inputHistory = new InputHistory()
  ollama = new OllamaClient(settings.get('ollamaHost'))
  panel = new Panel(settings)

  priority = new PriorityManager(() => panel.browserWindow)
  speech = new Speech()

  registerIpc()
  panel.create()

  const icon = nativeImage.createFromPath(resourcePath('icon.png'))
  if (!icon.isEmpty()) panel.browserWindow?.setIcon(icon)

  tray = createTray({
    panel,
    settings,
    getHotkeyState: () => hotkeyState,
    getTierStatuses: tierStatuses,
    onToggleLaunchAtLogin: syncLaunchAtLogin
  }) as Tray & { refresh(): void }

  applyHotkeys()
  void startLowLevelHook()
  syncLaunchAtLogin(settings.get('launchAtLogin'))

  await refreshModels()

  // Launched by the login item: stay in the tray instead of popping up.
  if (!process.argv.includes('--hidden')) panel.show()

  if (settings.get('warmOnStart')) {
    // Warm the selected tier first so the user's first question is instant,
    // then the other tier in the same mode. The heavy dev models are left for
    // an explicit switch rather than loading gigabytes nobody asked for.
    void (async () => {
      await warmTier(settings.get('tier'))
      const mode = settings.get('mode')
      for (const id of TIER_ORDER) {
        if (TIERS[id].mode === mode) await warmTier(id)
      }
    })()
  }
})

app.on('second-instance', () => panel?.show())

app.on('will-quit', () => {
  unregisterHotkeys()
  lowLevelHook?.stop()
  speech?.stop()
  ollama?.abortAll()
})


/**
 * Live facts, handed to the model every turn.
 *
 * A local model has no clock, no idea which chat it is in and no view of the
 * app around it, so without this it either guesses or refuses. Telling it is
 * free and removes a whole class of confident wrong answers.
 */
function withContext(
  req: ChatRequest,
  tierLabel: string,
  scope: 'none' | 'read' | 'full'
): Array<Pick<ChatMessage, 'role' | 'content'>> {
  lastChatTitle = req.context.chatTitle
  const facts = factsFor(tierLabel, req.context.chatTitle)

  // Worked examples go at the very front, where they are byte-identical every
  // turn and so stay in the KV cache. They cost one prefill, not one per turn.
  const examples: Array<Pick<ChatMessage, 'role' | 'content'>> =
    scope === 'none' ? [] : shellExamples(scope)

  const messages: Array<Pick<ChatMessage, 'role' | 'content'>> = [
    ...examples,
    ...req.messages.map((m) => ({ role: m.role, content: m.content }))
  ]
  // Directly behind the latest user turn, so everything before it stays cached.
  //
  // Moving it in front of the conversation instead looks like it should be
  // cheaper — it would stop sliding one message further along each turn, and so
  // stop the previous answer landing after the point where the cache diverges.
  // Measured over a three-turn conversation, it makes no difference at all:
  // 0.92s and 0.94s of prefill on turns two and three where it is, against
  // 0.90s and 0.87s in front. Not worth the re-prefill it would cost each time
  // a chat is named.
  messages.splice(Math.max(0, messages.length - 1), 0, { role: 'system', content: facts })
  return messages
}
