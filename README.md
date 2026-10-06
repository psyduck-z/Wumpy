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
| **Thinker** | Dev (dark) | `qwen3:4b` | slow | reasons before answering |
| **Deep Thinker** | Dev (dark) | `qwen2.5-coder:14b` | very slow | real code |

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

## Commands

Type `/` in the composer for an autocompleting palette. Arrow keys to move, Tab
or Enter to accept.

| Command | What it does |
| --- | --- |
| `/new`, `/clear` | Start a fresh chat (`Ctrl+N`) |
| `/save <title>` | Save this chat (`Ctrl+S`) |
| `/chats`, `/history` | Browse saved chats |
| `/load <name>` | Open a saved chat by name |
| `/delete <name>` | Delete one, or `/delete all` |
| `/rename <title>` | Rename the current chat |
| `/tier <name>` | flash \| fast \| thinker \| deep |
| `/mode [quick\|dev]` | Toggle Quick / Developer |
| `/dock <position>` | Move the panel |
| `/reasoning on\|off` | Show the scratchpad |
| `/pin on\|off` | Stay open when focus moves |
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
| `hideOnBlur` | `true` | Collapse when focus moves away |
| `showReasoning` | `false` | Expand the scratchpad by default |
| `hotkeys` | `[]` | Extra accelerators; `Win+C` comes from the hook |
| `keepAlive` | `30m` | How long Ollama holds a model resident |
| `warmOnStart` | `true` | Preload tier models at startup |
| `tierModels` | `{}` | Per-tier model overrides |
| `launchAtLogin` | `false` | Start with Windows (packaged builds only) |

## Keys

| Key | Action |
| --- | --- |
| `Win+C` | Toggle the panel (also: click the tray icon) |
| `Ctrl+1`–`Ctrl+4` | Jump to Flash / Fast / Thinker / Deep |
| `Ctrl+D` | Toggle Quick / Developer mode |
| `Ctrl+N` / `Ctrl+S` | New chat / save chat |
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
