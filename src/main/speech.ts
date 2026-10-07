import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { resourcePath } from './tray'
import type { VoiceStatus, Transcript } from '@shared/types'
import { WHISPER_MODEL } from '@shared/dictation'

/**
 * Drives the local transcriber.
 *
 * Wumpy does not send audio anywhere. The browser's own SpeechRecognition would
 * have been three lines, but in Chromium it is a wrapper around Google's cloud
 * service - which Electron ships no key for, so it fails outright, and which
 * would be the wrong answer even if it worked for an app whose whole point is
 * that nothing leaves the machine.
 *
 * So: Whisper, in whatever Python has faster-whisper installed. That is a real
 * dependency and it is not pretended away - `status()` says exactly what is
 * missing, and voice stays off until it is there.
 *
 * The worker is kept alive between utterances for the same reason Ollama keeps a
 * model resident: loading base.en costs seconds and transcribing a sentence
 * costs a fraction of one, so a process per clip would make every sentence pay
 * the load.
 */
export class Speech {
  private child: ChildProcess | null = null
  private starting: Promise<boolean> | null = null
  private restarts = 0
  private stopping = false
  private state: VoiceStatus = { kind: 'unknown' }

  private nextId = 1
  private readonly waiting = new Map<
    number,
    { resolve(t: Transcript): void; reject(err: Error): void; timer: NodeJS.Timeout }
  >()

  /**
   * No constructor argument: the model is fixed. See WHISPER_MODEL for the
   * measurements that settled it.
   */

  status(): VoiceStatus {
    return this.state
  }

  /**
   * Where a Python with faster-whisper is expected to be.
   *
   * The dedicated environment comes first: a global interpreter may have a
   * different faster-whisper, or a numpy that fights with it, and silently
   * picking that one up would make failures depend on the user's other projects.
   */
  private interpreters(): string[] {
    const local = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local')
    const configured = process.env.WUMPY_PYTHON
    return [
      ...(configured ? [configured] : []),
      join(local, 'Wumpy', 'speech', 'venv', 'Scripts', 'python.exe'),
      join(local, 'Wumpy', 'speech', 'venv', 'bin', 'python')
    ]
  }

  private modelsDir(): string {
    const local = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local')
    const dir = join(local, 'Wumpy', 'speech', 'models')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Starts the worker if it is not already up. Resolves false when it cannot. */
  start(): Promise<boolean> {
    if (this.child && this.state.kind === 'ready') return Promise.resolve(true)
    if (this.starting) return this.starting

    const python = this.interpreters().find((p) => existsSync(p))
    const script = resourcePath('speech/worker.py')

    if (!python) {
      this.state = {
        kind: 'absent',
        detail: 'No Python with faster-whisper. Run npm run speech:install to set one up.'
      }
      return Promise.resolve(false)
    }
    if (!existsSync(script)) {
      this.state = { kind: 'absent', detail: `Transcriber script missing: ${script}` }
      return Promise.resolve(false)
    }

    this.stopping = false
    this.state = { kind: 'starting' }

    this.starting = new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        this.starting = null
        resolve(ok)
      }

      // -I keeps the worker out of whatever happens to be in the working
      // directory: without it, a file called json.py next to the app would be
      // imported instead of the standard library.
      this.child = spawn(python, ['-I', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          WUMPY_WHISPER_MODEL: process.env.WUMPY_WHISPER_MODEL ?? WHISPER_MODEL,
          WUMPY_WHISPER_MODELS: this.modelsDir(),
          HF_HUB_DISABLE_SYMLINKS_WARNING: '1'
        }
      })

      let buffer = ''
      this.child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          this.onMessage(line, settle)
        }
      })

      this.child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        // Whisper's first run downloads a model and narrates it on stderr. That
        // is progress, not a fault, so it is not reported as one.
        if (text) console.log(`[wumpy] transcriber: ${text}`)
      })

      this.child.on('error', (err) => {
        this.state = { kind: 'failed', detail: err.message }
        settle(false)
      })

      this.child.on('exit', (code) => {
        this.child = null
        for (const [id, w] of this.waiting) {
          clearTimeout(w.timer)
          w.reject(new Error('the transcriber stopped'))
          this.waiting.delete(id)
        }
        if (this.stopping) return
        if (this.state.kind === 'ready' && this.restarts < 3) {
          this.restarts += 1
          this.state = { kind: 'starting' }
          console.warn(`[wumpy] transcriber exited (${code}); restart ${this.restarts}/3`)
          setTimeout(() => void this.start(), 400 * this.restarts)
        } else if (this.state.kind !== 'failed') {
          this.state = { kind: 'failed', detail: `the transcriber exited with code ${code}` }
        }
        settle(false)
      })
    })

    return this.starting
  }

  private onMessage(line: string, settle: (ok: boolean) => void): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.log(`[wumpy] transcriber said: ${line}`)
      return
    }

    if (typeof msg.fatal === 'string') {
      this.state = { kind: 'failed', detail: msg.fatal }
      settle(false)
      return
    }

    if (msg.ready === true) {
      this.restarts = 0
      this.state = { kind: 'ready', model: String(msg.model ?? ''), loadMs: Number(msg.load_ms ?? 0) }
      console.log(`[wumpy] transcriber ready (${msg.model}, loaded in ${msg.load_ms}ms)`)
      settle(true)
      return
    }

    const id = Number(msg.id)
    const pending = this.waiting.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.waiting.delete(id)

    if (typeof msg.error === 'string') {
      pending.reject(new Error(msg.error))
      return
    }
    pending.resolve({
      text: String(msg.text ?? ''),
      ms: Number(msg.ms ?? 0),
      audioSeconds: Number(msg.audio ?? 0),
      confidence: Number(msg.confidence ?? 0)
    })
  }

  /**
   * Transcribes one clip.
   *
   * The audio arrives as whatever the renderer's MediaRecorder produced, which
   * it decodes itself - no conversion step, and so no ffmpeg to find.
   */
  async transcribe(audio: Uint8Array, extension = 'webm'): Promise<Transcript> {
    const ok = await this.start()
    if (!ok) throw new Error(this.state.kind === 'absent' ? this.state.detail : 'the transcriber is not running')

    const dir = join(app.getPath('temp'), 'wumpy-voice')
    mkdirSync(dir, { recursive: true })
    const id = this.nextId++
    const path = join(dir, `clip-${id}.${extension}`)
    writeFileSync(path, audio)

    try {
      return await new Promise<Transcript>((resolve, reject) => {
        // Long enough for a slow first load on a cold disk, short enough that a
        // wedged worker does not leave the panel waiting for ever.
        const timer = setTimeout(() => {
          this.waiting.delete(id)
          reject(new Error('the transcriber did not answer in time'))
        }, 120_000)
        this.waiting.set(id, { resolve, reject, timer })
        this.child?.stdin?.write(`${JSON.stringify({ id, path })}\n`)
      })
    } finally {
      try {
        unlinkSync(path)
      } catch {
        /* the next run will clear it */
      }
    }
  }

  stop(): void {
    this.stopping = true
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
  }
}
