/**
 * Installs the Linux build for the current user, Omarchy style: the app in
 * ~/.local/share/wumpy, a `wumpy` command in ~/.local/bin, a launcher entry
 * and its icon. Run after `npm run package:linux` (or `npm run install:linux`,
 * which does both). Nothing here needs root.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const built = join(process.cwd(), 'dist', 'linux-unpacked')
if (!existsSync(join(built, 'wumpy'))) {
  console.error('No Linux build in dist/linux-unpacked. Run npm run package:linux first.')
  process.exit(1)
}

const appDir = join(home, '.local', 'share', 'wumpy', 'app')
rmSync(appDir, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })
cpSync(built, appDir, { recursive: true })
console.log(`app      -> ${appDir}`)

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
