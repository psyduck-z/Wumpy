import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { checkSource, installFromSource, whatsNew, type SourceCheck } from './sourceupdate'

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
 * Downloads are Windows only, and only an installed build. The Linux build is
 * installed from the source by scripts/install-linux.mjs, so on Linux the
 * same 30-minute check looks at the source folder instead (sourceupdate.ts),
 * and `/update` builds and installs from it. A dev run has nothing to update.
 *
 * Every 30 minutes, not every hour: "make the auto and model check happen
 * every 30 minutes".
 */

export const EVERY_MS = 30 * 60 * 1000
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

/** Looks now: on start, every 30 minutes, and from the panel. */
export function checkForUpdate(): void {
  if (linux) {
    void checkLinux()
    return
  }
  if (!deps || state.stage === 'downloading' || state.stage === 'ready') return
  set({ stage: 'checking' })
  autoUpdater.checkForUpdates().catch((err) => {
    deps?.log(`[update] could not check: ${failed(err)}`)
    set({ stage: 'failed', checkedAt: Date.now() })
  })
}

/** On Linux the check is of the source folder, and nothing downloads. */
let linux = false

/** The last look at the source, for the background build to act on. */
let lastLinux: SourceCheck | null = null
/** A background build that failed is not retried until something new arrives, or /update. */
let failedFor = ''
const stateOf = (c: SourceCheck): string => `${c.behind}:${c.installedAt}:${c.edited}`

async function checkLinux(): Promise<void> {
  if (!deps || state.stage === 'installing' || state.stage === 'checking' || state.stage === 'ready') return
  set({ stage: 'checking' })
  try {
    const c = await checkSource()
    if (!c.source) {
      set({ stage: 'failed', about: 'the source folder could not be found', checkedAt: Date.now() })
      return
    }
    const about = whatsNew(c)
    if (about) deps.log(`[update] an update is available: ${about}${c.dirty ? ' (uncommitted changes: not building it by itself)' : ''}`)
    lastLinux = c
    set({ stage: about ? 'available' : 'current', about: about || undefined, checkedAt: Date.now() })
  } catch (err) {
    deps.log(`[update] could not check: ${failed(err)}`)
    set({ stage: 'failed', checkedAt: Date.now() })
  }
}

/**
 * UPDATES IN THE BACKGROUND, on Linux too: "allow Wumpy to update in the
 * background and not pop up every time it updates". An update found by the
 * 30-minute check is built and installed while nobody is using Wumpy, and
 * Wumpy restarts into it the same way - quietly, staying in the tray if it
 * was in the tray.
 *
 * Except from a source folder with uncommitted changes: that is work in
 * progress, and installing it by itself is how a half-made change ends up
 * running. Those wait for /update, and the header says one is there.
 */
async function buildInBackground(d: UpdateDeps): Promise<void> {
  const c = lastLinux
  if (state.stage !== 'available' || !c?.source || c.dirty || !d.idle() || failedFor === stateOf(c)) return
  const about = whatsNew(c)
  d.log(`[update] building ${about} in the background`)
  set({ stage: 'installing', about })
  const result = await installFromSource(c, d.log)
  if (!result.ok) {
    failedFor = stateOf(c)
    d.log(`[update] background build failed; left as it was until /update: ${result.message.slice(0, 300)}`)
    set({ stage: 'available', about, checkedAt: Date.now() })
    return
  }
  /* 'ready', as a Windows download is: restarted into once nobody is using Wumpy. */
  set({ stage: 'ready', next: 'the new build', about, checkedAt: Date.now() })
}

function startLinuxUpdates(d: UpdateDeps): void {
  deps = d
  linux = true
  set({ stage: 'current' })
  setTimeout(() => void checkLinux(), 60_000).unref?.()
  setInterval(() => void checkLinux(), EVERY_MS).unref?.()
  setInterval(() => {
    if (state.stage === 'available') void buildInBackground(d)
    else if (state.stage === 'ready' && d.idle()) d.restart('to start the updated Wumpy while nobody is using it')
  }, LOOK_EVERY_MS).unref?.()
}

/**
 * `/update`: update now, if there is anything to update to.
 *
 * Windows: restart into a downloaded update, or look for one. Linux: pull,
 * build and install from the source folder, then restart into it. `force`
 * rebuilds on Linux even when nothing looks new.
 */
export async function updateNow(force = false): Promise<{ ok: boolean; message: string }> {
  if (!app.isPackaged) {
    return {
      ok: false,
      message: 'Running from source — **/restart** picks up a fresh build.'
    }
  }
  if (!deps) return { ok: false, message: 'Updating is not set up on this system.' }
  if (!linux) {
    if (state.stage === 'ready') {
      deps.restart(`to install Wumpy ${state.next}`)
      return { ok: true, message: `Restarting into Wumpy ${state.next}.` }
    }
    if (state.stage === 'downloading') {
      return {
        ok: true,
        message: `Downloading ${state.next} (${state.percent ?? 0}%).`
      }
    }
    checkForUpdate()
    return {
      ok: true,
      message: `Checking for a newer version than ${state.current}.`
    }
  }
  if (state.stage === 'installing') return { ok: false, message: 'Already updating.' }
  if (state.stage === 'ready') {
    deps.restart('to start the updated Wumpy')
    return { ok: true, message: 'Restarting into the update.' }
  }
  failedFor = ''
  set({ stage: 'checking' })
  const c = await checkSource().catch(() => null)
  if (!c?.source) {
    set({ stage: 'failed', checkedAt: Date.now() })
    return {
      ok: false,
      message: 'Source folder not found — run `npm run install:linux` in it once.'
    }
  }
  const about = whatsNew(c)
  if (!about && !force) {
    set({ stage: 'current', about: undefined, checkedAt: Date.now() })
    return { ok: true, message: 'Up to date.' }
  }
  set({ stage: 'installing', about: about || 'a rebuild', checkedAt: Date.now() })
  const result = await installFromSource(c, deps.log)
  if (!result.ok) {
    set({ stage: 'failed', checkedAt: Date.now() })
    return result
  }
  set({ stage: 'current', about: undefined })
  deps.restart('to start the updated Wumpy')
  return { ok: true, message: 'Updated. Restarting.' }
}

export function startUpdates(d: UpdateDeps): void {
  if (deps || !app.isPackaged) return
  if (process.platform === 'linux') {
    startLinuxUpdates(d)
    return
  }
  if (process.platform !== 'win32') return
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
  if (linux || state.stage !== 'ready') return false
  log(`[update] restarting into ${state.next}`)
  autoUpdater.quitAndInstall(true, true)
  return true
}
