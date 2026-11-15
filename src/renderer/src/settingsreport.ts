import type { WumpySettings } from '@shared/types'
import { SEARCH_ENGINES, isSearchEngine, DEFAULT_ENGINE } from '@shared/links'
import { DEFAULT_ORDERING, isOrdering, orderingSpec } from '@shared/order'
import { APP_WINDOW } from './appwindow'

/**
 * What Wumpy is set to, in one place.
 *
 * The reason this exists is a screenshot. Asked whether DuckDuckGo had been
 * chosen to advertise it, Wumpy said it opened whatever engine the user had
 * set - which was true, and the user had never heard of the setting. The
 * answer to "did you choose this for me" should not be a conversation.
 *
 * Thirty-one commands change something; the app never showed what any of
 * them are currently set to. The Ctrl+K palette lists what exists, `/usage`
 * says what has been spent, and this says what is on - which is the question
 * somebody actually has when they are surprised by what just happened.
 *
 * Every row names the command that changes it, and the panel renders a
 * command on its own as a button, so the sheet is also the controls. Two
 * rows name something else on purpose: approval has a key of its own and is
 * deliberately not clickable from an answer, and `/key` takes a secret.
 */
export interface SettingsRow {
  /** What it is, in the words somebody would use. */
  what: string
  /** What it is set to now. */
  now: string
  /** The command that changes it, or a key, or nothing. */
  change: string
}

const APPROVAL: Record<string, string> = {
  manual: 'every command waits for you',
  auto: 'read-only runs itself, changes ask',
  all: 'everything runs, nothing asks'
}

const onOff = (on: boolean): string => (on ? 'on' : 'off')

/**
 * The rows, in the order somebody would ask about them.
 *
 * The model first, because it decides every other answer; then the three
 * that change what happens without being asked - where a search goes, what
 * runs by itself, what the panel does. The preferences after that, because
 * nobody is surprised by them.
 */
export function settingsRows(
  settings: WumpySettings,
  model: string,
  pool?: { keys: number; ready: number } | null,
  /** What the background ranking is doing, in a few words. See rankSummary. */
  rank?: string
): SettingsRow[] {
  const engine = isSearchEngine(settings.searchEngine) ? settings.searchEngine : DEFAULT_ENGINE
  const order = isOrdering(settings.modelOrder) ? settings.modelOrder : DEFAULT_ORDERING
  return [
    { what: 'answering with', now: model, change: '`/model`' },
    {
      /* Directly under the model, because it is how the list that chooses
         the model is read - and because a #1 badge means something
         different on each tab, which is worth knowing before trusting
         one. */
      what: 'model list ranked by',
      now: orderingSpec(order).summary,
      change: '`/model`'
    },
    {
      what: 'searches open in',
      now: SEARCH_ENGINES[engine].label,
      change: '`/engine`'
    },
    {
      what: 'commands',
      now: APPROVAL[settings.approvalMode] ?? settings.approvalMode,
      /* Not a button, and not an oversight: a command named in an answer is
         clickable, and one click to "everything runs, nothing asks" is the
         whole permission model. Shift+Tab is the user's own hand. */
      change: 'Shift+Tab'
    },
    { what: 'panel', now: settings.dock, change: '`/dock`' },
    {
      what: 'stays on top',
      /* The stored setting is `hideOnBlur` and it is the opposite way round
         from the command, which is exactly the kind of thing a sheet like
         this exists to stop somebody having to work out. */
      now: onOff(!settings.hideOnBlur),
      change: '`/pin`'
    },
    { what: 'thinking first', now: onOff(settings.thinking), change: '`/think`' },
    { what: 'reasoning shown', now: onOff(settings.showReasoning), change: '`/reasoning`' },
    { what: 'dictation tidied up', now: onOff(settings.voicePolish), change: '`/polish`' },
    { what: 'dictation stops at a pause', now: onOff(settings.voiceAutoStop), change: '`/autostop`' },
    { what: 'music paused while talking', now: onOff(settings.pauseMusic ?? true), change: '`/music`' },
    { what: 'starts in the background at login', now: onOff(settings.launchAtLogin), change: '`/startup`' },
    {
      what: 'self-reflection',
      now: settings.reflect
        ? `on, up to ${settings.reflectRounds} reviews${settings.reflectModel ? ` by ${settings.reflectModel}` : ''}`
        : 'off',
      change: '`/reflect`'
    },
    {
      what: 'instructions',
      now: settings.leanPrompt ? 'short form' : 'full',
      change: '`/lean`'
    },
    {
      what: 'hourly re-ranking',
      /* The one thing in this sheet that spends a request by itself, so
         it says what it is doing rather than just on or off. */
      now: rank ?? 'off',
      change: '`/rank`'
    },
    {
      what: 'keys',
      /* The pool behind the model being answered with, not every key
         saved: a provider nothing is routed to is not what somebody
         checking their settings is asking about. */
      now: pool ? `${pool.ready} of ${pool.keys} ready` : 'none for this model',
      change: '`/key`'
    }
  ]
}

/** The sheet as `/settings` prints it. */
export function settingsLines(
  settings: WumpySettings,
  model: string,
  pool?: { keys: number; ready: number } | null,
  rank?: string
): string[] {
  return [
    '**What Wumpy is set to**',
    '',
    '| | now | change it |',
    '| --- | --- | --- |',
    ...settingsRows(settings, model, pool, rank)
      // The overlay's placement and pinning, which an app window does not have.
      .filter((r) => !(APP_WINDOW && /`\/(dock|pin)`/.test(r.change)))
      .map((r) => `| ${r.what} | ${r.now} | ${r.change} |`),
    '',
    '_Everything else is in Ctrl+K._'
  ]
}
