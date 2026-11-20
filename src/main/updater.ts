import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Keeps an installed Wumpy on Windows up to date with what is built here.
 *
 * Asked for: "I'm not going to be developing it on the other device. It's
 * going to be updating on the device as we develop it on this device." Every
 * push to main builds the installer on GitHub's Windows machine and publishes
 * it as a numbered release (see .github/workflows/windows.yml). This looks
 * for a newer one at startup and every hour, downloads it quietly, and
 * installs it the next time Wumpy quits or restarts - never in the middle of
 * an answer.
 *
 * Windows only, and only an installed build: the Linux build on this laptop
 * is installed from the source by scripts/install-linux.mjs, and a dev run
 * has no release to compare itself with.
 */

const EVERY_MS = 60 * 60 * 1000

let started = false
let downloaded: string | null = null

export function startUpdates(log: (line: string) => void): void {
  if (started || process.platform !== 'win32' || !app.isPackaged) return
  started = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  /* Its own logger would write a second log nobody reads; this one is
     wumpy.log, which is where anyone looks. */
  autoUpdater.logger = null
  autoUpdater.on('update-available', (info) => log(`[update] ${info.version} is out; downloading it`))
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version
    log(`[update] ${info.version} downloaded; it installs the next time Wumpy restarts`)
  })
  autoUpdater.on('update-not-available', (info) => log(`[update] up to date (${info.version})`))
  autoUpdater.on('error', (err) => log(`[update] could not check: ${String(err?.message ?? err).slice(0, 200)}`))
  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => log(`[update] could not check: ${String(err?.message ?? err).slice(0, 200)}`))
  }
  /* A minute in, not at once: startup is busy enough. */
  setTimeout(check, 60_000).unref?.()
  setInterval(check, EVERY_MS).unref?.()
}

/**
 * A restart with an update waiting: the installer runs silently and starts
 * the new version itself. True when it has taken over the restart.
 *
 * Not app.relaunch: that starts the old copy while the installer is
 * replacing its files.
 */
export function restartIntoUpdate(log: (line: string) => void): boolean {
  if (!downloaded) return false
  log(`[update] restarting into ${downloaded}`)
  autoUpdater.quitAndInstall(true, true)
  return true
}
