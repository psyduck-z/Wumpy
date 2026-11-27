/**
 * Chat, Skills, Settings - along the top, under the header.
 *
 * "It's kind of annoying to use slash commands, because that's only for
 * chats... if I wanted to do settings, it could be in another tab, and like
 * in settings you can see the devices you're paired with." Every command
 * still works; the tabs are the same things with something to click.
 */
export type Tab = 'chat' | 'skills' | 'settings'

export const TABS: Array<{ id: Tab; label: string; key: string }> = [
  { id: 'chat', label: 'Chat', key: 'Ctrl+1' },
  { id: 'skills', label: 'Skills', key: 'Ctrl+2' },
  { id: 'settings', label: 'Settings', key: 'Ctrl+3' }
]

export function Tabs({ tab, onTab, busy }: { tab: Tab; onTab(t: Tab): void; busy: boolean }): React.JSX.Element {
  return (
    <nav className="tabs" role="tablist" aria-label="Wumpy">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={`tab ${tab === t.id ? 'is-on' : ''}`}
          onClick={() => onTab(t.id)}
          title={`${t.label} (${t.key})`}
        >
          {t.label}
          {/* An answer still being written, seen from another tab. */}
          {t.id === 'chat' && busy && tab !== 'chat' && <i className="tab-dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  )
}
