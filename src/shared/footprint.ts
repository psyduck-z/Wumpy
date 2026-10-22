/**
 * What Wumpy costs the machine it sits on.
 *
 * Asked for in those words - "watch the CPU usage of Wumpy and GPU and
 * memory" - and it is a fair question of a thing that launches at login and
 * is never closed. Before this the only way to answer it was Task Manager,
 * where Wumpy is five rows called "Electron" among whatever else is running.
 *
 * WHAT THE NUMBERS ARE. Electron hands back one entry per process, with its
 * working set in kilobytes and the share of a core it used since the last
 * time it was asked. Working set is what Windows counts as resident - the
 * number Task Manager shows - and it is bigger than what Wumpy alone is
 * holding, because the runtime's own pages are shared with every other
 * Chromium on the machine.
 *
 * AND WHAT THEY ARE NOT. There is no GPU utilisation here. Chromium does not
 * hand it to the app, and Windows reports it per engine rather than per
 * process, so the honest thing is to report the graphics process the same
 * way as the others - by what it costs in memory and CPU - and to leave the
 * percentage to the one tool that can see it.
 */

/** One process, as Electron reports it. */
export interface ProcessCost {
  pid: number
  /** Electron's own word: Browser, Tab, GPU, Utility. */
  type: string
  /** Utility processes say what they are; nothing else does. */
  name?: string
  /** Working set, in kilobytes, which is what Electron hands back. */
  memoryKb: number
  /** Share of ONE core since the previous sample, as a percentage. */
  cpuPercent: number
}

export interface Footprint {
  processes: ProcessCost[]
  /** Logical cores, so a share of one can be put against the machine. */
  cores: number
  /** How long the sample ran, in milliseconds. */
  sampledMs: number
  /** Milliseconds since the main process started. */
  upMs: number
}

/**
 * The plain-English name for a process type.
 *
 * "Browser" is Electron's word for the main process and means nothing to
 * anybody here - there is no browser. The names are what the thing does:
 * the panel you look at, the part that talks to models, the one that draws.
 */
export function partName(cost: ProcessCost): string {
  if (cost.type === 'Browser') return 'the app'
  if (cost.type === 'Tab') return 'the panel'
  if (cost.type === 'GPU') return 'graphics'
  if (cost.name && cost.name !== 'Utility') return cost.name.toLowerCase()
  return 'helper'
}

/** Megabytes, to one place while it is small enough for that to mean anything. */
export function mb(kb: number): string {
  const megs = kb / 1024
  return megs >= 100 ? `${Math.round(megs)} MB` : `${megs.toFixed(1)} MB`
}

/** A duration a person would say out loud. */
export function upFor(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`
  return `${Math.round(hours / 24)} days`
}

export function totalMemoryKb(f: Footprint): number {
  return f.processes.reduce((n, p) => n + p.memoryKb, 0)
}

export function totalCpuPercent(f: Footprint): number {
  return f.processes.reduce((n, p) => n + p.cpuPercent, 0)
}

/**
 * Below this, say it is idle rather than print a number.
 *
 * A tray app that is doing nothing measures as a few hundredths of a core,
 * and the hundredths are noise: the same idle Wumpy reads 0.00% and 0.07%
 * on consecutive samples depending on whether a timer happened to fire. A
 * number that moves while nothing changes is worse than a word.
 */
export const IDLE_PERCENT = 0.5

/**
 * The report, as the lines `/usage` prints.
 *
 * One sentence first, because "is this thing eating my machine" is a
 * yes-or-no question and the answer is a size and a share. The table is for
 * the follow-up, which is always "what are all those processes".
 */
export function footprintLines(f: Footprint): string[] {
  if (!f.processes.length) return []

  const memory = mb(totalMemoryKb(f))
  const cpu = totalCpuPercent(f)
  const share =
    cpu < IDLE_PERCENT
      ? 'idle'
      : `${cpu.toFixed(1)}% of one core (${(cpu / Math.max(1, f.cores)).toFixed(1)}% of the machine)`

  const ordered = [...f.processes].sort((a, b) => b.memoryKb - a.memoryKb)
  const rows = ordered.map(
    (p) =>
      `| ${partName(p)} | ${mb(p.memoryKb)} | ` +
      `${p.cpuPercent < IDLE_PERCENT ? '—' : `${p.cpuPercent.toFixed(1)}%`} |`
  )

  return [
    `**Wumpy itself** — ${memory} across ${f.processes.length} process` +
      `${f.processes.length === 1 ? '' : 'es'}, ${share}, up ${upFor(f.upMs)}`,
    '',
    '| part | memory | cpu |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `_Working set, which is what Task Manager adds up, and the share of one ` +
      `core over ${(f.sampledMs / 1000).toFixed(1)}s. These processes share ` +
      `pages with each other and with every other Chromium on the machine, so ` +
      `the total is an upper bound: what is Wumpy's alone is about half of it. ` +
      `Graphics is counted by memory and CPU like the rest — Windows reports ` +
      `GPU time per engine rather than per app, so nothing can honestly print ` +
      `Wumpy's share of it._`
  ]
}
