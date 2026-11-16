/**
 * The path to start Wumpy by, given the one this copy is running from.
 *
 * The Linux install keeps each version in a folder of its own and `app` as a
 * link to the newest (see scripts/install-linux.mjs). The running copy's own
 * path - process.execPath, which the system resolves through the link - is
 * its versioned folder: the next install leaves it behind and the one after
 * deletes it. Restarting by it after an install would start the old version
 * again, and an autostart entry written with it would stop working two
 * installs later. So whatever starts Wumpy goes through the link instead,
 * when there is one.
 */
export function launchPath(exec: string, exists: (path: string) => boolean): string {
  const m = /^(.*)\/app-\d+\/([^/]+)$/.exec(exec)
  if (!m) return exec
  const stable = `${m[1]}/app/${m[2]}`
  return exists(stable) ? stable : exec
}
