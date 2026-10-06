import type { ChatMessage, OllamaModel, OllamaStatus } from '@shared/types'

interface OllamaChatChunk {
  message?: { content?: string; thinking?: string }
  done?: boolean
  eval_count?: number
  eval_duration?: number
  total_duration?: number
  error?: string
}

export interface StreamHandlers {
  onDelta(delta: { content?: string; thinking?: string }): void
  onDone(stats: { tokensPerSecond?: number; totalDurationMs?: number }): void
  onError(message: string): void
}

/**
 * Minimal Ollama client. Everything lives in the main process so the renderer
 * never needs network access and we keep a single place to cancel in-flight work.
 */
export class OllamaClient {
  private host: string
  /** Cache of `/api/show` capability lookups, keyed by model name. */
  private capabilities = new Map<string, string[]>()
  private inflight = new Map<string, AbortController>()

  constructor(host: string) {
    this.host = host.replace(/\/+$/, '')
  }

  setHost(host: string): void {
    const next = host.replace(/\/+$/, '')
    if (next !== this.host) {
      this.host = next
      this.capabilities.clear()
    }
  }

  async status(): Promise<OllamaStatus> {
    try {
      const res = await fetch(`${this.host}/api/version`, {
        signal: AbortSignal.timeout(2500)
      })
      if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` }
      const body = (await res.json()) as { version?: string }
      return { reachable: true, version: body.version }
    } catch (err) {
      return { reachable: false, error: describe(err) }
    }
  }

  async models(): Promise<OllamaModel[]> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return []
      const body = (await res.json()) as {
        models?: Array<{
          name: string
          size: number
          details?: { family?: string; parameter_size?: string }
        }>
      }
      return (body.models ?? []).map((m) => ({
        name: m.name,
        size: m.size,
        family: m.details?.family ?? 'unknown',
        parameterSize: m.details?.parameter_size ?? ''
      }))
    } catch {
      return []
    }
  }

  /**
   * Passing `think` to a model that cannot reason makes Ollama reject the whole
   * request, so we only send it once `/api/show` confirms the capability.
   */
  private async supportsThinking(model: string): Promise<boolean> {
    const cached = this.capabilities.get(model)
    if (cached) return cached.includes('thinking')
    try {
      const res = await fetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) return false
      const body = (await res.json()) as { capabilities?: string[] }
      const caps = body.capabilities ?? []
      this.capabilities.set(model, caps)
      return caps.includes('thinking')
    } catch {
      return false
    }
  }

  abort(requestId: string): void {
    this.inflight.get(requestId)?.abort()
    this.inflight.delete(requestId)
  }

  abortAll(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
  }

  async chat(
    requestId: string,
    model: string,
    messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
    opts: { thinking: boolean },
    handlers: StreamHandlers
  ): Promise<void> {
    const controller = new AbortController()
    this.inflight.set(requestId, controller)

    try {
      const payload: Record<string, unknown> = { model, messages, stream: true }

      // Only ever send `think: true`, never `think: false`.
      //
      // Measured against Ollama 0.35.1 + qwen3:4b: `think: false` makes the
      // model reason anyway and dump that reasoning into `message.content`
      // with a stray `</think>` terminator, for no token saving (47 vs 44
      // tokens). Omitting the field lets Ollama parse reasoning into the
      // separate `message.thinking` field and keeps `content` clean.
      //
      // So the setting controls whether reasoning is *shown*, not whether a
      // reasoning model reasons — that is the model's nature, not a flag.
      if (opts.thinking && (await this.supportsThinking(model))) payload.think = true

      const res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        handlers.onError(
          detail ? `Ollama returned ${res.status}: ${truncate(detail, 300)}` : `Ollama returned ${res.status}`
        )
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let stats: { tokensPerSecond?: number; totalDurationMs?: number } = {}

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Ollama streams newline-delimited JSON; the tail may be a partial line.
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let chunk: OllamaChatChunk
          try {
            chunk = JSON.parse(trimmed) as OllamaChatChunk
          } catch {
            continue
          }
          if (chunk.error) {
            handlers.onError(chunk.error)
            return
          }
          const content = chunk.message?.content
          const thinking = chunk.message?.thinking
          if (content || thinking) handlers.onDelta({ content, thinking })
          if (chunk.done) stats = readStats(chunk)
        }
      }

      handlers.onDone(stats)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        handlers.onDone({})
        return
      }
      handlers.onError(describe(err))
    } finally {
      this.inflight.delete(requestId)
    }
  }
}

function readStats(chunk: OllamaChatChunk): { tokensPerSecond?: number; totalDurationMs?: number } {
  const stats: { tokensPerSecond?: number; totalDurationMs?: number } = {}
  if (chunk.eval_count && chunk.eval_duration) {
    stats.tokensPerSecond = chunk.eval_count / (chunk.eval_duration / 1e9)
  }
  if (chunk.total_duration) stats.totalDurationMs = chunk.total_duration / 1e6
  return stats
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // The usual cause: Ollama simply is not running.
    if (/ECONNREFUSED|fetch failed/i.test(err.message)) {
      return 'Cannot reach Ollama. Is `ollama serve` running?'
    }
    if (err.name === 'TimeoutError') return 'Ollama did not respond in time.'
    return err.message
  }
  return String(err)
}
