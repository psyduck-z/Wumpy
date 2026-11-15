/**
 * Whether Wumpy is an ordinary app window here, rather than a summoned panel.
 *
 * On Windows the panel is an overlay: always on top, docked to a side of the
 * screen, gone when you click away - so it has a dock button, a pin, Ctrl+D,
 * Ctrl+P and an Esc that closes it. On Omarchy it is a normal window that
 * Hyprland tiles (see REGULAR_WINDOW in main/panel.ts), and none of those
 * mean anything: the compositor decides where windows go and nothing floats.
 * They are left out there rather than shown doing nothing. The tray stays.
 *
 * Read defensively because the checks in scripts/ load the renderer's
 * modules in Node, where there is no window - and there the full,
 * Windows-shaped set is what they test.
 */
const platform: string | undefined =
  typeof window !== 'undefined'
    ? (window as { wumpy?: { platform?: string } }).wumpy?.platform
    : undefined

export const ON_LINUX = platform === 'linux'

/** Ordinary app window: no docking, no pinning, Esc does not close it. */
export const APP_WINDOW = ON_LINUX

/** Commands that only mean something for the overlay panel. */
export const PANEL_ONLY_COMMANDS: ReadonlySet<string> = new Set(['dock', 'pin'])
