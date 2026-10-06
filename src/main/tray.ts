import { Tray, Menu, nativeImage, app, shell } from 'electron'
import { join } from 'node:path'
import type { Panel } from './panel'
import type { SettingsStore } from './store'
import type { HotkeyState } from '@shared/types'

export interface TrayDeps {
  panel: Panel
  settings: SettingsStore
  getHotkeyState(): HotkeyState
  onToggleLaunchAtLogin(enabled: boolean): void
}

/** Resolves a resource both in dev (repo root) and in a packaged build. */
export function resourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(app.getAppPath(), 'resources', file)
}

export function createTray(deps: TrayDeps): Tray {
  const icon = nativeImage.createFromPath(resourcePath('tray.png'))
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)

  const render = (): void => {
    const { active, intercepted } = deps.getHotkeyState()
    const live = intercepted ?? active
    const settings = deps.settings.all()

    tray.setToolTip(live ? `Wumpy — ${prettify(live)}` : 'Wumpy — no hotkey registered')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: live ? `Open Wumpy  (${prettify(live)})` : 'Open Wumpy  (no hotkey)',
          click: () => deps.panel.show()
        },
        { type: 'separator' },
        {
          label: `Model: ${settings.chatModel}`,
          enabled: false
        },
        {
          label: 'Thinking mode',
          type: 'checkbox',
          checked: settings.thinking,
          click: (item) => {
            deps.settings.patch({ thinking: item.checked })
            render()
          }
        },
        {
          label: 'Hide when it loses focus',
          type: 'checkbox',
          checked: settings.hideOnBlur,
          click: (item) => {
            deps.settings.patch({ hideOnBlur: item.checked })
            render()
          }
        },
        {
          label: 'Start Wumpy at login',
          type: 'checkbox',
          checked: settings.launchAtLogin,
          click: (item) => {
            deps.settings.patch({ launchAtLogin: item.checked })
            deps.onToggleLaunchAtLogin(item.checked)
            render()
          }
        },
        { type: 'separator' },
        {
          label: 'Open settings file',
          click: () => {
            void shell.openPath(join(app.getPath('userData'), 'settings.json'))
          }
        },
        { type: 'separator' },
        { label: 'Quit Wumpy', click: () => app.quit() }
      ])
    )
  }

  render()
  // Left click is the fast path; the menu stays on right click.
  tray.on('click', () => deps.panel.toggle())

  return Object.assign(tray, { refresh: render }) as Tray & { refresh(): void }
}

/** Turns an Electron accelerator into something a human recognises. */
export function prettify(accelerator: string): string {
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, 'Win').replace(/\+/g, ' + ')
}
