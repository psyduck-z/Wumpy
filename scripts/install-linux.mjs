/**
 * Installs the Linux build for the current user, Omarchy style: the app in
 * ~/.local/share/wumpy, a `wumpy` command in ~/.local/bin, a launcher entry
 * and its icon. Run after `npm run package:linux` (or `npm run install:linux`,
 * which does both). Nothing here needs root.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const home = homedir()
const built = join(process.cwd(), 'dist', 'linux-unpacked')
if (!existsSync(join(built, 'wumpy'))) {
  console.error('No Linux build in dist/linux-unpacked. Run npm run package:linux first.')
  process.exit(1)
}

/*
 * Each version in a folder of its own, and `app` a link switched to the new
 * one in a single step.
 *
 * This used to delete `app` and copy the new build into it, file by file.
 * Wumpy is started again every time the earbuds are pinched (`wumpy --voice`,
 * a few milliseconds, to hand the pinch to the running copy) - and a pinch
 * that landed during an install started a binary whose resources were half
 * copied: two crash reports, SIGTRAP, at the second the install ran. Now a
 * start sees the old version or the new one, whole, never neither. The copy
 * that is running keeps its own folder until the next install, since it
 * still reads from it.
 */
const root = join(home, '.local', 'share', 'wumpy')
const appDir = join(root, 'app')
const stamp = Date.now()
const fresh = join(root, `app-${stamp}`)
mkdirSync(root, { recursive: true })
cpSync(built, fresh, { recursive: true })
let previous = null
if (existsSync(appDir) || lstatExists(appDir)) {
  if (lstatSync(appDir).isSymbolicLink()) previous = readlinkSync(appDir)
  else {
    // Installed before versions had folders: moved aside once, the only
    // moment `app` is briefly missing.
    previous = join(root, `app-${stamp - 1}`)
    renameSync(appDir, previous)
  }
}
const link = join(root, `app.link-${stamp}`)
symlinkSync(fresh, link)
renameSync(link, appDir)
/* Folders a running Wumpy was started from stay too: two installs with no
   restart between them would otherwise delete the one still in use. */
const inUse = new Set()
for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
  try {
    inUse.add(dirname(readlinkSync(join('/proc', pid, 'exe'))))
  } catch {
    /* gone, or not ours to read */
  }
}
for (const name of readdirSync(root)) {
  const path = join(root, name)
  if (/^app-\d+$/.test(name) && path !== fresh && path !== previous && !inUse.has(path)) rmSync(path, { recursive: true, force: true })
}
console.log(`app      -> ${appDir} (${fresh})`)
/* Where it was built from, so the installed copy's /update can build again
   from the same folder (src/main/sourceupdate.ts). */
writeFileSync(join(root, 'source.txt'), process.cwd())

function lstatExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const bin = join(home, '.local', 'bin', 'wumpy')
mkdirSync(join(home, '.local', 'bin'), { recursive: true })
writeFileSync(bin, `#!/bin/sh\nexec "${join(appDir, 'wumpy')}" "$@"\n`)
chmodSync(bin, 0o755)
console.log(`command  -> ${bin}`)

const icons = join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps')
mkdirSync(icons, { recursive: true })
copyFileSync(join(process.cwd(), 'resources', 'icon.png'), join(icons, 'wumpy.png'))

const desktop = join(home, '.local', 'share', 'applications', 'wumpy.desktop')
mkdirSync(join(home, '.local', 'share', 'applications'), { recursive: true })
writeFileSync(
  desktop,
  [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Wumpy',
    'Comment=An AI in the tray that can answer, and act on this computer',
    `Exec=${bin} %U`,
    'Icon=wumpy',
    'Categories=Utility;',
    'StartupWMClass=Wumpy',
    ''
  ].join('\n')
)
console.log(`launcher -> ${desktop}`)
console.log('\nStart it with: wumpy   (wumpy --toggle opens the panel, wumpy --voice talks)')
