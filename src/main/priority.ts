import { setPriority, constants, cpus } from 'node:os'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'

/**
 * Keeps Wumpy out of the model's way.
 *
 * Inference on this machine is CPU-bound and single-stream, so every core the
 * UI takes is a core not producing tokens. While a turn is generating, Wumpy's
 * own processes drop below normal priority: the scheduler then hands contested
 * time to Ollama, and the panel still repaints fine because it needs very
 * little. Priority is restored the moment the turn ends.
 */
export class PriorityManager {
  private lowered = false

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** Every process id Wumpy is responsible for. */
  private pids(): number[] {
    const ids = [process.pid]
    const wc = this.getWindow()?.webContents
    try {
      const pid = wc?.getOSProcessId()
      if (pid) ids.push(pid)
    } catch {
      // The renderer may be gone; its priority no longer matters.
    }
    // Child processes Electron owns, such as the GPU and utility processes.
    for (const metric of app.getAppMetrics()) {
      if (metric.pid && !ids.includes(metric.pid)) ids.push(metric.pid)
    }
    return ids
  }

  private apply(priority: number): void {
    for (const pid of this.pids()) {
      try {
        setPriority(pid, priority)
      } catch {
        // Not fatal: some pids are gone by the time we get here, and on a
        // locked-down machine setting priority can simply be refused.
      }
    }
  }

  /** Called when a turn starts. */
  yieldToModel(): void {
    // On a small machine, stepping aside would starve the UI rather than help.
    if (cpus().length < 4 || this.lowered) return
    this.lowered = true
    this.apply(constants.priority.PRIORITY_BELOW_NORMAL)
  }

  /** Called when a turn ends, aborts or fails. */
  restore(): void {
    if (!this.lowered) return
    this.lowered = false
    this.apply(constants.priority.PRIORITY_NORMAL)
  }
}
