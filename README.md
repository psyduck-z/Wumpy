# Wumpy

A local-first AI overlay for Windows that takes over the Copilot shortcut.

Wumpy lives in the system tray with no window of its own. Press `Win+C` and a
panel slides in against the right edge of your screen, floating above whatever
you are working in — including fullscreen browsers. Press `Esc` and it is gone.
It talks to [Ollama](https://ollama.com) on `127.0.0.1`, so nothing you type
leaves the machine.

```
┌──────────────────────────────────┐
│ ● Wumpy   Win + C  [llama3.2:3b] │
├──────────────────────────────────┤
│                                  │
│          what's a WH_            │
│          KEYBOARD_LL hook?       │
│                                  │
│  A low-level keyboard hook that  │
│  sees every keystroke before     │
│  the foreground app does…        │
│                                  │
├──────────────────────────────────┤
│ Ask Wumpy anything…      [Send]  │
└──────────────────────────────────┘
```

## Current state

A working streaming chatbot. The agent features (running commands, editing code,
seeing your screen) are deliberately **not** built yet — see [Roadmap](#roadmap).

## Requirements

- Windows 10/11 (x64)
- [Ollama](https://ollama.com/download) running locally
- Node.js 20+ and the .NET 10 SDK (to build)

## Quick start

```powershell
npm install
npm run hook:build        # builds the Win+C interception helper
ollama pull llama3.2:3b   # Flash + Fast; other tiers use models you already have
npm run dev
```

The panel appears on launch. After that it hides in the tray and answers to
`Win+C`.

To build an installer:

```powershell
npm run package           # -> dist/Wumpy-0.1.0-setup.exe
```

## How Win+C is taken

Windows reserves `Win+C` for the shell. This is not a Copilot setting you can
politely ask about — `RegisterHotKey`, which is the only thing Electron's
`globalShortcut` can do, is refused outright. Measured on Windows 11 26300:

| Accelerator | `RegisterHotKey` |
| --- | --- |
| `Win+C`, `Win+Q`, `Win+K`, `Win+Space`, `Win+Shift+C` | refused |
| `Win+J`, `Win+Alt+C`, `Alt+Space`, `Ctrl+Alt+Space` | granted |

The documented escape hatch — the `TurnOffWindowsCopilot` policy value — lives
under `HKCU\Software\Policies`, which is **admin-only**, so a normal user cannot
set it.

So Wumpy does what PowerToys does: a **`WH_KEYBOARD_LL` hook**, which sits ahead
of the shell in the input chain and can swallow the keystroke before it is ever
delivered. That needs no elevation and no registry changes.

It runs as a 170 KB helper process (`src/hook`, C#) spawned by the app:

- Watches for `C` while either Windows key is held, plus the dedicated Copilot
  key (which reports itself as `Shift+Win+F23`).
- Returns `1` from the hook callback, so the shell never sees the key.
- Injects a harmless `Ctrl` tap, because otherwise releasing `Win` having "seen
  no other key" pops the Start menu.
- Exits when its stdin closes, so it can never outlive the app.

`Win+C` is the only key bound out of the box. If the helper is missing or
refuses to start, Wumpy says so in the tray tooltip and the panel header, and
you can still open the panel by clicking the tray icon — or add an accelerator
of your own to `hotkeys` in settings. Verify the helper independently with:

```powershell
npm run hook:test         # -> hook=ok sizeof(INPUT)=40 sendinput=ok
```

### Prefer the registry route?

If you have admin and would rather disable Copilot outright than run a hook,
`scripts/claim-win-c.ps1` sets the policy key and backs up the previous state to
`%LOCALAPPDATA%\Wumpy\copilot-backup.json`. Run it **elevated**;
`scripts/restore-copilot.ps1` puts everything back exactly as found. With
Copilot off, add `Super+C` to `hotkeys` in settings and the plain accelerator
path will work.

## Thinking tiers

Four tiers, split across two modes. The mode switch (`Ctrl+D`, or the badge in
the header) repaints the panel and swaps which pair of tiers is on offer.

| Tier | Mode | Model | Speed | For |
| --- | --- | --- | --- | --- |
| **Flash** | Quick (light) | `llama3.2:3b` | ~instant | one-liners, lookups |
| **Fast** | Quick (light) | `llama3.2:3b` | fast | the everyday default |
| **Thinker** | Dev (dark) | `qwen3:4b` | slow | reasons; can run commands |
| **Deep Thinker** | Dev (dark) | `qwen2.5-coder:14b` | very slow | real code; can run commands |

Jump straight to one with `Ctrl+1`–`Ctrl+4`; picking a tier also switches to its
mode, so the theme always matches what is answering. A tier whose model is not
installed is shown greyed out with the `ollama pull` line you need — Wumpy never
downloads anything on its own. Each tier carries its own context size, token
budget, temperature and system prompt; see `src/shared/tiers.ts`.

## Why it is fast now

Ollama's ROCm build does not support the Radeon 680M/780M integrated GPUs in
Ryzen 7000-series laptops, so inference there runs **100% on the CPU** at
roughly 7-9 tok/s for a 3B model. That number is the hardware ceiling. What was
actually making Wumpy feel slow was everything around it.

Measured on a Ryzen 7 7735U:

| | time to first word |
| --- | --- |
| cold model (3.5s load every message) | 4,729 ms |
| **warm model** | **187 ms** |
| qwen3:4b, reasoning before answering | 34,030 ms |

Two fixes, both worth more than any amount of prompt tuning:

- **Models stay resident.** `keep_alive` is 30m and Wumpy preloads the current
  mode's tiers at startup via `/api/generate` with an empty prompt. A cold load
  costs ~3.5s; a warm one ~8ms. The green pip on a tier means it is loaded.
- **The default tier does not reason.** qwen3 emits 700-2100 characters of
  private scratchpad before its first visible token, which on CPU is tens of
  seconds. Quick mode uses a non-reasoning model; reasoning is opt-in via
  Developer mode, where you have accepted the wait.

Things that did **not** help, so they are not in the code: raising `num_thread`
(16 threads measured *slower* than 6 — 8.0 vs 9.0 tok/s), and shrinking
`num_ctx`. Changing options between requests does not force a reload, so
per-tier options are free.

> **Never send `think: false`.** On Ollama 0.35.1 + qwen3:4b it makes the model
> reason anyway and dump the scratchpad into the answer with a stray
> `</think>`, for no token saving (47 vs 44 tokens). Wumpy omits the flag
> instead, which lets Ollama parse reasoning into its own field and keeps the
> answer clean.

## How the streaming feels

Ollama delivers whole tokens about four to eight times a second, so rendering
each one as it lands makes text arrive in visible lumps. Wumpy buffers incoming
tokens and releases *characters* on an animation frame instead, draining the
backlog over a fixed window. That is self-balancing: at a steady arrival rate
the reveal settles at exactly that rate, with a cushion so it never stutters to
a halt between tokens.

The model is burstier than it looks: measured, llama3.2:3b emits a token only
every ~316 ms (p50), about six characters at a time. Perfectly even display
therefore needs enough buffer to ride through those pauses, which is a direct
trade against how far behind the model the text runs.

Tuned against captured token timings, scoring gap jitter as a coefficient of
variation (lower is smoother):

| | jitter | p95 gap | lag |
| --- | --- | --- | --- |
| render each token on arrival | 2.19 | 329 ms | 0 ms |
| first attempt (rate floor 28/s) | 1.10 | 217 ms | — |
| LEAD 500, no floor | 0.437 | 83 ms | 497 ms |
| **LEAD 400 + rate floor (shipped)** | **0.428** | **83 ms** | **376 ms** |
| LEAD 650 + floor 0.85 | 0.384 | 67 ms | 548 ms |

400 ms is the knee: both smoother *and* 120 ms less laggy than 500. Going wider
buys very little evenness for real lag.

Two findings worth keeping:

- **The rate floor must stay below the slowest realistic arrival rate.** An
  early attempt set it at 28 chars/s against ~19 chars/s of actual arrival, so
  the reveal outran its own buffer and stalled 762 times in one message —
  measurably worse than no smoothing at all.
- **The one gap that cannot be smoothed is the one after the first character**,
  because no buffer exists yet. In the captured sample the first token carried a
  single character at 3 ms and the second did not arrive until 339 ms. Holding
  the first character back to prebuffer made it worse (650 ms), so it is shown
  the moment it exists and none of the time-to-first-word won by keeping models
  warm is given back.

The caret is a pseudo-element on the last rendered block, so it rides inline
after the final character instead of dropping to a line of its own, and it
breathes on an eased curve rather than a hard on/off blink. Honouring
`prefers-reduced-motion` turns the whole thing off and renders text as it
arrives.

## Chats and context

**Everything auto-saves.** Conversations persist as they happen, one JSON file
each under `%APPDATA%\Wumpy\chats`. There is no save command because there is
nothing to save.

**Titles are written by the model, from your question alone.** The store seeds
a title from the first line so the picker is never blank, then a background
request names the topic once the first answer lands. It runs on the fastest
installed model, capped at 20 tokens. `/rename` overrides it and locks the
title so automatic naming leaves it alone.

Titling from the *answer* as well as the question was a mistake worth recording:
asking "what is speculative fiction" came back as "Exploring the Realm of
Speculative", because the model titled the reply rather than the question.
Measured on llama3.2:3b, the question alone is both accurate and about twice as
fast:

| input to the titler | result for "what is speculative fiction" |
| --- | --- |
| question + answer | Exploring the Realm of Speculative |
| question + answer, few-shot | Science Fiction and Fantasy |
| **question only** | **Speculative Fiction** |

Title casing is applied in code rather than asked for in the prompt, so `CSS`,
`Win+C` and `llama3.2` survive intact.

**`/resume` picks up where you left off.** `Ctrl+R` or `/resume` goes straight
to a keyboard-driven picker — it deliberately takes no argument, because the
picker already searches: type to filter, arrows to move, `Enter` to open, `Del`
to remove.

**Switching thinking level keeps the conversation.** `/level deep`, `/tier
thinker`, the tier buttons and `Ctrl+1`–`Ctrl+4` all carry the full history to
the new model and say how many messages came along.

**The status bar shows where you stand.** A context meter tracks how full the
window is, amber at 65% where auto-compaction begins and red near the limit.
Click it to compact early. Alongside it: live elapsed time, token count and
tokens/sec while a turn streams, then the rate, completion size and model load
time once it lands. The figures come from Ollama's own `prompt_eval_count` and
`eval_count` rather than being guessed from characters — a `~` next to the
percentage means it is falling back to a character estimate, which happens
before the first turn and just after loading a saved chat.

**Long conversations compact themselves.** When the context reaches
65% of the tier's window, Wumpy summarises everything but the last four turns
into a single chip you can expand, and carries it forward as a system message.
`/compact` forces it early. Compaction always runs on the *fastest* installed
model rather than the active tier — it is a simple job, and summarising on a 14B
model would take minutes while you wait to send.

## What the model is told

A local model has no clock, no view of the app around it and no idea which chat
it is in, so without help it guesses. Every turn now carries a short block of
live facts — the date, the active tier, the chat's title and length, the OS and
the working directory — which the model may state directly.

Alongside it, two rules that took measuring to get right. The first draft of the
app rules made a 3B model answer *questions* with slash commands: asked what day
it was, it replied `/day`, a command that does not exist. Separating asking from
changing fixed it outright:

| | before | after |
| --- | --- | --- |
| "what is this chat called?" | Use `/rename` Speculative Fiction | Speculative Fiction |
| "what day is it today?" | Use `/day` | Tuesday |
| "which tier am i using" | /tier | The current tier is Fast |
| "rename this chat to Ideas" | /rename Ideas | /rename Ideas |
| "what's the capital of France" | Paris | Paris |
| | **2/6** | **6/6** |

## Commands

Type `/` in the composer for an autocompleting palette. Arrow keys to move, Tab
or Enter to accept.

| Command | What it does |
| --- | --- |
| `/new`, `/clear` | Start a fresh chat (`Ctrl+N`) |
| `/resume` | Pick up a previous chat (`Ctrl+R`) |
| `/chats`, `/history` | Browse saved chats |
| `/delete` | Delete a saved chat, same picker |
| `/rename`, `/title <text>` | Retitle this chat |
| `/tier`, `/level <name>` | flash \| fast \| thinker \| deep, keeping context |
| `/mode [quick\|dev]` | Toggle Quick / Developer |
| `/dock <position>` | Move the panel |
| `/reasoning on\|off` | Show the scratchpad |
| `/pin`, `/autohide on\|off` | Keep on top, or hide when you click away |
| `/compact` | Summarise older turns to free context |
| `/warm` | Preload this tier's model |
| `/stop`, `/help`, `/quit` | — |

And the prompt wrappers, which reshape the request rather than acting on the app:

| Command | What it does |
| --- | --- |
| `/plan <text>` | Numbered plan first, no solution yet |
| `/btw <text>` | One line, no preamble |
| `/explain <text>` | Plain explanation with one example |
| `/fix <text>` | Root cause, then corrected code |
| `/review <text>` | Real bugs only, not style |
| `/cmd <text>` | Just the command line |

Saved chats live as one JSON file each under `%APPDATA%\Wumpy\chats`.

## Shape and position

The panel is either a **tall bar** on the left or right edge, or a **compact
card** in any of the four corners — the same UI with the chrome trimmed down.
Cycle positions with the glyph in the header, `/dock`, or the tray menu.

## Running commands

Developer-mode tiers can propose shell commands. **Nothing ever runs without a
click.** The model only emits text: it writes a fenced block tagged `wumpy-run`,
the panel renders that as a card showing the exact command, and the Run button
is the permission gate. A command that arrives through something the model read
is still shown verbatim before anything happens.

```
┌──────────────────────────────────────┐
│ POWERSHELL            [Skip]  [Run]  │
├──────────────────────────────────────┤
│ Check whether Ollama is installed    │
├──────────────────────────────────────┤
│ Get-Command ollama -ErrorAction …    │
└──────────────────────────────────────┘
```

**Every command states its purpose.** The model must open the block with a `#`
line saying why it wants to run it, and the card shows that above the command —
because "delete everything under Downloads" and "check whether Ollama is
installed" are similar as shell syntax and nothing alike as decisions. A block
that arrives without a reason is flagged in red rather than quietly accepted.

Afterwards the output is handed back to the model so it can carry on, trimmed
to 3,000 characters — a directory listing can easily outweigh the whole
conversation on a 8k window.

| | |
| --- | --- |
| Shells | PowerShell (default), `wumpy-run-cmd`, `wumpy-run-bash` |
| Timeout | 120s, then killed |
| Output cap | 100 KB per stream |
| Working directory | `shellCwd`, or your home directory |
| Off switch | `shellEnabled: false` in settings |

Commands matching a risky pattern — recursive deletes, `shutdown`, `diskpart`,
`reg delete`, piping a download into a shell, `git push --force` — turn the card
red and additionally require a **native confirmation dialog** that the page
cannot draw or dismiss itself. That list is advisory, not a sandbox: it is there
so you see what you are agreeing to, not to decide for you what is safe.

### Why Developer mode only

Measured on llama3.2:3b, a 3B model decides wrongly about half the time. Asked
"is ollama installed", it answered "No, Ollama is not installed on your PC"
from memory rather than checking. Asked "what's the capital of France", it
proposed running `Get-Location`. Tightening the prompt moved it from 3/6 to 4/6
correct, which is not good enough to hand a shell. Flash and Fast therefore
never receive the capability, and the system prompt that describes it is only
attached for tiers that have it.

## Look and feel

The two modes are visually distinct, because knowing which one is answering
matters more than consistency:

- **Quick** is a light grey panel. A single highlight sweeps across it about a
  second after the panel opens, then never again until the next summon.
- **Developer** is near-black with segmented strands of binary falling behind
  the content, each with a bright leading glyph and a tail that fades out behind
  it. Digits churn every 110 ms.

Both are built to cost nothing. Motion is `transform`-only so the compositor
handles it on the GPU, the binary churn mutates characters in an array rather
than animating hundreds of elements, and neither renders at all while the panel
is hidden. `prefers-reduced-motion` disables both.

The panel is **opaque on purpose**. It originally used a translucent background
with `backdrop-filter: blur()`, but Electron's transparent window gives the
filter no backdrop to sample, so the blur silently did nothing while whatever
was behind stayed sharply readable through the panel. Solid beats a filter that
does not run.

### Icons

Every icon is generated from one source file, `logo.png`, by `npm run icons`:
the tray icon, the app icon, a multi-resolution `.ico`, and the mark the panel
shows. The script decodes the PNG, box-filters it down to each size and applies
a real rounded-corner alpha mask, so nothing but the source artwork is
committed. It runs automatically on `npm install`.

## Settings

Tray → **Open settings file**, or edit `%APPDATA%\Wumpy\settings.json`. Model
and toggle changes apply immediately; hotkey changes apply on restart.

| Key | Default | Meaning |
| --- | --- | --- |
| `ollamaHost` | `http://127.0.0.1:11434` | Where Ollama is listening |
| `mode` | `quick` | `quick` (light) or `dev` (dark) |
| `tier` | `fast` | Selected tier |
| `dock` | `right` | `left`, `right`, or a corner |
| `tallWidth` | `440` | Width of the tall bar, px |
| `compactWidth` / `compactHeight` | `460` / `420` | Size of the corner card, px |
| `hideOnBlur` | `false` | Collapse when focus moves away |
| `autoSave` | `true` | Persist every chat as it happens |
| `autoCompact` | `true` | Summarise older turns when context fills |
| `showReasoning` | `false` | Expand the scratchpad by default |
| `hotkeys` | `[]` | Extra accelerators; `Win+C` comes from the hook |
| `keepAlive` | `30m` | How long Ollama holds a model resident |
| `warmOnStart` | `true` | Preload tier models at startup |
| `shellEnabled` | `true` | Let Dev tiers propose commands |
| `shellCwd` | `""` | Working directory; empty means home |
| `tierModels` | `{}` | Per-tier model overrides |
| `launchAtLogin` | `false` | Start with Windows (packaged builds only) |

## Keys

| Key | Action |
| --- | --- |
| `Win+C` | Toggle the panel (also: click the tray icon) |
| `Ctrl+1`–`Ctrl+4` | Jump to Flash / Fast / Thinker / Deep |
| `Ctrl+D` | Toggle Quick / Developer mode |
| `Ctrl+N` | New chat |
| `Ctrl+R` | Resume a previous chat |
| `/` | Command palette |
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Stop generating, close the list, or close |

**Pin** in the header keeps the panel open while you work in another window —
otherwise it hides the moment it loses focus, which is usually what you want
from an overlay.

## How it works

```
src/
├─ main/           Node — owns the OS and the network
│  ├─ index.ts        lifecycle, IPC, model reconciliation
│  ├─ panel.ts        the always-on-top overlay window
│  ├─ hotkey.ts       accelerator registration with fallback
│  ├─ lowlevelhook.ts drives the Win+C helper process
│  ├─ ollama.ts       streaming client, abort, capability detection
│  ├─ tray.ts         tray icon and menu
│  ├─ chats.ts        saved conversations
│  └─ store.ts        settings JSON
├─ hook/           C# — the WH_KEYBOARD_LL helper
├─ preload/        the only bridge between main and renderer
├─ renderer/       React — pure UI, no network access
│  └─ commands.ts    slash commands and prompt wrappers
└─ shared/         types, tier definitions, defaults
```

Decisions worth knowing:

- **The window is created once at startup and only shown/hidden**, so the hotkey
  feels instant instead of booting a renderer on every press.
- **All network calls live in the main process.** The renderer has no Node
  integration, context isolation on, and a CSP permitting no remote origins.
- **The window is a `toolbar` type**, keeping it out of Alt+Tab so it reads as an
  overlay rather than a window you have to manage.
- **`screen-saver` is the always-on-top level** — the only one that reliably
  floats above fullscreen browsers.
- **Icons are generated, not committed**: `npm run icons` draws them and emits a
  multi-resolution `.ico`.

## Roadmap

- [x] Streaming chat against a local model
- [x] Tray, overlay panel, and a genuine `Win+C` override
- [ ] Shell agent — "install ollama" checks, then runs the install
- [ ] Code editing against a workspace, backed by `qwen2.5-coder:14b`
- [ ] Screen awareness, so it can answer about what you are looking at
- [ ] Conversation history across sessions

## License

MIT
