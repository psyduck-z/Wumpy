import type { Dock, ProviderName } from '@shared/types'
import { PROVIDER_IDS, isProviderId } from '@shared/cloud'

/**
 * What a command asks the app to do. Commands are parsed in the renderer and
 * dispatched as plain data, so the composer never needs to know what any of
 * them mean.
 */
export type CommandAction =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'new' }
  | { kind: 'chats' }
  | { kind: 'resume' }
  | { kind: 'delete' }
  | { kind: 'rename'; title: string }
  | { kind: 'renameChoice'; question: string; options: string[] }
  | { kind: 'model'; name: string }
  | { kind: 'dock'; dock: Dock | null }
  | { kind: 'reasoning'; show: boolean | 'toggle' }
  | { kind: 'pin'; pinned: boolean | 'toggle' }
  | { kind: 'voice'; setting: 'on' | 'polish' | 'autostop'; on: boolean | 'toggle' }
  | { kind: 'open'; what: string }
  | { kind: 'engine' }
  | { kind: 'key'; provider: ProviderName | null; value: string; clear: boolean }
  | { kind: 'usage'; reset: boolean }
  | { kind: 'approve'; mode: 'manual' | 'auto' | 'all' | 'cycle' }
  | { kind: 'compact' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'quit' }
  /** Send to the model, but wrapped in a prompt that shapes the answer. */
  | { kind: 'prompt'; text: string; label: string }

export interface CommandSpec {
  name: string
  aliases?: string[]
  /** Shown in the palette. */
  hint: string
  /** `<name>` style placeholder shown after the command when it takes an argument. */
  arg?: string
  run(arg: string): CommandAction
}

const DOCKS: Dock[] = ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']
/**
 * Prompt wrappers. These are the "commands Claude has" that a plain chat box
 * does not: they reshape the request rather than issuing an app action.
 */
const PROMPT_COMMANDS: Array<{
  name: string
  hint: string
  label: string
  wrap(t: string): string
}> = [
  {
    name: 'plan',
    hint: 'Plan the approach before writing anything',
    label: 'plan',
    wrap: (t) =>
      `Produce a short implementation plan for the following. Number the steps, ` +
      `name the files or commands each step touches, and call out anything risky ` +
      `or ambiguous. Do not write the full solution yet.\n\n${t}`
  },
  {
    name: 'btw',
    hint: 'Quick aside — answer in one line, no preamble',
    label: 'btw',
    wrap: (t) => `Answer in a single short line. No preamble, no caveats.\n\n${t}`
  },
  {
    name: 'explain',
    hint: 'Explain it plainly, with a concrete example',
    label: 'explain',
    wrap: (t) =>
      `Explain the following clearly, assuming a competent engineer who is new to ` +
      `this specific thing. Include one concrete example.\n\n${t}`
  },
  {
    name: 'fix',
    hint: 'Diagnose an error and give the corrected code',
    label: 'fix',
    wrap: (t) =>
      `Diagnose this problem. State the root cause in one sentence, then give the ` +
      `corrected code. Do not restate the original code unchanged.\n\n${t}`
  },
  {
    name: 'review',
    hint: 'Review code for real bugs, not style',
    label: 'review',
    wrap: (t) =>
      `Review the following for correctness bugs, edge cases and failure modes. ` +
      `Ignore formatting and style. If you find nothing real, say so plainly.\n\n${t}`
  },
  {
    name: 'cmd',
    hint: 'Give just the command line, nothing else',
    label: 'cmd',
    wrap: (t) =>
      `Give only the command line that does this, in a fenced code block, with a ` +
      `one-line explanation beneath it. Target Windows PowerShell unless told ` +
      `otherwise.\n\n${t}`
  }
]

function bool(arg: string, fallback: boolean | 'toggle' = 'toggle'): boolean | 'toggle' {
  const a = arg.trim().toLowerCase()
  if (['on', 'yes', 'true', 'show', '1'].includes(a)) return true
  if (['off', 'no', 'false', 'hide', '0'].includes(a)) return false
  return fallback
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'new',
    aliases: ['clear', 'reset'],
    hint: 'Start a fresh chat',
    run: () => ({ kind: 'new' })
  },
  {
    name: 'resume',
    aliases: ['r'],
    // No argument on purpose: the picker has its own search box and arrow-key
    // selection, so Enter should open it rather than wait for a name.
    hint: 'Pick up a previous chat (Ctrl+R)',
    run: () => ({ kind: 'resume' })
  },
  {
    name: 'chats',
    aliases: ['history', 'list'],
    hint: 'Browse saved chats',
    run: () => ({ kind: 'chats' })
  },
  {
    name: 'delete',
    aliases: ['rm'],
    // Same picker as /resume: searching by typing a name is what the list is for.
    hint: 'Delete a saved chat',
    run: () => ({ kind: 'delete' })
  },
  {
    name: 'rename',
    aliases: ['title'],
    hint: 'Retitle this chat (chats save themselves)',
    arg: 'title',
    run: (arg) =>
      arg.trim()
        ? { kind: 'rename', title: arg.trim() }
        : { kind: 'error', message: 'Usage: /rename <title>' }
  },
  {
    name: 'dock',
    aliases: ['move', 'pos'],
    hint: 'Move the panel: left | right | top-right | …',
    arg: 'position',
    run: (arg) => {
      if (!arg.trim()) return { kind: 'dock', dock: null }
      const a = arg.trim().toLowerCase().replace(/\s+/g, '-')
      const dock = DOCKS.find((d) => d === a)
      if (!dock) {
        return { kind: 'error', message: `Unknown position. Try: ${DOCKS.join(', ')}` }
      }
      return { kind: 'dock', dock }
    }
  },
  {
    name: 'reasoning',
    aliases: ['scratchpad'],
    hint: 'Show or hide the model’s scratchpad',
    arg: 'on|off',
    run: (arg) => ({ kind: 'reasoning', show: bool(arg) })
  },
  {
    name: 'pin',
    aliases: ['autohide'],
    hint: 'Keep on top, or let it hide when you click away',
    arg: 'on|off',
    run: (arg) => ({ kind: 'pin', pinned: bool(arg) })
  },
  {
    name: 'model',
    aliases: ['models', 'gemini'],
    hint: 'Choose the model for this tier — local or hosted',
    arg: 'name',
    // With a name it sets directly, which is quicker than the picker once you
    // know what you want and is the only way to reach a model not in the list.
    run: (arg) => ({ kind: 'model', name: arg.trim() })
  },
  {
    name: 'open',
    aliases: ['browse', 'go', 'google'],
    hint: 'Open a page, or search the web, in your browser',
    arg: 'url or words',
    run: (arg) =>
      arg.trim()
        ? { kind: 'open', what: arg.trim() }
        : {
            kind: 'error',
            message: 'Give me a link or something to search for: `/open wikipedia.org`'
          }
  },
  {
    name: 'engine',
    aliases: ['searchengine'],
    hint: 'Choose which search engine the browser opens',
    run: () => ({ kind: 'engine' })
  },
  {
    name: 'usage',
    aliases: ['tokens', 'quota', 'spend'],
    hint: 'What today has cost, per model',
    arg: 'reset',
    run: (arg) => ({ kind: 'usage', reset: /^reset$|^clear$/i.test(arg.trim()) })
  },
  {
    name: 'key',
    aliases: ['apikey'],
    hint: 'Add or remove a hosted-model API key',
    arg: 'google|groq|mistral|nvidia <key>',
    /**
     * Parsed here rather than in a dialog because a key is pasted, and the
     * composer is where pasting happens. The value is handed straight to the
     * main process and never stored in the renderer - not in state, not in the
     * input history, which `/key` is excluded from for that reason.
     */
    run: (arg) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean)
      const provider = parts[0]?.toLowerCase()
      if (!isProviderId(provider)) {
        return {
          kind: 'error',
          message:
            'Say which one: ' +
            PROVIDER_IDS.map((id) => `\`/key ${id} <key>\``).join(', ') +
            '. Use `/key google clear` to remove it.'
        }
      }
      const rest = parts.slice(1).join(' ')
      if (!rest) return { kind: 'key', provider, value: '', clear: false }
      if (/^(clear|remove|forget|off)$/i.test(rest)) {
        return { kind: 'key', provider, value: '', clear: true }
      }
      return { kind: 'key', provider, value: rest, clear: false }
    }
  },
  {
    name: 'voice',
    aliases: ['dictate', 'dictation', 'mic'],
    hint: 'Talk instead of typing — hold the spacebar',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'on', on: bool(arg) })
  },
  {
    name: 'polish',
    aliases: ['autocorrect'],
    hint: 'Tidy dictated punctuation with the local model',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'polish', on: bool(arg) })
  },
  {
    name: 'autostop',
    aliases: ['pushtotalk'],
    hint: 'Stop dictating by itself when you stop talking',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'autostop', on: bool(arg) })
  },
  {
    name: 'approve',
    aliases: ['auto', 'permissions'],
    hint: 'manual | auto | all — how much runs without asking',
    arg: 'mode',
    run: (arg) => {
      const a = arg.trim().toLowerCase()
      if (!a) return { kind: 'approve', mode: 'cycle' }
      if (['manual', 'ask', 'off'].includes(a)) return { kind: 'approve', mode: 'manual' }
      if (['auto', 'safe', 'read'].includes(a)) return { kind: 'approve', mode: 'auto' }
      if (['all', 'everything', 'yolo'].includes(a)) return { kind: 'approve', mode: 'all' }
      return { kind: 'error', message: 'Usage: /approve manual | auto | all' }
    }
  },
  {
    name: 'compact',
    aliases: ['summarise', 'summarize'],
    hint: 'Summarise older turns to free up context',
    run: () => ({ kind: 'compact' })
  },
  {
    name: 'also',
    hint: 'Add something while an answer is still running',
    arg: 'text',
    // Only meaningful mid-answer, and the app intercepts it there. Reaching
    // here means nothing was running, so it is just a message.
    run: (arg) =>
      arg.trim()
        ? { kind: 'prompt', text: arg.trim(), label: 'also' }
        : { kind: 'info', message: '`/also <text>` adds a note while an answer is still running.' }
  },
  { name: 'stop', hint: 'Stop generating', run: () => ({ kind: 'stop' }) },
  { name: 'help', aliases: ['?'], hint: 'List every command', run: () => ({ kind: 'help' }) },
  { name: 'quit', aliases: ['exit'], hint: 'Quit Wumpy', run: () => ({ kind: 'quit' }) },

  ...PROMPT_COMMANDS.map((p): CommandSpec => ({
    name: p.name,
    hint: p.hint,
    arg: 'text',
    run: (arg) =>
      arg.trim()
        ? { kind: 'prompt', text: p.wrap(arg.trim()), label: p.label }
        : { kind: 'error', message: `Usage: /${p.name} <text>` }
  }))
]

/**
 * Keys that reach a command directly, shown beside it in the menu.
 *
 * The menu is for finding things. Showing the key is what stops it being
 * needed a second time.
 */
export const SHORTCUT_FOR: Record<string, string | undefined> = {
  also: 'while busy',
  new: 'Ctrl+N',
  resume: 'Ctrl+R',
  model: 'Ctrl+Shift+M',
  dock: 'Ctrl+D',
  pin: 'Ctrl+P',
  approve: 'Shift+Tab',
  stop: 'Esc',
  quit: 'Esc',
  help: 'Ctrl+K'
}

/**
 * Keys that are not a command, listed so Ctrl+K can show them anyway.
 *
 * The palette was built from the command list, so anything with no slash
 * command behind it — approving a proposal, stepping through the transcript,
 * copying the last answer — was undiscoverable unless you already knew it.
 * That is most of the navigation.
 */
export const KEY_ONLY: Array<{ keys: string; what: string }> = [
  { keys: 'Ctrl+Enter', what: 'Run the newest proposal' },
  { keys: 'Ctrl+Shift+Enter', what: 'Skip the newest proposal' },
  { keys: 'Ctrl+↓ / Ctrl+↑', what: 'Step into the newest / first proposal' },
  { keys: '← →', what: 'Move between a proposal’s buttons' },
  { keys: 'Alt+↑ / Alt+↓', what: 'Step through messages' },
  { keys: 'PgUp / PgDn', what: 'Scroll the transcript' },
  { keys: 'Ctrl+Home / Ctrl+End', what: 'Jump to the top / bottom' },
  { keys: 'Ctrl+Shift+C', what: 'Copy the last answer' },
  { keys: 'Ctrl+C', what: 'Stop generating (with nothing selected)' },
  { keys: 'Esc', what: 'Back to the box, then close the panel' },
  { keys: '↑ ↓', what: 'Recall what you typed before, in an empty box' }
]

/** Every command, for the menu. */
export function allCommands(): CommandSpec[] {
  return COMMANDS
}

/** Every name and alias, for matching. */
function matches(spec: CommandSpec, name: string): boolean {
  return spec.name === name || (spec.aliases?.includes(name) ?? false)
}

export function findCommand(name: string): CommandSpec | undefined {
  const n = name.toLowerCase()
  return COMMANDS.find((c) => matches(c, n))
}

/**
 * Commands whose name starts with the typed prefix, for the palette.
 * An empty prefix lists everything.
 */
export function completions(input: string): CommandSpec[] {
  if (!input.startsWith('/')) return []
  const [name] = input.slice(1).split(/\s+/)
  const n = name.toLowerCase()
  if (!n) return COMMANDS
  return COMMANDS.filter(
    (c) => c.name.startsWith(n) || (c.aliases?.some((a) => a.startsWith(n)) ?? false)
  )
}

/**
 * Parses a composer line. Returns null when the text is an ordinary message,
 * so the caller can send it unchanged.
 */
export function parseCommand(input: string): CommandAction | null {
  const text = input.trim()
  if (!text.startsWith('/')) return null

  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
  if (!match) return null

  const [, name, arg] = match
  const spec = findCommand(name)
  if (!spec) {
    return { kind: 'error', message: `Unknown command /${name}. Type /help to see them all.` }
  }
  return spec.run(arg ?? '')
}

/** Markdown table of every command, rendered by /help. */
export function helpText(): string {
  const rows = COMMANDS.map((c) => {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => `/${n}`).join(', ')
    const arg = c.arg ? ` \`<${c.arg}>\`` : ''
    return `| ${names}${arg} | ${c.hint} |`
  })
  return [
    '**Commands**',
    '',
    '| Command | What it does |',
    '| --- | --- |',
    ...rows,
    '',
    '**Keys**',
    '',
    '| Key | What it does |',
    '| --- | --- |',
    '| Ctrl+K | Every command, searchable |',
    '| ↑ / ↓ | Step back through what you have typed before |',
    '| Enter / Shift+Enter | Send / start a new line |',
    '| Ctrl+M | Start or stop dictation |',
    '| Ctrl+Shift+M | Change the model |',
    '| Ctrl+N | New chat |',
    '| Ctrl+R | Reopen a saved chat |',
    '| Ctrl+D | Move the panel to the next corner |',
    '| Ctrl+P | Pin or unpin |',
    '| Ctrl+Shift+C | Copy the last answer |',
    '| Ctrl+Enter | Run the command being asked about |',
    '| Ctrl+Shift+Enter | Skip it |',
    '| Ctrl+Down / Ctrl+Up | Step into the newest / first proposal |',
    '| ← / → | Move between a proposal’s buttons |',
    '| Ctrl+C | Stop the answer (copies instead if text is selected) |',
    '| Alt+Up / Alt+Down | Step through the conversation a message at a time |',
    '| Shift+Tab | Cycle approval mode |',
    '| PageUp / PageDown | Move through the transcript |',
    '| Ctrl+Home / Ctrl+End | Jump to the start, or to the latest |',
    '| Esc | Stop, go back, or hide |',
    '',
    'Typing while an answer is running queues the message until it finishes.',
    'Start it with `/also` instead and it is added as a note straight away,',
    'without interrupting: the answer carries on and the model sees it next turn.'
  ].join('\n')
}
