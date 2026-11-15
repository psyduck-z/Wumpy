/**
 * Ollama counts as ready only when it is running.
 *
 * Found on a machine without Ollama: the Gemma row needs no key, so
 * everything called it ready the moment it was named. It was pickable,
 * recommended in the spoken shortlist ("best overall: ... Gemma"), probed
 * by the ranker, and then every message to it failed to connect.
 *
 * Now the main process asks the daemon (its /models, on localhost) and the
 * answer travels with the key status. Checked as wiring: a check cannot
 * start or stop the user's Ollama.
 *
 * Run with: node scripts/check-local.mjs
 */
import { readFileSync } from 'node:fs'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
const read = (f) => readFileSync(f, 'utf8')
const main = read('src/main/index.ts')
const cloud = read('src/main/cloud.ts')
const app = read('src/renderer/src/App.tsx')
const types = read('src/shared/types.ts')

check('the daemon is asked, on its own /models', /fetch\(`\$\{PROVIDERS\[id\]\.base\}\/models`/.test(main), true)
check('briefly', /AbortSignal\.timeout\(1500\)/.test(main), true)
check('before the first status is reported', /await checkLocal\(\)\s+setInterval\(\(\) => void checkLocal\(\), 30_000\)\.unref\(\)\s+await refreshModels\(\)/.test(main), true)
check('one look at a time', /localChecking \?\?= /.test(main), true)
check('a change is passed on', /if \(changed && panel\) await refreshModels\(\)/.test(main), true)
check('the key status carries it', /local: await \(/.test(main) && /local\?: ProviderName\[\]/.test(types), true)
check('the client is given it', /new CloudClient\(keys, pools, \{ up: \(p\) => localUp\.has\(p\), refresh: checkLocal \}\)/.test(main), true)

check('a keyless model is not ready when the daemon is down', /this\.local && !this\.local\.up\(provider\)\)[\s\S]{0,120}ok: false/.test(cloud), true)
check('and says so in words', /is not running on this computer/.test(cloud), true)
check('a real request asks again first', (cloud.match(/await this\.freshLocal\(model\)\s+const check = this\.ready\(model\)/g) ?? []).length, 2)
check('the old "ready when named" is gone', /if \(PROVIDERS\[provider\]\.keyless\) return \{ ok: true/.test(cloud), false)

check('the spoken shortlist only offers what answers', /PROVIDERS\[p\]\.keyless\s+\? \(keyStatus\?\.local\?\.includes\(p\) \?\? false\)/.test(app), true)
check('the picker says it is not running, not that it needs a key', /'not running on this computer'/.test(app), true)
check('picking it while it is down explains', /which is not running on this computer\. /.test(app), true)
check('and is checked fresh, not from a stale status', /const fresh = await window\.wumpy\.keys\.status\(\)/.test(app), true)
check('a status change re-reads the key status', /onStatus\(\(s\) => \{\s+setAssistant\(s\)\s+void window\.wumpy\.keys\.status\(\)\.then\(setKeyStatus\)/.test(app), true)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} local daemon checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)
