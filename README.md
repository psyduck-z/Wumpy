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
ollama pull llama3.2:3b
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

If the helper is missing or refuses to start, Wumpy falls back to whatever
accelerator it *can* register (`Alt+Space` by default) and says so in the tray
tooltip and the panel header. Verify the helper independently with:

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

## Model choice matters more than you would expect

Ollama's ROCm build does not support the Radeon 680M/780M integrated GPUs in
Ryzen 7000-series laptops, so inference there runs **100% on the CPU**. On that
budget, a model that *reasons before answering* is the difference between an
overlay and a progress bar.

Measured on a Ryzen 7 7735U, time until the first visible word:

| Model | "Reply with exactly: PONG" | One-sentence explanation |
| --- | --- | --- |
| **llama3.2:3b** | **0.5 s** | **0.7 s** |
| qwen3:4b | 34.0 s | 77.2 s |

qwen3 is not broken and it is not a worse model — it simply emits 700–2100
characters of private scratchpad before its first visible token, and on CPU that
is tens of seconds. So Wumpy defaults to a non-reasoning model, and you can
switch in the header dropdown when you want depth over speed. The footer reports
the measured tokens/sec for the last answer.

> **Never send `think: false`.** On Ollama 0.35.1 + qwen3:4b it makes the model
> reason anyway and dump the scratchpad into the answer with a stray
> `</think>`, for no token saving (47 vs 44 tokens). Wumpy omits the flag
> instead, which lets Ollama parse reasoning into its own field and keeps the
> answer clean. The `thinking` setting therefore controls whether reasoning is
> *shown*, not whether the model reasons.

## Settings

Tray → **Open settings file**, or edit `%APPDATA%\Wumpy\settings.json`. Model
and toggle changes apply immediately; hotkey changes apply on restart.

| Key | Default | Meaning |
| --- | --- | --- |
| `ollamaHost` | `http://127.0.0.1:11434` | Where Ollama is listening |
| `chatModel` | `llama3.2:3b` | Falls back to an installed model if missing |
| `systemPrompt` | terse assistant | Prepended to every conversation |
| `hotkeys` | `["Alt+Space"]` | Extra accelerators; `Win+C` comes from the hook |
| `hideOnBlur` | `true` | Collapse as soon as focus moves away |
| `thinking` | `false` | Show a reasoning model's scratchpad |
| `panelWidth` | `440` | Panel width in px |
| `launchAtLogin` | `false` | Start with Windows (packaged builds only) |

## Keys

| Key | Action |
| --- | --- |
| `Win+C` (or `Alt+Space`) | Toggle the panel |
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Stop generating, or close |

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
│  └─ store.ts        settings JSON
├─ hook/           C# — the WH_KEYBOARD_LL helper
├─ preload/        the only bridge between main and renderer
├─ renderer/       React — pure UI, no network access
└─ shared/         types both sides agree on
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
