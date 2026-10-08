// src/shared/cloud.ts
var PROVIDERS = {
  google: {
    id: "google",
    label: "Google AI Studio",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    foldSystem: true,
    cacheBlockTokens: 4096,
    // 10 requests a minute on the free tier, so 6s plus a margin.
    minGapMs: 7e3
  },
  groq: {
    id: "groq",
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    foldSystem: false,
    cacheBlockTokens: 0,
    // 30 requests a minute on the free tier.
    minGapMs: 2100
  }
};
var CLOUD_MODELS = [
  {
    id: "gemini-3.5-flash",
    provider: "google",
    label: "Gemini 3.5 Flash",
    blurb: "Free, fast, and writes code that compiles. The one to start with."
  },
  {
    id: "gemini-3.8-flash",
    provider: "google",
    label: "Gemini 3.8 Flash",
    // Measured the hard way: roughly 25 requests and the day is over. Google
    // answered the next one with retryDelay 65304s, which is eighteen hours.
    blurb: "Newer, but the free tier allows only ~25 requests a day."
  },
  {
    id: "gemini-3.1-flash-lite",
    provider: "google",
    label: "Gemini 3.1 Flash Lite",
    blurb: "Smaller and cheaper, for quick lookups."
  },
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    label: "GPT-OSS 120B",
    blurb: "Very fast. Prompt caching is free and does not count against limits."
  },
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    blurb: "Faster and lighter on the token budget."
  }
];
function providerFor(model) {
  const name = (model ?? "").trim();
  if (!name) return null;
  const known = CLOUD_MODELS.find((m) => m.id === name);
  if (known) return known.provider;
  if (name.startsWith("gemini-") || name.startsWith("models/gemini-")) return "google";
  if (name.startsWith("openai/") || name.startsWith("groq/") || name.startsWith("moonshotai/")) {
    return "groq";
  }
  return null;
}
function isCloudModel(model) {
  return providerFor(model) !== null;
}
function foldSystemMessages(messages) {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content.trim());
  const rest = messages.filter((m) => m.role !== "system");
  if (systems.length <= 1) return messages.slice();
  return [{ role: "system", content: systems.filter(Boolean).join("\n\n") }, ...rest];
}
function wireMessagesFor(provider, messages) {
  return PROVIDERS[provider].foldSystem ? foldSystemMessages(messages) : messages.slice();
}
function countTokens(usage) {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;
  const thinking = Math.max(0, total - prompt - completion);
  return { prompt, cached, completion, thinking, billed: Math.max(0, total - cached) };
}
var GIVE_UP_AFTER_MS = 12e4;
function classifyLimit(status, body, model) {
  if (status !== 429 && status !== 503) {
    return { kind: "other", waitMs: 0, message: "" };
  }
  const asked = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body ?? "");
  const askedMs = asked ? Math.round(Number(asked[1]) * 1e3) + 500 : 0;
  if (status === 503) {
    return {
      kind: "busy",
      waitMs: Math.min(GIVE_UP_AFTER_MS, askedMs || 8e3),
      message: `${model} is busy right now.`
    };
  }
  if (askedMs > GIVE_UP_AFTER_MS) {
    const hours = askedMs / 36e5;
    return {
      kind: "exhausted",
      waitMs: 0,
      message: `${model} has used up its quota for today` + (hours >= 1 ? ` \u2014 it frees up in about ${Math.round(hours)}h.` : ".")
    };
  }
  return {
    kind: "throttle",
    waitMs: askedMs || 2e4,
    message: `${model} is rate limited; waiting a moment.`
  };
}
function looksLikeKey(provider, raw) {
  const key = (raw ?? "").trim();
  if (!key) return { ok: false, why: "No key was given." };
  if (/\s/.test(key)) return { ok: false, why: "That has a space in it \u2014 paste the key alone." };
  if (/^bearer/i.test(key)) return { ok: false, why: 'Leave off the word "Bearer".' };
  if (/^https?:/i.test(key)) return { ok: false, why: "That is a URL, not a key." };
  if (key.length < 20) return { ok: false, why: "That looks too short to be a whole key." };
  if (key.length > 400) return { ok: false, why: "That looks too long to be a key." };
  if (provider === "groq" && !key.startsWith("gsk_")) {
    return { ok: false, why: "A Groq key starts with gsk_." };
  }
  return { ok: true, why: "" };
}
var THINKING_ALLOWANCE = 1024;
function reasoningEffortFor(provider, thinking) {
  if (thinking) return null;
  return provider === "google" ? "none" : "low";
}
function maxTokensFor(numPredict, thinking) {
  const asked = numPredict > 0 ? numPredict : 1024;
  return thinking ? asked + THINKING_ALLOWANCE : asked;
}
function maskKey(raw) {
  const key = (raw ?? "").trim();
  if (key.length <= 8) return "\u2022\u2022\u2022\u2022";
  return `${key.slice(0, 4)}\u2026${key.slice(-4)}`;
}
export {
  CLOUD_MODELS,
  GIVE_UP_AFTER_MS,
  PROVIDERS,
  THINKING_ALLOWANCE,
  classifyLimit,
  countTokens,
  foldSystemMessages,
  isCloudModel,
  looksLikeKey,
  maskKey,
  maxTokensFor,
  providerFor,
  reasoningEffortFor,
  wireMessagesFor
};
