import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Keeps an installed Wumpy on Windows up to date with what is built here.
 *
 * Asked for: "I'm not going to be developing it on the other device. It's
 * going to be updating on the device as we develop it on this device." Every
 * push to main builds the installer on GitHub's Windows machine and publishes
 * it as a numbered release (see .github/workflows/windows.yml). This looks
 * for a newer one at startup and every hour and downloads it quietly.
 *
 * Then, asked for "an auto updater like directly in Wumpy": it used to wait
 * for Wumpy to quit, which a tray app almost never does, and said nothing
 * anywhere but the log. Now the panel shows it - a pill in the header while it
 * downloads and once it is ready, which restarts into it - and it installs
 * itself when nobody is using Wumpy: the same idle the key tester waits for
 * (no answer, no agent, the panel away, ten quiet minutes). Never in the
 * middle of an answer.
 *
 * Windows only, and only an installed build: the Linux build on this laptop
 * is installed from the source by scripts/install-linux.mjs, and a dev run
 * has no release to compare itself with.
 */

const EVERY_MS = 60 * 60 * 1000
const LOOK_EVERY_MS = 60 * 1000

export interface UpdateDeps {
  log(line: string): void
  /** The panel is told each time this changes. */
  changed(state: UpdateState): void
  /** Nobody is using Wumpy, and has not for a while. */
  idle(): boolean
  /** A restart that saves the chat first, and then lands in restartIntoUpdate. */
  restart(why: string): void
}

let deps: UpdateDeps | null = null
let state: UpdateState = { stage: 'off', current: app.getVersion() }

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  deps?.changed(state)
}

export function updateState(): UpdateState {
  return state
}

const failed = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 200)

/** Looks now: on start, every hour, and from the panel. */
export function checkForUpdate(): void {
  if (!deps || state.stage === 'downloading' || state.stage === 'ready') return
  set({ stage: 'checking' })
  autoUpdater.checkForUpdates().catch((err) => {
    deps?.log(`[update] could not check: ${failed(err)}`)
    set({ stage: 'failed', checkedAt: Date.now() })
  })
}

export function startUpdates(d: UpdateDeps): void {
  if (deps || process.platform !== 'win32' || !app.isPackaged) return
  deps = d
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  /* Its own logger would write a second log nobody reads; this one is
     wumpy.log, which is where anyone looks. */
  autoUpdater.logger = null
  autoUpdater.on('update-available', (info) => {
    d.log(`[update] ${info.version} is out; downloading it`)
    set({ stage: 'downloading', next: info.version, percent: 0, checkedAt: Date.now() })
  })
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent)
    if (percent !== state.percent) set({ percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    d.log(`[update] ${info.version} downloaded; it installs at the next restart, or once Wumpy is idle`)
    set({ stage: 'ready', next: info.version, percent: 100 })
  })
  autoUpdater.on('update-not-available', (info) => {
    d.log(`[update] up to date (${info.version})`)
    set({ stage: 'current', next: undefined, checkedAt: Date.now() })
  })
  autoUpdater.on('error', (err) => {
    d.log(`[update] could not check: ${failed(err)}`)
    /* A download that failed is looked for again at the next check. */
    if (state.stage !== 'ready') set({ stage: 'failed', checkedAt: Date.now() })
  })
  set({ stage: 'current' })
  /* A minute in, not at once: startup is busy enough. */
  setTimeout(checkForUpdate, 60_000).unref?.()
  setInterval(checkForUpdate, EVERY_MS).unref?.()
  setInterval(() => {
    if (state.stage === 'ready' && d.idle()) d.restart(`to install Wumpy ${state.next} while nobody is using it`)
  }, LOOK_EVERY_MS).unref?.()
}

/**
 * A restart with an update waiting: the installer runs silently and starts
 * the new version itself. True when it has taken over the restart.
 *
 * Not app.relaunch: that starts the old copy while the installer is
 * replacing its files.
 */
export function restartIntoUpdate(log: (line: string) => void): boolean {
  if (state.stage !== 'ready') return false
  log(`[update] restarting into ${state.next}`)
  autoUpdater.quitAndInstall(true, true)
  return true
}
