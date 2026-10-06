import { app, dialog, ipcMain, nativeImage, Tray } from 'electron'
import { homedir } from 'node:os'
import { IPC } from '@shared/types'
import type {
  ChatMessage,
  ShellKind,
  ShellResult,
  ChatRequest,
  ChatSummary,
  Dock,
  HotkeyState,
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
  shellExamples
} from '@shared/tiers'
import { SettingsStore } from './store'
import { ChatStore } from './chats'
import { OllamaClient } from './ollama'
import { Panel } from './panel'
import { createTray, resourcePath } from './tray'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { LowLevelHook } from './lowlevelhook'
import { runCommand, assessRisk, isReadOnly } from './shell'
import { PriorityManager } from './priority'

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
let ollama: OllamaClient
let panel: Panel
let tray: (Tray & { refresh(): void }) | null = null
let hotkeyState: HotkeyState = { active: null, failed: [], intercepted: null }
let lowLevelHook: LowLevelHook | null = null
let priority: PriorityManager

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
async function warmTier(id: TierId): Promise<void> {
  const model = resolveTierModel(id)
  if (!model || ollama.isWarm(model)) return
  await ollama.warm(model, settings.get('keepAlive'))
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
    const systemPrompt = [
      tier.systemPrompt,
      APP_PROMPT,
      scope === 'full' ? SHELL_PROMPT : scope === 'read' ? READ_SHELL_PROMPT : NO_SHELL_PROMPT,
      ASK_PROMPT
    ].join('\n\n')

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
        { keepAlive: settings.get('keepAlive'), numPredict: 500 }
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
        { keepAlive: settings.get('keepAlive'), numPredict: 20 }
      )

      return raw ? cleanTitle(raw) : null
    }
  )

  ipcMain.handle(IPC.shellRisk, (_e, req: { command: string; tier: TierId }) => {
    const scope = settings.get('shellEnabled') ? (TIERS[req.tier]?.tools ?? 'none') : 'none'
    const allowed = scope === 'full' || (scope === 'read' && isReadOnly(req.command))
    return { risk: assessRisk(req.command), allowed, scope }
  })

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
      const scope = settings.get('shellEnabled') ? (TIERS[req.tier]?.tools ?? 'none') : 'none'
      if (scope === 'none' || (scope === 'read' && !isReadOnly(command))) {
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
          truncated: false
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
          truncated: false
        }
      }

      const risk = assessRisk(command)
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
  ollama = new OllamaClient(settings.get('ollamaHost'))
  panel = new Panel(settings)

  priority = new PriorityManager(() => panel.browserWindow)

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
  ollama?.abortAll()
})

/**
 * Small models like to wrap titles in quotes, prefix them with "Title:", or add
 * a full stop. Strip all of that, then title-case the result.
 */
function cleanTitle(raw: string): string | null {
  let t = raw.split('\n').find((l) => l.trim()) ?? ''
  t = t.replace(/^\s*(?:title|topic|chat|name)\s*[:\-]\s*/i, '')
  t = t.replace(/^["'“‘`]+|["'”’`]+$/g, '')
  t = t.replace(/[.\s]+$/, '').trim()
  if (!t) return null

  // Guard against a model that ignored the word limit entirely.
  const words = t.split(/\s+/)
  if (words.length > 8) t = words.slice(0, 7).join(' ')

  return titleCase(t).slice(0, 60).trim()
}

/** Minor words stay lowercase unless they lead. */
const MINOR = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'vs', 'with'])

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word, i) => {
      // Leave anything already carrying a capital alone, so CSS, Win+C and
      // llama3.2 survive intact.
      if (/[A-Z0-9]/.test(word)) return word
      if (i > 0 && MINOR.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

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
  const now = new Date()
  // Deliberately no clock time and no message count. Both changed on every
  // turn and bought nothing, while making this block differ each time.
  const facts = [
    'Facts about right now. If the user asks about any of these, just state the answer.',
    `- Today is ${now.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })}.`,
    `- The current tier is ${tierLabel}.`,
    `- This chat is titled ${req.context.chatTitle ? `"${req.context.chatTitle}"` : 'untitled so far'}.`,
    `- The user is on Windows. Commands run from ${settings.get('shellCwd') || homedir()}.`
  ].join('\n')

  // Worked examples go at the very front, where they are byte-identical every
  // turn and so stay in the KV cache. They cost one prefill, not one per turn.
  const examples: Array<Pick<ChatMessage, 'role' | 'content'>> =
    scope === 'none' ? [] : shellExamples(scope)

  const messages: Array<Pick<ChatMessage, 'role' | 'content'>> = [
    ...examples,
    ...req.messages.map((m) => ({ role: m.role, content: m.content }))
  ]
  // Directly behind the latest user turn, so everything before it stays cached.
  messages.splice(Math.max(0, messages.length - 1), 0, { role: 'system', content: facts })
  return messages
}
