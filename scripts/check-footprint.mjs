/**
 * Checks what Wumpy says it costs the machine.
 *
 * Asked for: "keep improving while watching the CPU usage of Wumpy and GPU
 * and memory". The watching should not need somebody with a terminal, so
 * `/usage` reports it - and a number about resources is the kind that gets
 * believed, which is the reason for most of these assertions.
 *
 * Three things have to stay true. The process names have to be the ones a
 * person would use, because "Browser" is Electron's word for the main
 * process and there is no browser here. An idle app has to read as idle
 * rather than as a figure that moves on its own. And the GPU claim has to
 * stay honest: Windows reports GPU time per engine, not per app, so nothing
 * here may print a share of it.
 *
 * Run with: npm run check:footprint
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.footprint-check.mjs')
await build({
  entryPoints: ['src/shared/footprint.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const F = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 48)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 48)} expected ${JSON.stringify(want)}`)
}

/* The shape Electron hands back, with the numbers measured on this machine
   on 22 Oct 2026: five processes, 189 MB, doing nothing. */
const IDLE = {
  processes: [
    { pid: 20468, type: 'GPU', memoryKb: 129024, cpuPercent: 0 },
    { pid: 22416, type: 'Tab', memoryKb: 107315, cpuPercent: 0 },
    { pid: 10452, type: 'Browser', memoryKb: 108032, cpuPercent: 0.07 },
    { pid: 16776, type: 'Utility', name: 'Network Service', memoryKb: 63795, cpuPercent: 0 }
  ],
  cores: 16,
  sampledMs: 500,
  upMs: 19 * 60 * 1000
}

/* ------------------------------------------------------- what each part is */

const named = IDLE.processes.map((p) => F.partName(p))
check('Electron’s words become Wumpy’s', named, [
  'graphics',
  'the panel',
  'the app',
  'network service'
])
check('and an unnamed utility is a helper', F.partName({ type: 'Utility', name: 'Utility' }), 'helper')

/* --------------------------------------------------------------- the sizes */

check('megabytes, rounded once it is big', F.mb(129024), '126 MB')
check('and to a place while it is small', F.mb(23040), '22.5 MB')
check('the total is every process', F.mb(F.totalMemoryKb(IDLE)), '399 MB')

check('minutes while it is new', F.upFor(19 * 60 * 1000), '19 min')
check('hours after that', F.upFor(5.5 * 3600 * 1000), '5.5 h')
check('and days once it has been left alone', F.upFor(72 * 3600 * 1000), '3 days')

/* ------------------------------------------------------------- idle is idle */

/*
 * A tray app doing nothing measures as a few hundredths of a core, and the
 * hundredths are noise - the same idle Wumpy read 0.00% and 0.07% on
 * consecutive samples while this was being written. A number that moves
 * while nothing changes invites a question that has no answer.
 */
{
  const lines = F.footprintLines(IDLE).join('\n')
  check('an idle app says so', lines.includes('idle'), true)
  check('rather than a number that moves', lines.includes('0.1% of one core'), false)
  check('and a quiet process gets a dash', lines.includes('| the app | 106 MB | — |'), true)
}

/* And a busy one gets the figure, against one core and against the machine. */
{
  const busy = {
    ...IDLE,
    processes: IDLE.processes.map((p) => (p.type === 'Tab' ? { ...p, cpuPercent: 31.5 } : p))
  }
  const lines = F.footprintLines(busy).join('\n')
  check('a busy one gets the number', lines.includes('31.6% of one core'), true)
  check('and what that is of the machine', lines.includes('(2.0% of the machine)'), true)
  check('with the process named', lines.includes('| the panel | 105 MB | 31.5% |'), true)
}

/* ------------------------------------------------------- the honest footnote */

{
  const lines = F.footprintLines(IDLE).join('\n')
  check('it says working set, not private', lines.includes('Working set'), true)
  /* 399 MB of working set against 189 MB of private bytes, measured on the
     same five processes. Printing the bigger number without saying what it
     includes is how a tray app gets accused of eating half a gigabyte. */
  check('and that the total is an upper bound', lines.includes('upper bound'), true)
  check('it says how long it watched for', lines.includes('0.5s'), true)
  /* The one claim that would be a lie. Chromium does not hand GPU
     utilisation to the app and Windows reports it per engine, so the
     graphics process is counted by memory and CPU like every other. */
  check('and it claims no share of the GPU', /\d+(\.\d+)?% of (the )?GPU/i.test(lines), false)
  check('while saying why there is none', lines.includes('per engine rather than'), true)
}

check('nothing to report is no report', F.footprintLines({ ...IDLE, processes: [] }), [])

console.log(failed === 0 ? '\nall footprint checks correct' : `\n${failed} footprint checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
