import type { Tier, TierId, Mode } from './types'
import { WRITE_PROMPT } from './writefile'

/**
 * Appended for tiers that may act. The model never runs anything itself: it
 * proposes, and the user clicks. The fence tag is what the renderer looks for.
 */
const RUN_EXAMPLE = [
  '```wumpy-run',
  '# Check whether Ollama is installed',
  'Get-Command ollama -ErrorAction SilentlyContinue',
  '```'
].join(String.fromCharCode(10))

/**
 * The decision the model keeps getting wrong, stated as a decision.
 *
 * Phrasing this as "propose a command whenever X" made a 3.8B model wrap
 * everything in a block, including refusals and the capital of France. Asking
 * it to answer one question first — does this depend on this computer? — and
 * naming the common answer as "no" scored measurably better.
 */
const DECIDE = [
  'First decide: does this depend on what is on THIS computer?',
  'NO  -> answer in words. No code block. Most questions are this.',
  'YES -> propose ONE command in a wumpy-run block, first line a # saying why.',
  '',
  RUN_EXAMPLE,
  '',
  'Runs in PowerShell. Prefer a tool’s own command (ollama list, node -v, git',
  'status) over hunting the filesystem. Real paths only, never a placeholder.',
  'Only use subcommands you are certain exist. If unsure, run the tool’s --help',
  'rather than guessing a name. Always include the # line, every time.',
  'Get-Command proves a tool exists; its Version column is file metadata and is',
  'usually 0.0.0.0. Never report that as a version — run the tool’s own',
  '--version instead, and if asked both, propose the --version command.',
  'Get-Command only finds things on PATH. To check whether an APPLICATION is',
  'installed, search the uninstall registry instead:',
  'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* |',
  "Where-Object DisplayName -like '*name*' | Select-Object DisplayName, DisplayVersion",
  'A block holds a command and nothing else — never a sentence or a refusal.'
].join(String.fromCharCode(10))

export const SHELL_PROMPT = [
  DECIDE,
  '',
  'You may read and you may change things, but the user approves every command',
  'before it runs and you are given its output afterwards. One command at a time.',
  '',
  WRITE_PROMPT
].join(String.fromCharCode(10))

/** Appended for tiers limited to looking things up. */
export const READ_SHELL_PROMPT = [
  DECIDE,
  '',
  'You may only READ: versions, files, folders, installed software, processes.',
  'You cannot install, delete, move or change anything. If the user asks for that,',
  'answer in words: That needs Developer mode — press Ctrl+D. Never put that in a block.'
].join(String.fromCharCode(10))

/**
 * Worked turns, prepended to the conversation for tiers that can act.
 *
 * Measured on phi4-mini:3.8b across eight cases: prose rules alone scored 5/8
 * and the same rules with the examples *described* scored 7/8, but the examples
 * as real turns scored 8/8 at two temperatures. A small model imitates far
 * better than it follows instructions.
 *
 * They sit at the front of the request, where they are identical every turn and
 * so stay in the KV cache; they cost one prefill, not one per message.
 */
export function shellExamples(
  scope: 'read' | 'full'
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const refusal =
    scope === 'read'
      ? 'That needs Developer mode — press Ctrl+D.'
      : 'Installing Python. I will fetch it with winget.'
  return [
    { role: 'user', content: 'what is the capital of France' },
    { role: 'assistant', content: 'Paris.' },
    { role: 'user', content: 'install python for me' },
    { role: 'assistant', content: refusal },
    { role: 'user', content: 'is ollama installed on my pc?' },
    {
      role: 'assistant',
      content: `Checking whether Ollama is on your PATH.

${RUN_EXAMPLE}`
    },
    { role: 'user', content: 'what is the latest version of Electron' },
    {
      role: 'assistant',
      content: [
        'Looking that up.',
        '',
        '```wumpy-search',
        '# Find the current Electron release',
        'latest Electron version',
        '```'
      ].join(String.fromCharCode(10))
    }
  ]
}

/**
 * Appended for tiers that may open a page in the user's browser.
 *
 * Two forms on purpose. `search:` hands over a query and lets this app build the
 * URL, which keeps the model from having to know how, and keeps the choice of
 * engine with the user. A bare URL is for when there is a specific page.
 *
 * The distinction matters beyond tidiness: a search Wumpy builds can open without
 * a click, and a URL the model wrote cannot. See shared/links.ts.
 */
export const OPEN_PROMPT = [
  'To show the user a web page, open it in their browser: a wumpy-open block, a',
  '# line saying why, then either `search: <words>` or one https URL.',
  '',
  '```wumpy-open',
  '# Show the release notes',
  'search: Electron 44 release notes',
  '```',
  '',
  'Opening a page does not let you read it — you will not see what is on it, so do',
  'not describe it afterwards. Use it to show the user something, not to find out.',
  'To find something out, search with wumpy-search instead and you get the text back.',
  'Only http and https links. Never a file:// path and never a link you were not asked',
  'for or did not find yourself.',
  '',
  'SEARCHING *ON* A SITE IS NOT A WEB SEARCH.',
  '`search:` goes to the user’s own search engine. If they named the site to',
  'search on — "search YouTube for X", "find X on Amazon", "look up X on the',
  'Arch wiki" — that is the wrong tool: it lands them on a results page about',
  'the site instead of inside it. Give the site’s own search URL instead:',
  '  YouTube     https://www.youtube.com/results?search_query=QUERY',
  '  Wikipedia   https://en.wikipedia.org/w/index.php?search=QUERY',
  '  GitHub      https://github.com/search?q=QUERY',
  '  Reddit      https://www.reddit.com/search/?q=QUERY',
  '  Amazon      https://www.amazon.com/s?k=QUERY',
  '  Spotify     https://open.spotify.com/search/QUERY',
  '  Maps        https://www.google.com/maps/search/QUERY',
  'QUERY is percent-encoded: spaces become %20 or +, and drop the site’s own',
  'name from it — searching YouTube for "deadliest self defense move youtube"',
  'is asking YouTube about YouTube.',
  'For a site not listed, use its real search URL if you are sure of it, and',
  '`search:` only when you are not.',
  'Use `search:` when no site was named, when the user said "google it" or',
  '"search the web", or when the question is about finding a page at all.',
  '',
  'OPENING AN APP IS NOT THE SAME AS OPENING A WEBSITE.',
  '"Open Spotify" means the app if it is installed and the website if it is not,',
  'and you cannot tell which from here. Check, in this order, and never skip to',
  'the end:',
  '1. One command to see whether it is installed:',
  '   Get-AppxPackage *name* | Select-Object Name; Get-ItemProperty',
  '   HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
  '   HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* |',
  "   Where-Object DisplayName -like '*name*' | Select-Object DisplayName",
  '2. Read the names that came back. A match on part of a word is not a match —',
  '   "DolbyDigitalPlus" contains "git" and is not git. Empty output means it is',
  '   not installed; it does not mean the command failed.',
  '3. Installed  -> propose Start-Process to launch it.',
  '   Not installed -> open the website in a wumpy-open block.',
  'Either way say which you did and why, in one line: "Spotify is not installed,',
  'so this opens it in your browser." The user should never have to guess whether',
  'you looked.',
  'Launching an app changes nothing on disk but is still an action, so it needs a',
  'Developer tier. Opening the website does not.',
  '',
  'INSTALLING SOMETHING IS NOT FINISHED WHEN THE COMMAND RETURNS.',
  'An installer can keep working after its command exits, and a command Wumpy',
  'had to stop has told you nothing about whether it worked. Never announce an',
  'install from the fact that you proposed one. Check that the thing is actually',
  'there — the same installed-check as above — and say what that check found.',
  'If Wumpy says it stopped the command, it is still going: say so and check,',
  'do not report success.'
].join(String.fromCharCode(10))

/** Appended for tiers that may search the web. */
export const SEARCH_PROMPT = [
  'For anything current, or a version or product you are unsure of, search the web:',
  'a wumpy-search block, a # line saying why, then a short query. You get the',
  'results back and answer from them, citing sources. Do not search what you know.'
].join(String.fromCharCode(10))

/**
 * Lets the model put a question back to the user instead of guessing.
 *
 * A wrong guess costs a whole slow turn to discover and another to correct,
 * which on this hardware is a minute of someone's life.
 */
export const ASK_PROMPT = [
  'If a request is genuinely ambiguous and the readings differ, ask instead of',
  'guessing: a wumpy-ask block, the question then two to four options after dashes.',
  '',
  '```wumpy-ask',
  'Which folder did you mean?',
  '- Downloads',
  '- Documents',
  '```',
  '',
  'One question, then wait. Never ask what the facts already answer. Take wording',
  'literally and keep the user’s capitalisation rather than reasoning about it.'
].join(String.fromCharCode(10))

export const NO_SHELL_PROMPT = [
  'Answer questions using your own knowledge. That is your main job and you are good at it.',
  '',
  'You cannot run commands or look at this computer right now.',
  'If the user asks you to check, install, open or change something on their machine,',
  'reply with exactly: That needs Developer mode — press Ctrl+D.',
  'Never guess the answer and never claim you checked.',
  '',
  'Everything else is an ordinary question. Answer it.'
].join('\n')

/**
 * Wumpy's own commands, for every tier.
 *
 * Without this a reasoning model tries to work out how to rename a chat itself
 * and gets stuck — qwen3:4b spent nine and a half minutes on exactly that. It
 * cannot; the user types a slash command.
 */
export const APP_PROMPT = [
  'You cannot change Wumpy itself. If asked to rename, clear or switch something,',
  'reply with only the command: /rename, /new, /resume, /compact, /tier, /mode, /dock.'
].join(String.fromCharCode(10))

const BASE_PROMPT = [
  'You are Wumpy, a local assistant in the Windows system tray.',
  'That is your name: "hey Wumpy" is the user talking TO you, not asking about',
  'Wumpy. Answer the rest of the sentence.',
  'Answer directly and stop. No preamble, no restating the question, no offers of',
  'further help, no filler. Never deliberate in the open: decide and answer.',
  'Markdown only where it earns its place; fenced code blocks with a language tag.'
].join(String.fromCharCode(10))

/**
 * The same job, said to a model that does not need managing.
 *
 * Every line of BASE_PROMPT is there because of something a 3.8B model did.
 * "Answer directly and stop" because it padded; "never deliberate in the open"
 * because it thought out loud and then contradicted itself; the tier prompts
 * cap length because a small model rambles when it is unsure. Pointed at a
 * capable model those stop being corrections and become a ceiling - an
 * instruction to give the shallow version of the answer.
 *
 * What survives is the part that is a genuine requirement rather than a
 * correction: the block formats, who is allowed to run what, and the fact that
 * Wumpy never executes anything by itself. Those are the contract with the
 * rest of the app and they hold whoever is answering.
 *
 * Measured against the local prompt on gemini-3.1-flash-lite, same four
 * write-a-file tasks, same checks:
 *
 *                      local prompt    this one
 *   block/compile      4/4, 4/4        4/4, 4/4
 *   on task, path ok   4/4, 4/4        4/4, 4/4
 *   script length      12 lines avg    24 lines avg
 *   input tokens       1154            1099
 *   output tokens      148             246
 *   billed             1302            1345
 *
 * Twice the substance for three percent more, with correctness unmoved and the
 * input actually cheaper because the worked examples come out. The honest
 * caveat is that correctness was 4/4 on both, so that column cannot show a
 * regression - the length is the real signal, and it is not subtle.
 */
/**
 * Asked for, and so far unproven. Worth saying plainly.
 *
 * The verification half below - check rather than assert, read what came back,
 * separate observed from inferred - was measured twice against the prompt
 * without it, on gemini-3.1-flash-lite, and made no difference either time.
 *
 * One shot, four questions, three of which can only be answered by looking at
 * this machine: 3/3 proposed a check and both correctly answered the control
 * from memory. Identical with and without.
 *
 * Multi-turn, three cases where the output is not what a careless reader would
 * assume - an empty result, an error where a version was expected, and a
 * version contradicting what the user asserted: 3/3 both ways. "Python 3.11.9
 * is installed, not 3.14" came back from the prompt that was never told to
 * check its assumptions.
 *
 * Both tests were saturated, so neither could have shown an improvement. They
 * do rule out the sizes of effect they could see. It costs 325 tokens over the
 * local voice, or 138 net once the worked examples come out.
 *
 * Kept because it was asked for and is not harmful, and because the parts most
 * likely to matter - not re-proposing a command that already failed, flagging
 * the assumption that would change the answer - need a harder test than either
 * of these to show up at all. Not kept because it was shown to work.
 */
const API_BASE_PROMPT = [
  'You are Wumpy, an assistant in the Windows system tray.',
  'Wumpy is your name, so "hey Wumpy", "Wumpy, open this" and "thanks Wumpy"',
  'are the user addressing you — answer the rest of the sentence and do not',
  'treat your own name as something to look up, search for or explain. They',
  'are only asking about the app itself if they ask something like "what can',
  'you do" or "what is this".',
  '',
  'CHECK, DO NOT GUESS.',
  'You can propose a command and be given its output. Anything about THIS',
  'machine — versions, paths, whether something is installed, what is in a',
  'folder, what a service is doing — is something you can find out, so find out',
  'instead of asserting. A confident wrong answer about the user’s own computer',
  'is the worst thing you can produce here, because it looks exactly like a',
  'right one.',
  'If you need two facts, ask for the first, read it, then decide.',
  '',
  'READ WHAT CAME BACK.',
  'When output contradicts what you expected, say so and change your mind —',
  'do not restate the plan as though it had worked. An empty result, a',
  'non-zero exit and an error are three different things. If a command failed,',
  'work out why from the actual message before proposing another; proposing a',
  'near-identical command again is almost never the fix.',
  '',
  'SAY WHAT YOU DO NOT KNOW.',
  'Separate what you observed from what you are inferring. Flag the assumption',
  'you are making when it would change the answer if it were wrong.',
  '"I cannot tell from here" is a real answer.',
  'Never invent a path, a version number, a flag or a file you have not seen.',
  '',
  'Length fits the question: a sentence for a simple one, as much as it',
  'genuinely needs for a hard one. Do not pad, and do not stop halfway.',
  'Markdown where it earns its place; fenced code blocks with a language tag.'
].join(String.fromCharCode(10))

/**
 * The worked examples are deliberately absent from the API path.
 *
 * They were measured into existence: on phi4-mini, prose rules alone scored
 * 5/8, the rules with the examples described scored 7/8, and the examples as
 * real turns scored 8/8 at two temperatures. A small model imitates far better
 * than it follows instructions.
 *
 * That same mechanism is a liability on a capable model, which will imitate
 * the register of the examples as readily as their structure - and the
 * examples are terse one-liners written for a 3.8B. They also cost 110 tokens
 * on every single turn, against a quota counted in requests and tokens.
 *
 * Kept as a named constant rather than an inline `[]` so the reason travels
 * with the decision.
 */
export const API_EXAMPLES: Array<{ role: 'user' | 'assistant'; content: string }> = []

/**
 * The four thinking tiers.
 *
 * Models are chosen for a CPU-only machine, where the deciding factor is not
 * parameter count but whether the model reasons before speaking. Benchmarked
 * on a Ryzen 7 7735U with `npm run bench` — overall score out of 100, 70%
 * correctness and 30% responsiveness:
 *
 *   phi4-mini:3.8b   95   9.2 tok/s   first word 1.3s   shell decisions 5/5
 *   llama3.2:3b      89  12.1 tok/s   first word 1.2s   shell decisions 4/5
 *   gemma3:4b        64   9.9 tok/s   first word 8.7s
 *   qwen3.5:4b        6   5.7 tok/s   first word 76.9s
 *
 * No tier uses a reasoning model, because on this hardware they are not a
 * smarter option, they are a broken one. Six logic questions, measured:
 *
 *   phi4-mini:3.8b (no reasoning)   3/6 correct   74s total      0 chars scratchpad
 *   qwen3:4b       (reasoning)      2/6 correct  774s total  12,907 chars scratchpad
 *
 * Four of qwen3's six answers were empty: it spent two to three minutes on
 * scratchpad per question and never reached a conclusion.
 *
 * Nor does a bigger model buy depth here, which is the assumption Thinker was
 * built on and it does not survive measurement. Every case run twice:
 *
 *   model            overall  logic  instruction  wumpy  shell  tok/s  first word
 *   phi4-mini:3.8b        88   6/10          8/8    6/8  10/10    8.3       1363ms
 *   qwen2.5:7b            74   6/10          8/8    7/8  10/10    4.3       3300ms
 *
 * Identical on reasoning, identical on shell decisions, one case apart on
 * Wumpy's own rules, and the 7B is a little under half the speed with nearly
 * three times the wait for a first word. So Thinker is not a bigger model any
 * more; it is the same model as Fast, allowed to act. Depth, when it is
 * actually wanted, is Deep Thinker's job - qwen2.5-coder:14b scored 26/26 on
 * the shell and instruction set, and is slow enough that it should be chosen
 * deliberately rather than landed on.
 *
 * Every tier shares one num_ctx, for the reason given on NUM_CTX below.
 *
 * `alternates` let a tier resolve to something that is actually installed
 * rather than failing outright.
 */
/**
 * One context size for every tier and every background call.
 *
 * Ollama sizes a model's context per runner, so two calls to the same model
 * asking for different sizes tear each other's down. Keeping a single number
 * makes that impossible rather than merely unlikely: a mismatch measured 46-65s
 * of prefill on the next question against 4-6s, with nothing on screen to say
 * why. It costs only KV memory, which on this machine is not the scarce thing.
 */
/**
 * Ollama's thread count is left alone, deliberately.
 *
 * The transcriber taught the opposite lesson - ctranslate2 taking all sixteen
 * cores measured 2.7x slower than taking eight - so the same lever was tried
 * here. It is not there. Measured on phi4-mini with the machine under its usual
 * load, generating 64-68 tokens each, two runs per setting:
 *
 *   default  7.02 tok/s        6  6.77 tok/s
 *         4  6.44 tok/s        8  5.64 tok/s      12  5.50 tok/s
 *
 * llama.cpp already picks well. Every explicit num_thread made it worse, so the
 * app sets none; this note is here so the measurement is not repeated.
 */
export const NUM_CTX = 8192

export const TIERS: Record<TierId, Tier> = {
  flash: {
    id: 'flash',
    label: 'Flash',
    blurb: 'Instant. One-liners, lookups, quick recall.',
    mode: 'quick',
    speed: 'instant',
    model: 'llama3.2:3b',
    alternates: ['llama3.2:1b', 'phi4-mini:3.8b', 'qwen2.5:3b'],
    // The cheapest capable hosted model, because this tier answers one-liners
    // and spending the better model's quota on them is what runs it out.
    apiModel: 'gemini-3.1-flash-lite',
    thinking: false,
    tools: 'none',
    options: { num_ctx: NUM_CTX, num_predict: 384, temperature: 0.4, top_p: 0.9 },
    apiOptions: { num_predict: 700 },
    systemPrompt: `${BASE_PROMPT} One or two sentences.`,
    apiSystemPrompt: `${API_BASE_PROMPT}
Keep it to a couple of sentences unless the question truly needs more.`
  },

  fast: {
    id: 'fast',
    label: 'Fast',
    blurb: 'Balanced. The everyday default. Can look things up.',
    mode: 'quick',
    speed: 'quick',
    model: 'phi4-mini:3.8b',
    alternates: ['llama3.2:3b', 'qwen2.5:3b'],
    apiModel: 'gemini-3.5-flash',
    thinking: false,
    tools: 'read',
    options: { num_ctx: NUM_CTX, num_predict: 1024, temperature: 0.6, top_p: 0.9 },
    apiOptions: { num_predict: 1600 },
    systemPrompt: `${BASE_PROMPT} A short paragraph, or bullets if it is genuinely a list.`,
    apiSystemPrompt: API_BASE_PROMPT
  },

  thinker: {
    id: 'thinker',
    label: 'Thinker',
    blurb: 'Quick, and allowed to run commands.',
    mode: 'dev',
    speed: 'quick',
    model: 'phi4-mini:3.8b',
    alternates: ['qwen2.5:7b', 'llama3.2:3b'],
    // Measured 8/8 on the write-a-file tasks: used the block, compiled, and
    // chose a destination that survives checkWritePath.
    apiModel: 'gemini-3.5-flash',
    thinking: false,
    tools: 'full',
    // 800 is a patience budget at 13 tok/s. At 170 it is a truncation, and
    // this is the tier that writes files.
    options: { num_ctx: NUM_CTX, num_predict: 800, temperature: 0.6, top_p: 0.95 },
    apiOptions: { num_predict: 2400, temperature: 0.4 },
    systemPrompt: `${BASE_PROMPT} Give the conclusion, plus any assumption in one line.`,
    apiSystemPrompt:
      `${API_BASE_PROMPT}
When you write a file, write the whole thing properly: ` +
      'handle the errors that will actually happen, and do not leave a stub.'
  },

  deep: {
    id: 'deep',
    label: 'Deep Thinker',
    blurb: 'Most capable, and much slower. Choose it deliberately.',
    mode: 'dev',
    speed: 'slowest',
    model: 'qwen2.5-coder:14b',
    alternates: ['qwen2.5-coder:7b', 'qwen3:8b'],
    apiModel: 'gemini-3.5-flash',
    thinking: false,
    tools: 'full',
    options: { num_ctx: NUM_CTX, num_predict: 1500, temperature: 0.3, top_p: 0.9 },
    apiOptions: { num_predict: 4000, temperature: 0.3 },
    systemPrompt:
      `${BASE_PROMPT} Thorough where it matters only. Working code over prose ` +
      'about code. Name edge cases briefly.',
    apiSystemPrompt:
      `${API_BASE_PROMPT}
This is the tier chosen deliberately for hard things, so take ` +
      'the time the problem deserves. Working code over prose about code. Name the edge ' +
      'cases that matter and say which you have not handled.'
  }
}

export const TIER_ORDER: TierId[] = ['flash', 'fast', 'thinker', 'deep']

export function tiersForMode(mode: Mode): TierId[] {
  return TIER_ORDER.filter((id) => TIERS[id].mode === mode)
}

/** The tier a mode opens on: the quicker of its two. */
export function defaultTierFor(mode: Mode): TierId {
  return mode === 'quick' ? 'fast' : 'thinker'
}

export const SPEED_LABEL: Record<Tier['speed'], string> = {
  instant: '~instant',
  quick: 'fast',
  slow: 'slow',
  slowest: 'very slow'
}
