import type { Tier, TierId, Mode } from './types'

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
    options: { num_ctx: 4096, num_predict: 1024, temperature: 0.6, top_p: 0.9 },
    systemPrompt: `${BASE_PROMPT} A short paragraph, or a few bullets if the answer is genuinely a list.`
  },

  thinker: {
    id: 'thinker',
    label: 'Thinker',
    blurb: 'Reasons step by step before answering.',
    mode: 'dev',
    speed: 'slow',
    model: 'qwen3:4b',
    alternates: ['qwen3:8b', 'deepseek-r1:7b'],
    thinking: true,
    options: { num_ctx: 8192, num_predict: 2048, temperature: 0.6, top_p: 0.95 },
    systemPrompt: `${BASE_PROMPT} Reason it through privately, then give the conclusion briefly. State any assumption you had to make, in one line.`
  },

  deep: {
    id: 'deep',
    label: 'Deep Thinker',
    blurb: 'Most capable, slowest. Worth it for real code.',
    mode: 'dev',
    speed: 'slowest',
    model: 'qwen2.5-coder:14b',
    alternates: ['qwen3:8b', 'qwen3:4b'],
    thinking: false,
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
