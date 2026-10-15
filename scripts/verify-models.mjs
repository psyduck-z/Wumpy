/**
 * Does every model the picker now offers actually answer, through the body
 * the app builds for it?
 *
 * The catalogue listing a model proves nothing: the request shape is built
 * per provider - reasoning_effort on some, chat_template_kwargs on others,
 * a folded system message for Google, no key at all for Ollama - and a row
 * in a list that 404s or 400s is worse than no row, because the user picks
 * it and loses the turn.
 *
 * Streams, like the app does, so stream_options and the usage frame are
 * exercised too.
 *
 * NOT part of `npm run typecheck`: it costs one real request per catalogue
 * entry, and the checks have to stay free to run. Run it after adding a
 * model, or when one starts failing and you need to know whether it is the
 * model, the key or the request shape.
 *
 *   node scripts/verify-models.mjs
 *
 * Measured 15 Oct 2026, thirteen entries: everything answered except
 * gemini-3.1-pro-preview, which 429s on a free key. First word in 588ms for
 * nemotron-3-super, 1,312ms for gemma4:31b-cloud with no key at all, and
 * 55,830ms for glm-5.3.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

await build({
  entryPoints: ['src/shared/cloud.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.vm.mjs',
  logLevel: 'error'
})
const C = await import(pathToFileURL('.vm.mjs').href)
rmSync('.vm.mjs', { force: true })

const KEY = {
  nvidia: () => process.env.NVIDIA_API_KEY ?? '',
  google: () => (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? '').split(',')[0].trim(),
  ollama: () => ''
}

const ASK = 'Reply with exactly: ready'

for (const m of C.CLOUD_MODELS) {
  const p = C.PROVIDERS[m.provider]
  const key = (KEY[m.provider] ?? (() => ''))()
  if (!p.keyless && !key) {
    console.log(`${m.id.padEnd(34)} SKIPPED (no key in .env for ${m.provider})`)
    continue
  }
  const wire = C.wireMessagesFor(m.provider, [
    { role: 'system', content: 'You are Wumpy. Answer in as few words as possible.' },
    { role: 'user', content: ASK }
  ])
  const effort = C.reasoningEffortFor(m.provider, false, m.id)
  const kwargs = C.thinkingKwargsFor(m.provider, false)
  const body = {
    model: m.id,
    messages: wire,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.4,
    top_p: 0.9,
    max_tokens: C.maxTokensFor(4000, false, m.provider),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(kwargs ? { chat_template_kwargs: kwargs } : {})
  }
  const started = Date.now()
  try {
    const r = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000)
    })
    if (!r.ok) {
      const t = await r.text()
      console.log(`${m.id.padEnd(34)} HTTP ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 90)}`)
      continue
    }
    /* Read the stream the way the app does, so a body that 200s and then
       carries nothing is not reported as working. */
    let said = ''
    let first = 0
    for await (const chunk of r.body) {
      const text = Buffer.from(chunk).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
        try {
          const j = JSON.parse(line.slice(6))
          const piece = j.choices?.[0]?.delta?.content ?? ''
          if (piece && !first) first = Date.now() - started
          said += piece
        } catch {
          /* a partial frame; the next chunk completes it */
        }
      }
    }
    const clean = said.trim().replace(/\s+/g, ' ').slice(0, 40)
    console.log(
      `${m.id.padEnd(34)} ok  ${String(first + 'ms').padStart(8)} to first word, ` +
        `${String(Date.now() - started + 'ms').padStart(8)} total  said=${JSON.stringify(clean)}`
    )
  } catch (err) {
    console.log(`${m.id.padEnd(34)} THREW ${err.message}`)
  }
}
