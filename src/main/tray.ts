import { Tray, Menu, nativeImage, app, shell } from 'electron'
import { join } from 'node:path'
import type { Panel } from './panel'
import type { SettingsStore } from './store'
import type { Dock, HotkeyState, TierStatus } from '@shared/types'
import { TIERS, TIER_ORDER, defaultTierFor, SPEED_LABEL } from '@shared/tiers'

export interface TrayDeps {
  panel: Panel
  settings: SettingsStore
  getHotkeyState(): HotkeyState
  getTierStatuses(): TierStatus[]
  onToggleLaunchAtLogin(enabled: boolean): void
}

/** Resolves a resource both in dev (repo root) and in a packaged build. */
export function resourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(app.getAppPath(), 'resources', file)
}

const DOCK_LABELS: Array<{ dock: Dock; label: string }> = [
  { dock: 'left', label: 'Left edge (tall)' },
  { dock: 'right', label: 'Right edge (tall)' },
  { dock: 'top-left', label: 'Top left (compact)' },
  { dock: 'top-right', label: 'Top right (compact)' },
  { dock: 'bottom-left', label: 'Bottom left (compact)' },
  { dock: 'bottom-right', label: 'Bottom right (compact)' }
]

export function createTray(deps: TrayDeps): Tray {
  const icon = nativeImage.createFromPath(resourcePath('tray.png'))
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)

  const render = (): void => {
    const { active, intercepted } = deps.getHotkeyState()
    const live = intercepted ?? active
    const settings = deps.settings.all()
    const statuses = deps.getTierStatuses()
    const byId = new Map(statuses.map((s) => [s.id, s]))

    tray.setToolTip(live ? `Wumpy — ${prettify(live)}` : 'Wumpy — no hotkey registered')

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: live ? `Open Wumpy  (${prettify(live)})` : 'Open Wumpy  (no hotkey)',
          click: () => deps.panel.show()
        },
        { type: 'separator' },

        {
          label: settings.mode === 'quick' ? 'Mode: Quick' : 'Mode: Developer',
          submenu: [
            {
              label: 'Quick  — Flash & Fast',
              type: 'radio',
              checked: settings.mode === 'quick',
              click: () => {
                deps.settings.patch({ mode: 'quick', tier: defaultTierFor('quick') })
                render()
              }
            },
            {
              label: 'Developer  — Thinker & Deep Thinker',
              type: 'radio',
              checked: settings.mode === 'dev',
              click: () => {
                deps.settings.patch({ mode: 'dev', tier: defaultTierFor('dev') })
                render()
              }
            }
          ]
        },
        {
          label: `Tier: ${TIERS[settings.tier]?.label ?? settings.tier}`,
          submenu: TIER_ORDER.map((id) => {
            const tier = TIERS[id]
            const status = byId.get(id)
            const suffix = !status?.installed
              ? '  (not installed)'
              : status.warm
                ? '  • warm'
                : ''
            return {
              label: `${tier.label}  — ${SPEED_LABEL[tier.speed]}${suffix}`,
              type: 'radio' as const,
              checked: settings.tier === id,
              enabled: status?.installed ?? false,
              click: () => {
                // Selecting a tier follows its mode, so the theme matches.
                deps.settings.patch({ tier: id, mode: tier.mode })
                render()
              }
            }
          })
        },
        {
          label: 'Position',
          submenu: DOCK_LABELS.map(({ dock, label }) => ({
            label,
            type: 'radio' as const,
            checked: settings.dock === dock,
            click: () => {
              deps.panel.setDock(dock)
              render()
            }
          }))
        },
        { type: 'separator' },

        {
          label: `Approval: ${
            settings.approvalMode === 'manual'
              ? 'ask every time'
              : settings.approvalMode === 'auto'
                ? 'run read-only'
                : 'run everything'
          }`,
          submenu: [
            {
              label: 'Ask every time',
              type: 'radio',
              checked: settings.approvalMode === 'manual',
              click: () => {
                deps.settings.patch({ approvalMode: 'manual' })
                render()
              }
            },
            {
              label: 'Run read-only commands, ask for the rest',
              type: 'radio',
              checked: settings.approvalMode === 'auto',
              click: () => {
                deps.settings.patch({ approvalMode: 'auto' })
                render()
              }
            },
            {
              label: 'Run everything',
              type: 'radio',
              checked: settings.approvalMode === 'all',
              click: () => {
                deps.settings.patch({ approvalMode: 'all' })
                render()
              }
            },
            { type: 'separator' },
            {
              label: 'Still confirm destructive commands',
              type: 'checkbox',
              checked: settings.confirmRisky,
              click: (item) => {
                deps.settings.patch({ confirmRisky: item.checked })
                render()
              }
            }
          ]
        },
        {
          label: 'Show reasoning',
          type: 'checkbox',
          checked: settings.showReasoning,
          click: (item) => {
            deps.settings.patch({ showReasoning: item.checked })
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
          label: 'Preload models at startup',
          type: 'checkbox',
          checked: settings.warmOnStart,
          click: (item) => {
            deps.settings.patch({ warmOnStart: item.checked })
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
          click: () => void shell.openPath(join(app.getPath('userData'), 'settings.json'))
        },
        {
          label: 'Open saved chats folder',
          click: () => void shell.openPath(join(app.getPath('userData'), 'chats'))
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
