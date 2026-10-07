import type { Tier, TierId, Mode } from './types'

/**
 * Appended for tiers that may act. The model never runs anything itself: it
 * proposes, and the user clicks. The fence tag is what the renderer looks for.
 */
const RUN_EXAMPLE = [
  '```wumpy-run',
  '# Check whether Ollama is installed',
  'Get-Command ollama -ErrorAction SilentlyContinue',
  '```'
].join(String.fromCharCode(10))

/**
 * The decision the model keeps getting wrong, stated as a decision.
 *
 * Phrasing this as "propose a command whenever X" made a 3.8B model wrap
 * everything in a block, including refusals and the capital of France. Asking
 * it to answer one question first — does this depend on this computer? — and
 * naming the common answer as "no" scored measurably better.
 */
const DECIDE = [
  'First decide: does this depend on what is on THIS computer?',
  'NO  -> answer in words. No code block. Most questions are this.',
  'YES -> propose ONE command in a wumpy-run block, first line a # saying why.',
  '',
  RUN_EXAMPLE,
  '',
  'Runs in PowerShell. Prefer a tool’s own command (ollama list, node -v, git',
  'status) over hunting the filesystem. Real paths only, never a placeholder.',
  'Only use subcommands you are certain exist. If unsure, run the tool’s --help',
  'rather than guessing a name. Always include the # line, every time.',
  'Get-Command proves a tool exists; its Version column is file metadata and is',
  'usually 0.0.0.0. Never report that as a version — run the tool’s own',
  '--version instead, and if asked both, propose the --version command.',
  'Get-Command only finds things on PATH. To check whether an APPLICATION is',
  'installed, search the uninstall registry instead:',
  'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* |',
  "Where-Object DisplayName -like '*name*' | Select-Object DisplayName, DisplayVersion",
  'A block holds a command and nothing else — never a sentence or a refusal.'
].join(String.fromCharCode(10))

export const SHELL_PROMPT = [
  DECIDE,
  '',
  'You may read and you may change things, but the user approves every command',
  'before it runs and you are given its output afterwards. One command at a time.'
].join(String.fromCharCode(10))

/** Appended for tiers limited to looking things up. */
export const READ_SHELL_PROMPT = [
  DECIDE,
  '',
  'You may only READ: versions, files, folders, installed software, processes.',
  'You cannot install, delete, move or change anything. If the user asks for that,',
  'answer in words: That needs Developer mode — press Ctrl+D. Never put that in a block.'
].join(String.fromCharCode(10))

/**
 * Worked turns, prepended to the conversation for tiers that can act.
 *
 * Measured on phi4-mini:3.8b across eight cases: prose rules alone scored 5/8
 * and the same rules with the examples *described* scored 7/8, but the examples
 * as real turns scored 8/8 at two temperatures. A small model imitates far
 * better than it follows instructions.
 *
 * They sit at the front of the request, where they are identical every turn and
 * so stay in the KV cache; they cost one prefill, not one per message.
 */
export function shellExamples(scope: 'read' | 'full'): Array<{ role: 'user' | 'assistant'; content: string }> {
  const refusal =
    scope === 'read'
      ? 'That needs Developer mode — press Ctrl+D.'
      : 'Installing Python. I will fetch it with winget.'
  return [
    { role: 'user', content: 'what is the capital of France' },
    { role: 'assistant', content: 'Paris.' },
    { role: 'user', content: 'install python for me' },
    { role: 'assistant', content: refusal },
    { role: 'user', content: 'is ollama installed on my pc?' },
    {
      role: 'assistant',
      content: `Checking whether Ollama is on your PATH.

${RUN_EXAMPLE}`
    },
    { role: 'user', content: 'what is the latest version of Electron' },
    {
      role: 'assistant',
      content: [
        'Looking that up.',
        '',
        '```wumpy-search',
        '# Find the current Electron release',
        'latest Electron version',
        '```'
      ].join(String.fromCharCode(10))
    }
  ]
}

/** Appended for tiers that may search the web. */
export const SEARCH_PROMPT = [
  'For anything current, or a version or product you are unsure of, search the web:',
  'a wumpy-search block, a # line saying why, then a short query. You get the',
  'results back and answer from them, citing sources. Do not search what you know.'
].join(String.fromCharCode(10))

/**
 * Lets the model put a question back to the user instead of guessing.
 *
 * A wrong guess costs a whole slow turn to discover and another to correct,
 * which on this hardware is a minute of someone's life.
 */
export const ASK_PROMPT = [
  'If a request is genuinely ambiguous and the readings differ, ask instead of',
  'guessing: a wumpy-ask block, the question then two to four options after dashes.',
  '',
  '```wumpy-ask',
  'Which folder did you mean?',
  '- Downloads',
  '- Documents',
  '```',
  '',
  'One question, then wait. Never ask what the facts already answer. Take wording',
  'literally and keep the user’s capitalisation rather than reasoning about it.'
].join(String.fromCharCode(10))

export const NO_SHELL_PROMPT = [
  'Answer questions using your own knowledge. That is your main job and you are good at it.',
  '',
  'You cannot run commands or look at this computer right now.',
  'If the user asks you to check, install, open or change something on their machine,',
  'reply with exactly: That needs Developer mode — press Ctrl+D.',
  'Never guess the answer and never claim you checked.',
  '',
  'Everything else is an ordinary question. Answer it.'
].join('\n')

/**
 * Wumpy's own commands, for every tier.
 *
 * Without this a reasoning model tries to work out how to rename a chat itself
 * and gets stuck — qwen3:4b spent nine and a half minutes on exactly that. It
 * cannot; the user types a slash command.
 */
export const APP_PROMPT = [
  'You cannot change Wumpy itself. If asked to rename, clear or switch something,',
  'reply with only the command: /rename, /new, /resume, /compact, /tier, /mode, /dock.'
].join(String.fromCharCode(10))

const BASE_PROMPT = [
  'You are Wumpy, a local assistant in the Windows system tray.',
  'Answer directly and stop. No preamble, no restating the question, no offers of',
  'further help, no filler. Never deliberate in the open: decide and answer.',
  'Markdown only where it earns its place; fenced code blocks with a language tag.'
].join(String.fromCharCode(10))

/**
 * The four thinking tiers.
 *
 * Models are chosen for a CPU-only machine, where the deciding factor is not
 * parameter count but whether the model reasons before speaking. Benchmarked
 * on a Ryzen 7 7735U with `npm run bench` — overall score out of 100, 70%
 * correctness and 30% responsiveness:
 *
 *   phi4-mini:3.8b   95   9.2 tok/s   first word 1.3s   shell decisions 5/5
 *   llama3.2:3b      89  12.1 tok/s   first word 1.2s   shell decisions 4/5
 *   gemma3:4b        64   9.9 tok/s   first word 8.7s
 *   qwen3.5:4b        6   5.7 tok/s   first word 76.9s
 *
 * No tier uses a reasoning model, because on this hardware they are not a
 * smarter option, they are a broken one. Six logic questions, measured:
 *
 *   phi4-mini:3.8b (no reasoning)   3/6 correct   74s total      0 chars scratchpad
 *   qwen3:4b       (reasoning)      2/6 correct  774s total  12,907 chars scratchpad
 *
 * Four of qwen3's six answers were empty: it spent two to three minutes on
 * scratchpad per question and never reached a conclusion. Depth now comes from
 * a bigger non-reasoning model instead.
 *
 * `alternates` let a tier resolve to something that is actually installed
 * rather than failing outright.
 */
export const TIERS: Record<TierId, Tier> = {
  flash: {
    id: 'flash',
    label: 'Flash',
    blurb: 'Instant. One-liners, lookups, quick recall.',
    mode: 'quick',
    speed: 'instant',
    model: 'llama3.2:3b',
    alternates: ['llama3.2:1b', 'phi4-mini:3.8b', 'qwen2.5:3b'],
    thinking: false,
    tools: 'none',
    options: { num_ctx: 2048, num_predict: 384, temperature: 0.4, top_p: 0.9 },
    systemPrompt: `${BASE_PROMPT} One or two sentences.`
  },

  fast: {
    id: 'fast',
    label: 'Fast',
    blurb: 'Balanced. The everyday default. Can look things up.',
    mode: 'quick',
    speed: 'quick',
    model: 'phi4-mini:3.8b',
    alternates: ['llama3.2:3b', 'qwen2.5:3b'],
    thinking: false,
    tools: 'read',
    options: { num_ctx: 4096, num_predict: 1024, temperature: 0.6, top_p: 0.9 },
    systemPrompt: `${BASE_PROMPT} A short paragraph, or bullets if it is genuinely a list.`
  },

  thinker: {
    id: 'thinker',
    label: 'Thinker',
    blurb: 'Bigger model, more depth. Can run commands.',
    mode: 'dev',
    speed: 'slow',
    model: 'qwen2.5:7b',
    alternates: ['llama3.1:8b', 'qwen2.5:3b'],
    thinking: false,
    tools: 'full',
    options: { num_ctx: 8192, num_predict: 800, temperature: 0.6, top_p: 0.95 },
    systemPrompt: `${BASE_PROMPT} Give the conclusion, plus any assumption in one line.`
  },

  deep: {
    id: 'deep',
    label: 'Deep Thinker',
    blurb: 'Most capable, slowest. Can run commands.',
    mode: 'dev',
    speed: 'slowest',
    model: 'qwen2.5-coder:14b',
    alternates: ['qwen2.5-coder:7b', 'qwen3:8b'],
    thinking: false,
    tools: 'full',
    options: { num_ctx: 8192, num_predict: 1500, temperature: 0.3, top_p: 0.9 },
    systemPrompt:
      `${BASE_PROMPT} Thorough where it matters only. Working code over prose ` +
      'about code. Name edge cases briefly.'
  }
}

export const TIER_ORDER: TierId[] = ['flash', 'fast', 'thinker', 'deep']

export function tiersForMode(mode: Mode): TierId[] {
  return TIER_ORDER.filter((id) => TIERS[id].mode === mode)
}

/** The tier a mode opens on: the quicker of its two. */
export function defaultTierFor(mode: Mode): TierId {
  return mode === 'quick' ? 'fast' : 'thinker'
}

export const SPEED_LABEL: Record<Tier['speed'], string> = {
  instant: '~instant',
  quick: 'fast',
  slow: 'slow',
  slowest: 'very slow'
}
