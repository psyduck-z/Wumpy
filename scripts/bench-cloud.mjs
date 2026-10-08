/**
 * Does a cloud model write a file that actually works, and what does it cost?
 *
 * Same tasks, same system prompt and same compile check as the local bench, so
 * the numbers sit beside phi4-mini's rather than floating free. Two things are
 * measured at once because both decide whether this is worth doing:
 *
 *   correctness - did it use the write block, does the result compile, and does
 *                 the path it chose survive checkWritePath. A script that
 *                 compiles but proposes an illegal destination is still a turn
 *                 the user cannot complete.
 *   budget      - real prompt and completion token counts from the provider,
 *                 not an estimate, plus cached_tokens. The free tiers are
 *                 token-capped, so this is what decides how long a day lasts.
 *
 * Each task runs twice. The second pass is where prompt caching shows up: the
 * preamble is identical across tasks, so by round two it should be a cache hit
 * on any provider that does automatic prefix caching.
 *
 * For scale, the preamble this sends measured 1080 tokens on phi4-mini's
 * tokenizer - 905 for the system prompt, 110 for the worked examples, 65 for the
 * facts block - and it goes out on every single turn. Against a free tier capped
 * at 200k tokens a day that is most of the budget spent re-sending instructions,
 * which is why cached_tokens is reported here and not just the totals.
 *
 * Note the message order: preamble, examples, then facts. The facts block holds
 * the date and the chat title, so it is the one part that changes mid-chat;
 * putting it last keeps everything before it byte-identical and cacheable. That
 * is the opposite of what the main process currently does, and whether it
 * matters is exactly what the round-two cached figure answers.
 *
 * Both Groq and Google expose OpenAI-compatible endpoints, so one adapter
 * covers both - which is the point of the exercise.
 *
 * Run with:
 *   node scripts/bench-cloud.mjs --list
 *   node scripts/bench-cloud.mjs groq:openai/gpt-oss-120b google:gemini-3-flash
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { TASKS } from "./writetasks.mjs";

/* ------------------------------------------------------------------ the keys */

// Read from .env as well as the environment, because a key pasted into a file
// does not leak into shell history the way `export` does. .env is gitignored.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]])
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const PROVIDERS = {
  groq: {
    base: "https://api.groq.com/openai/v1",
    key: () => process.env.GROQ_API_KEY,
    envName: "GROQ_API_KEY",
  },
  google: {
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    key: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    envName: "GEMINI_API_KEY",
  },
};

/* -------------------------------------------------- Wumpy's own prompt + rules */

async function bundle(entry, name) {
  const out = join(process.cwd(), `.bc-${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "error",
  });
  return import(pathToFileURL(out).href);
}
const T = await bundle("src/shared/tiers.ts", "tiers");
const W = await bundle("src/shared/writefile.ts", "wf");

const SYSTEM = [
  T.TIERS.thinker.systemPrompt,
  T.APP_PROMPT,
  T.SHELL_PROMPT,
  T.SEARCH_PROMPT,
  T.OPEN_PROMPT,
  T.ASK_PROMPT,
]
  .filter(Boolean)
  .join("\n\n");

const FACTS = [
  "Facts about right now. If the user asks about any of these, just state the answer.",
  "- Today is Thursday, 8 October 2026.",
  "- The current tier is Thinker.",
  "- This chat is titled untitled so far.",
  `- The user is on Windows. Commands run from ${homedir()}.`,
].join("\n");

/** Exactly the shape a real turn has: preamble, examples, facts, question. */
function messagesFor(ask) {
  return [
    { role: "system", content: SYSTEM },
    ...T.shellExamples("full"),
    { role: "system", content: FACTS },
    { role: "user", content: ask },
  ];
}

const WRITE_ENV = { home: homedir(), cwd: homedir(), resolve, separator: sep };

/* --------------------------------------------------------------- the transport */

async function listModels(name) {
  const p = PROVIDERS[name];
  const key = p.key();
  if (!key) return { name, error: `${p.envName} is not set` };
  const res = await fetch(`${p.base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok)
    return { name, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  const body = await res.json();
  return { name, ids: (body.data ?? []).map((m) => m.id).sort() };
}

/**
 * Folds the message list into the shape a stricter endpoint will accept.
 *
 * Google's OpenAI-compatible layer is less forgiving than Groq's: it does not
 * reliably take a second `system` message partway down the list, which is
 * exactly what Wumpy sends (preamble, examples, then the live facts). Merging
 * them changes what is measured, so it is only done after a request is refused,
 * and the fallback is reported rather than hidden - if a provider needs the
 * facts block welded to the preamble, that is a real constraint on the caching
 * design and not a detail of this script.
 */
function fold(messages) {
  const systems = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return [{ role: "system", content: systems.join("\n\n") }, ...rest];
}

const quirks = { noStreamOptions: new Set(), foldSystem: new Set() };

async function chat(provider, model, messages) {
  const p = PROVIDERS[provider];
  const started = Date.now();
  let firstToken = 0;

  async function send(body) {
    return fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.key()}`,
      },
      body: JSON.stringify(body),
    });
  }

  const bodyFor = () => ({
    model,
    messages: quirks.foldSystem.has(provider) ? fold(messages) : messages,
    stream: true,
    ...(quirks.noStreamOptions.has(provider)
      ? {}
      : { stream_options: { include_usage: true } }),
    temperature: 0.2,
    max_tokens: 2000,
  });

  let res = await send(bodyFor());

  // Two refusals are worth adapting to rather than failing on, because both are
  // shape complaints and not capability ones. Each is remembered, so the cost is
  // one wasted request per provider rather than one per task.
  if (res.status === 400) {
    const detail = await res.text();
    if (
      /stream_options/i.test(detail) &&
      !quirks.noStreamOptions.has(provider)
    ) {
      quirks.noStreamOptions.add(provider);
      console.log(
        `        (${provider} rejects stream_options; token counts may be absent)`,
      );
      res = await send(bodyFor());
    } else if (!quirks.foldSystem.has(provider)) {
      quirks.foldSystem.add(provider);
      console.log(
        `        (${provider} rejects a second system message; merging the facts block)`,
      );
      res = await send(bodyFor());
    } else {
      throw new Error(`400 ${detail.slice(0, 300)}`);
    }
  }
  if (!res.ok)
    throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);

  let text = "";
  let usage = null;
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.usage) usage = obj.usage;
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        if (!firstToken) firstToken = Date.now();
        text += delta;
      }
    }
  }

  const out = usage?.completion_tokens ?? 0;
  return {
    text,
    seconds: (Date.now() - started) / 1000,
    ttft: firstToken ? (firstToken - started) / 1000 : 0,
    promptTokens: usage?.prompt_tokens ?? 0,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    outTokens: out,
    // Generation rate over the streaming window only, so the network round trip
    // to the first token is not counted as slow generation.
    tokPerSec:
      firstToken && out
        ? out / Math.max(0.001, (Date.now() - firstToken) / 1000)
        : 0,
  };
}

/* ----------------------------------------------------------------- the scoring */

function score(task, text) {
  const block = /```wumpy-write\n([\s\S]*?)```/.exec(text);
  if (!block) return { usedBlock: false };
  const req = W.readWriteRequest(block[1]);
  const check = W.checkWritePath(req.path ?? "", WRITE_ENV);

  const dir = mkdtempSync(join(tmpdir(), "wumpy-bc-"));
  const file = join(dir, "candidate.py");
  writeFileSync(file, req.content, "utf8");
  const compiled = spawnSync("python", ["-I", "-m", "py_compile", file], {
    encoding: "utf8",
  });
  const compiles = compiled.status === 0;

  return {
    usedBlock: true,
    compiles,
    pathOk: check.ok,
    pathWhy: check.why,
    path: req.path,
    onTask: compiles && task.wants.every((w) => req.content.includes(w)),
    lines: req.content.split("\n").length,
    stderr: (compiled.stderr || "").trim().split("\n").slice(-2)[0] ?? "",
  };
}

const median = (xs) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;

/* -------------------------------------------------------------------- the runs */

const args = process.argv.slice(2);

if (args.includes("--list") || args.length === 0) {
  for (const name of Object.keys(PROVIDERS)) {
    const r = await listModels(name);
    console.log(`\n=== ${name} ===`);
    if (r.error) console.log(`  ${r.error}`);
    else r.ids.forEach((id) => console.log(`  ${id}`));
  }
  process.exit(0);
}

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 2);

for (const spec of args) {
  const [provider, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (!PROVIDERS[provider]) {
    console.log(`\n=== ${spec} ===\n  unknown provider "${provider}"`);
    continue;
  }
  if (!PROVIDERS[provider].key()) {
    console.log(
      `\n=== ${spec} ===\n  ${PROVIDERS[provider].envName} is not set`,
    );
    continue;
  }

  console.log(`\n=== ${spec} ===`);
  const tally = { block: 0, compiles: 0, onTask: 0, pathOk: 0, n: 0 };
  const rates = [];
  const ttfts = [];
  let promptTotal = 0;
  let cachedTotal = 0;
  let outTotal = 0;
  let failed = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    for (const task of TASKS) {
      let got;
      try {
        got = await chat(provider, model, messagesFor(task.ask));
      } catch (err) {
        failed++;
        console.log(
          `  r${round} ERROR     ${String(err.message).slice(0, 110)}`,
        );
        continue;
      }
      promptTotal += got.promptTokens;
      cachedTotal += got.cached;
      outTotal += got.outTokens;
      if (got.tokPerSec) rates.push(got.tokPerSec);
      if (got.ttft) ttfts.push(got.ttft);

      const s = score(task, got.text);
      tally.n++;
      if (!s.usedBlock) {
        console.log(`  r${round} no block  ${task.ask.slice(0, 40)}...`);
        continue;
      }
      tally.block++;
      if (s.compiles) tally.compiles++;
      if (s.onTask) tally.onTask++;
      if (s.pathOk) tally.pathOk++;

      console.log(
        `  r${round} ${s.compiles ? "compiles" : "SYNTAX  "} ${s.onTask ? "on-task" : "thin   "} ` +
          `${s.pathOk ? "path-ok" : "PATH   "} ${String(s.lines).padStart(3)}ln ` +
          `${got.promptTokens}in${got.cached ? `/${got.cached}cached` : ""} ${got.outTokens}out ` +
          `${got.ttft.toFixed(1)}s+${got.tokPerSec.toFixed(0)}t/s  ${task.ask.slice(0, 24)}...`,
      );
      if (!s.compiles) console.log(`        ${s.stderr}`);
      if (!s.pathOk) console.log(`        path "${s.path}" -> ${s.pathWhy}`);
    }
  }

  const calls = tally.n || 1;
  console.log(
    `\n  correctness  ${tally.block}/${tally.n} block, ${tally.compiles}/${tally.n} compile, ` +
      `${tally.onTask}/${tally.n} on task, ${tally.pathOk}/${tally.n} legal path` +
      (failed ? `, ${failed} request errors` : ""),
  );
  console.log(
    `  speed        ${median(ttfts).toFixed(2)}s to first token, ${median(rates).toFixed(0)} tok/s`,
  );
  console.log(
    `  tokens/call  ${Math.round(promptTotal / calls)} in ` +
      `(${Math.round(cachedTotal / calls)} cached), ${Math.round(outTotal / calls)} out`,
  );

  // What the free tier actually buys, from the numbers just measured. A Wumpy
  // question averages about 2.5 calls: ask, feed the command output back, and
  // often one more.
  const billed = (promptTotal - cachedTotal + outTotal) / calls;
  if (provider === "groq" && billed > 0) {
    const tpd = 200_000;
    const tpm = 8_000;
    console.log(
      `  free tier    ${Math.floor(tpd / billed)} calls/day ~ ` +
        `${Math.floor(tpd / billed / 2.5)} questions/day; ` +
        `${(tpm / billed).toFixed(1)} calls/min; request cap is 1000/day`,
    );
  }
}
