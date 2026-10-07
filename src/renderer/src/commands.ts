import type { Dock, Mode, TierId } from '@shared/types'

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
  | { kind: 'tier'; tier: TierId | null }
  | { kind: 'model' }
  | { kind: 'mode'; mode: Mode | 'toggle' }
  | { kind: 'dock'; dock: Dock | null }
  | { kind: 'reasoning'; show: boolean | 'toggle' }
  | { kind: 'pin'; pinned: boolean | 'toggle' }
  | { kind: 'approve'; mode: 'manual' | 'auto' | 'all' | 'cycle' }
  | { kind: 'warm' }
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
const TIER_NAMES: Record<string, TierId> = {
  flash: 'flash',
  fast: 'fast',
  thinker: 'thinker',
  think: 'thinker',
  smart: 'thinker',
  deep: 'deep',
  deepthinker: 'deep',
  smartest: 'deep'
}

/**
 * Prompt wrappers. These are the "commands Claude has" that a plain chat box
 * does not: they reshape the request rather than issuing an app action.
 */
const PROMPT_COMMANDS: Array<{ name: string; hint: string; label: string; wrap(t: string): string }> =
  [
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
    name: 'tier',
    aliases: ['smart', 'level', 'think'],
    hint: 'Switch thinking level, keeping the conversation',
    arg: 'name',
    run: (arg) => {
      // No name given: show the list rather than make the user remember them.
      if (!arg.trim()) return { kind: 'tier', tier: null }
      const key = arg.trim().toLowerCase().replace(/[\s-]/g, '')
      const tier = TIER_NAMES[key]
      if (!tier) {
        return {
          kind: 'error',
          message: `Unknown tier "${arg.trim()}". Try flash, fast, thinker or deep.`
        }
      }
      return { kind: 'tier', tier }
    }
  },
  {
    name: 'mode',
    aliases: ['dev'],
    hint: 'Toggle Quick / Developer mode',
    arg: 'quick|dev',
    run: (arg) => {
      const a = arg.trim().toLowerCase()
      if (a === 'quick') return { kind: 'mode', mode: 'quick' }
      if (a === 'dev' || a === 'developer') return { kind: 'mode', mode: 'dev' }
      return { kind: 'mode', mode: 'toggle' }
    }
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
    aliases: ['models'],
    hint: 'Pick which installed model this tier uses',
    run: () => ({ kind: 'model' })
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
    name: 'warm',
    aliases: ['preload'],
    hint: 'Preload this tier’s model so answers start instantly',
    run: () => ({ kind: 'warm' })
  },
  {
    name: 'compact',
    aliases: ['summarise', 'summarize'],
    hint: 'Summarise older turns to free up context',
    run: () => ({ kind: 'compact' })
  },
  { name: 'stop', hint: 'Stop generating', run: () => ({ kind: 'stop' }) },
  { name: 'help', aliases: ['?'], hint: 'List every command', run: () => ({ kind: 'help' }) },
  { name: 'quit', aliases: ['exit'], hint: 'Quit Wumpy', run: () => ({ kind: 'quit' }) },

  ...PROMPT_COMMANDS.map(
    (p): CommandSpec => ({
      name: p.name,
      hint: p.hint,
      arg: 'text',
      run: (arg) =>
        arg.trim()
          ? { kind: 'prompt', text: p.wrap(arg.trim()), label: p.label }
          : { kind: 'error', message: `Usage: /${p.name} <text>` }
    })
  )
]

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
    '| ↑ / ↓ | Step back through what you have typed before |',
    '| Enter / Shift+Enter | Send / start a new line |',
    '| Ctrl+1–4 | Jump straight to a tier |',
    '| Ctrl+D | Quick or Developer mode |',
    '| Ctrl+N | New chat |',
    '| Ctrl+R | Reopen a saved chat |',
    '| Shift+Tab | Cycle approval mode |',
    '| PageUp / PageDown | Move through the transcript |',
    '| Ctrl+Home / Ctrl+End | Jump to the start, or to the latest |',
    '| Esc | Stop, go back, or hide |'
  ].join('\n')
}
