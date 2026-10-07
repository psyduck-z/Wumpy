/**
 * Walking back through what the user has typed, as a shell does.
 *
 * Pure and outside React so it can be tested as the thing that ships rather
 * than as a description of it: a hook's state only exists while something is
 * rendering, and a test that rebuilds the logic to check it is only testing
 * itself.
 */
export class HistoryWalk {
  /** Oldest first, the way it is stored. */
  private entries: string[] = []
  /** -1 means "not walking"; otherwise steps back from the newest, 0 = newest. */
  private cursor = -1
  /** What was in the box when the walk began. */
  private draft = ''

  constructor(entries: string[] = []) {
    this.entries = [...entries]
  }

  load(entries: string[]): void {
    this.entries = [...entries]
  }

  get browsing(): boolean {
    return this.cursor > -1
  }

  /** One step older. Null when there is nothing older to show. */
  older(current: string): string | null {
    if (this.entries.length === 0) return null
    if (this.cursor === -1) this.draft = current
    const next = Math.min(this.cursor + 1, this.entries.length - 1)
    if (next === this.cursor) return null
    this.cursor = next
    return this.entries[this.entries.length - 1 - next]
  }

  /** One step newer, ending at the draft. Null when already at the newest. */
  newer(): string | null {
    if (this.cursor <= -1) return null
    this.cursor -= 1
    if (this.cursor === -1) return this.draft
    return this.entries[this.entries.length - 1 - this.cursor]
  }

  reset(): void {
    this.cursor = -1
    this.draft = ''
  }

  /**
   * Records a submitted line and leaves the walk.
   *
   * A line already in the list moves to the end rather than being added again,
   * so asking the same thing twice does not mean pressing Up twice to get past
   * it.
   */
  push(text: string): void {
    this.reset()
    const entry = text.trim()
    if (!entry) return
    this.entries = [...this.entries.filter((e) => e !== entry), entry]
  }

  all(): string[] {
    return [...this.entries]
  }
}
