/**
 * Builds the Linux desktop helper into resources/linux: the virtual-pointer
 * program (src/linux/wumpy-pointer.c) and the line-protocol helper that
 * drives it (src/linux/desktop.py). See src/main/linuxdesktop.ts.
 *
 * Needs gcc and wayland-scanner, which Omarchy has. Without them it says so
 * and the build carries on: Wumpy then looks at the screen but does not
 * click, and its prompt says exactly that.
 *
 * Run with: node scripts/build-linux-helper.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'linux') {
  console.log('skip: the Linux desktop helper is only built on Linux')
  process.exit(0)
}

const out = join(process.cwd(), 'resources', 'linux')
mkdirSync(out, { recursive: true })
copyFileSync('src/linux/desktop.py', join(out, 'desktop.py'))
chmodSync(join(out, 'desktop.py'), 0o755)

const xml = 'src/linux/wlr-virtual-pointer-unstable-v1.xml'
const work = mkdtempSync(join(tmpdir(), 'wumpy-pointer-'))
try {
  const header = join(work, 'wlr-virtual-pointer-unstable-v1-client-protocol.h')
  const glue = join(work, 'wlr-virtual-pointer-unstable-v1-protocol.c')
  execFileSync('wayland-scanner', ['client-header', xml, header])
  execFileSync('wayland-scanner', ['private-code', xml, glue])
  execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-I', work, 'src/linux/wumpy-pointer.c', glue, '-o', join(out, 'wumpy-pointer'), '-lwayland-client'], {
    stdio: 'inherit'
  })
  console.log('built resources/linux/wumpy-pointer and desktop.py')
} catch (err) {
  console.log(`note: the pointer helper was not built (${String(err.message).split('\n')[0]}). Wumpy will look but not click.`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
