import { readFileSync } from 'node:fs'
import { BINS, features, forPrint } from '@shared/voiceprint'

/**
 * Makes voiceprints, in a process of its own (see main/voiceprint.ts).
 *
 * The model runs on onnxruntime's WebAssembly build, which works on the
 * thread that calls it: in the main process, a 5s clip held everything else
 * up for 0.6s and a 30s one for 3.9s - the panel, the hotkeys, and the
 * answer's own audio as it streamed to the earbuds, in exactly the moment
 * someone talked over it. Here it holds up nothing but itself.
 */

type Request = { id: number; kind: 'load'; file: string } | { id: number; kind: 'embed'; samples: Float32Array }

type Session = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>
  inputNames: readonly string[]
  outputNames: readonly string[]
}

let model: { session: Session; tensor: (data: Float32Array, dims: number[]) => unknown } | null = null

async function load(file: string): Promise<void> {
  const ort = await import('onnxruntime-web')
  /* One thread: no workers to start from inside the app's archive. */
  ort.env.wasm.numThreads = 1
  const session = (await ort.InferenceSession.create(readFileSync(file))) as unknown as Session
  model = { session, tensor: (data, dims) => new ort.Tensor('float32', data, dims) }
}

/** The voiceprint of a clip, and how much talking it was made from; null if too little. */
async function embed(samples: Float32Array): Promise<{ v: Float32Array; talkedMs: number } | null> {
  if (!model) throw new Error('the voice model is not loaded')
  const talk = forPrint(samples)
  const { data, frames } = features(talk)
  if (frames < 10) return null
  const out = await model.session.run({ [model.session.inputNames[0]]: model.tensor(data, [1, frames, BINS]) })
  return { v: out[model.session.outputNames[0]].data, talkedMs: Math.round((talk.length / 16000) * 1000) }
}

process.parentPort.on('message', (e) => {
  const req = e.data as Request
  void (async () => {
    try {
      if (req.kind === 'load') {
        await load(req.file)
        process.parentPort.postMessage({ id: req.id, ok: true })
      } else {
        const got = await embed(req.samples)
        process.parentPort.postMessage({ id: req.id, ok: true, v: got?.v ?? null, talkedMs: got?.talkedMs ?? 0 })
      }
    } catch (err) {
      process.parentPort.postMessage({ id: req.id, ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) })
    }
  })()
})
