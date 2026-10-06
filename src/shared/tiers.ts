import type { Tier, TierId, Mode } from './types'

/**
 * Appended for tiers that may act. The model never runs anything itself: it
 * proposes, and the user clicks. The fence tag is what the renderer looks for.
 */
export const SHELL_PROMPT = [
  'You can run commands on the user’s Windows machine by proposing them.',
  '',
  'Propose a command ONLY when the answer depends on the state of this machine:',
  'installed software, file contents, versions, hardware, running processes.',
  'For anything you already know, just answer. Never propose a command for general knowledge.',
  '',
  'Never guess the state of this machine. If asked whether something is installed,',
  'or what version it is, propose a command to check instead of answering from memory.',
  '',
  'Format: a fenced block tagged wumpy-run holding exactly one command.',
  '',
  '```wumpy-run',
  'Get-Command ollama -ErrorAction SilentlyContinue',
  '```',
  '',
  'Rules for the command:',
  '- It already runs in PowerShell. Never wrap it in `powershell -Command`.',
  '- Use real paths: $env:USERPROFILE, $HOME, $PWD. Never a placeholder like YourUsername.',
  '- One command, doing one thing. No extra pipeline stages that were not asked for.',
  '- Say in one line what it does, before the block.',
  '',
  'Use `wumpy-run-cmd` for cmd.exe and `wumpy-run-bash` for bash.',
  'Use an ordinary ```powershell block when only showing syntax, not asking to run it.'
].join('\n')

const BASE_PROMPT =
  'You are Wumpy, a local assistant in the Windows system tray. ' +
  'Answer the question directly and stop. ' +
  'Never open by restating the question or announcing what you are about to do, ' +
  'and never close by offering further help. ' +
  'No filler, no apologies, no hedging. ' +
  'Use markdown only where it earns its place, and fenced code blocks with a language tag.'

/**
 * The four thinking tiers.
 *
 * Models are chosen for a CPU-only machine, where the deciding factor is not
 * parameter count but whether the model reasons before speaking. Measured on a
 * Ryzen 7 7735U: llama3.2:3b reaches its first visible word in ~0.2s warm,
 * while qwen3:4b spends 20-70s on scratchpad first. So the quick tiers use a
 * non-reasoning model and the dev tiers buy depth with time.
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
    alternates: ['llama3.2:1b', 'qwen2.5:3b', 'phi3.5:3.8b'],
    thinking: false,
    tools: false,
    options: { num_ctx: 2048, num_predict: 384, temperature: 0.4, top_p: 0.9 },
    systemPrompt: `${BASE_PROMPT} One or two sentences. Nothing more.`
  },

  fast: {
    id: 'fast',
    label: 'Fast',
    blurb: 'Balanced. The everyday default.',
    mode: 'quick',
    speed: 'quick',
    model: 'llama3.2:3b',
    alternates: ['qwen2.5:3b', 'llama3.1:8b'],
    thinking: false,
    tools: false,
    options: { num_ctx: 4096, num_predict: 1024, temperature: 0.6, top_p: 0.9 },
    systemPrompt: `${BASE_PROMPT} A short paragraph, or a few bullets if the answer is genuinely a list.`
  },

  thinker: {
    id: 'thinker',
    label: 'Thinker',
    blurb: 'Reasons step by step. Can run commands.',
    mode: 'dev',
    speed: 'slow',
    model: 'qwen3:4b',
    alternates: ['qwen3:8b', 'deepseek-r1:7b'],
    thinking: true,
    tools: true,
    options: { num_ctx: 8192, num_predict: 2048, temperature: 0.6, top_p: 0.95 },
    systemPrompt: `${BASE_PROMPT} Reason it through privately, then give the conclusion briefly. State any assumption you had to make, in one line.`
  },

  deep: {
    id: 'deep',
    label: 'Deep Thinker',
    blurb: 'Most capable, slowest. Can run commands.',
    mode: 'dev',
    speed: 'slowest',
    model: 'qwen2.5-coder:14b',
    alternates: ['qwen3:8b', 'qwen3:4b'],
    thinking: false,
    tools: true,
    options: { num_ctx: 8192, num_predict: 4096, temperature: 0.3, top_p: 0.9 },
    systemPrompt:
      `${BASE_PROMPT} Be thorough where it matters and nowhere else. ` +
      'Prefer working code over prose about code. Name edge cases and failure modes, briefly.'
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
