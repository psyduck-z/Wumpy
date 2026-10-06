import { globalShortcut } from 'electron'
import type { HotkeyState } from '@shared/types'

/**
 * Registers the first accelerator the OS is willing to give us.
 *
 * Win+C is the goal, but the shell keeps it while Copilot is enabled and
 * `register` silently fails in that case — hence the ordered candidate list and
 * the reported state so the UI can tell the user which key actually works.
 */
export function registerHotkeys(candidates: string[], onTrigger: () => void): HotkeyState {
  globalShortcut.unregisterAll()

  const failed: string[] = []
  for (const accelerator of candidates) {
    try {
      const ok = globalShortcut.register(accelerator, onTrigger)
      // `register` can return true yet not actually own the key on Windows.
      if (ok && globalShortcut.isRegistered(accelerator)) {
        return { active: accelerator, failed, intercepted: null }
      }
      failed.push(accelerator)
      globalShortcut.unregister(accelerator)
    } catch {
      failed.push(accelerator)
    }
  }

  return { active: null, failed, intercepted: null }
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}
