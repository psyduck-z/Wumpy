# Wumpy

An AI assistant for Windows and Omarchy that can run commands on your machine,
talk through your earbuds, and have a second model check its work.

On **Windows** Wumpy lives in the system tray with no window of its own. Press
`Win+Z` (or the Copilot key) and a panel slides in against the edge of
your screen, floating above whatever you are working in — including fullscreen
browsers. Press `Esc` and it is gone.

On **Omarchy** (Arch Linux + Hyprland) it is an ordinary app window that
Hyprland tiles like any other, with the same tray icon. `Super+Z` opens
it, takes you to it if it is open on another workspace, and hides it again —
see [On Omarchy](#on-omarchy).
It talks to [Ollama](https://ollama.com) on `127.0.0.1`, so nothing you type
leaves the machine.

```
┌──────────────────────────────────┐
│ ● Wumpy   Win+Z       [llama3.2] │
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
npm run hook:build        # builds the Win+Z interception helper
ollama pull llama3.2:3b   # Flash + Fast; other tiers use models you already have
npm run dev
```

The panel appears on launch. After that it hides in the tray and answers to
`Win+Z`.

To build an installer:

```powershell
npm run package           # -> dist/Wumpy-0.1.0-setup.exe
```

Or from any computer: every push to `main` builds it on GitHub's Windows
machines (`.github/workflows/windows.yml`), runs the checks there too, and
publishes it as a numbered release, `0.1.<run>`, on the
[releases page](https://github.com/psyduck-z/Wumpy/releases). That one
bundles .NET into the Win+Z helper, so it needs nothing else
installed. On Linux without Windows, `npm run package` needs Wine
(`pacman -S wine`): electron-builder runs the installer under it to make the
uninstaller.

**It keeps itself up to date.** An installed Wumpy on Windows looks for a
newer release a minute after it starts and every 30 minutes after, downloads it
quietly, and installs it the next time Wumpy restarts - starting the new
version itself. Develop on one computer, push, and the Windows PC catches up
on its own. `[update]` lines in `wumpy.log` say what it found.

`npm run check:live` runs the voice for real in Electron, on a fake
microphone playing a made-up voice, with no sound played: the recorder on a
sentence with a pause and a dead-mic gap in it, then two whole conversations
(talking over an answer, a cough over one, a mumble, a command approved out
loud) with the transcriber, model and voice stood in for. The Windows
workflow runs it too, in Windows' own Chromium.

## On Omarchy

```bash
npm install
npm run install:linux     # builds, then installs to ~/.local/share/wumpy
wumpy                     # or from the app launcher
```

`install:linux` puts a `wumpy` command in `~/.local/bin`, a launcher entry and
an icon, and (once it has run packaged) an autostart entry so it is in the tray
after login. After that, **`/update`** (or "update yourself") does the same
from inside Wumpy: it pulls new commits from GitHub (fast-forward only),
builds, installs and restarts into the new copy. Every 30 minutes it checks
for new commits or edits made since the install, and builds and installs one
in the background while nobody is using Wumpy, then restarts into it quietly
(staying in the tray if it was there). A source folder with uncommitted
changes is work in progress: that waits for `/update`, and the header shows
**Update available**. `/update force` rebuilds anyway. On Windows, an update
installed while Wumpy is in the tray no longer opens the panel afterwards.
Bind the shortcut in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + Z", "Wumpy", "wumpy --toggle")
```

`wumpy --toggle` shows or hides the window, `wumpy --voice` starts or ends a spoken
conversation (below), `wumpy --hidden` starts it in the tray and `wumpy --restart`
restarts it on the chat it was on. `wumpy --speech-check` writes how long
NVIDIA's voice takes to speak and to hear, from this machine and network,
to the log, without playing anything — worth running on a hotspot.
`wumpy --voice-samples` saves each of Magpie's men saying the same lines, at
the speed answers are spoken, to Downloads/Wumpy voices, to choose a voice by
ear. `wumpy --compare-voices` does the same across every voice model the
NVIDIA keys reach (Magpie and Resemble AI's Chatterbox, today), with how soon
each starts speaking and how much Whisper hears wrong, to Downloads/Wumpy
voices/Compared.

What is different from Windows, on purpose:

- **A regular window, not an overlay.** Hyprland places and tiles it; it does
  not float above other windows or vanish when you click elsewhere. The
  overlay's controls — the dock button, the pin, `/dock`, `/pin`, `Ctrl+D`,
  `Ctrl+P`, and `Esc` closing the panel — are left out rather than shown doing
  nothing. Closing the window (`Super+W` or the ×) hides it to the tray; quit
  from the tray menu.
- **Bash, not PowerShell.** The model is told it is on Omarchy and given the
  tools this machine has: `pacman`/`yay`, `hyprctl`, `systemctl`, `wpctl`,
  `bluetoothctl`, the `omarchy-*` commands, `wtype`, `grim`, `notify-send`.
  Anything that needs root goes through `pkexec`, which shows a password box —
  `sudo` cannot ask for a password from inside the app. Every command still
  waits for your approval unless you have said otherwise.
- **Keys in the system keyring** (GNOME Keyring through libsecret), the way
  Windows keeps them with DPAPI.

## Talking to it from your earbuds

`wumpy --voice` starts a spoken conversation without opening the window, and
running it again ends it. Bind it to anything — Nothing X runs it from an
earbud gesture (set **Hold** to *Desktop assistant* under Controls; the command
itself is under App settings → Assistant, and left empty it runs Wumpy from
where its installer put it, on Windows too). On Windows it is
`"%LOCALAPPDATA%\Programs\Wumpy\Wumpy.exe" --voice`: the installer adds
nothing to `PATH`, so a bare `wumpy` is not found there.

- **Hearing** is Whisper large-v3 on NVIDIA, with Parakeet when Whisper
  fails, and **speaking** is NVIDIA's Magpie, in
  its male voice Jason, neutral (`wumpy --speech-check` lists the others,
  `wumpy --voice-samples` lets you hear the men), on the
  same NVIDIA keys as chat (`/key nvidia <key1> <key2>`), from the same
  rotation. Each key is treated as its own account with its own rate limit, so
  add every key from a different account. With
  no key, dictation falls back to local Whisper (`npm run speech:install`) and
  answers to the system voice.
- **Hold to start, hold again to finish.** One short dot says it felt the
  hold. Bluetooth earbuds take a moment to switch their mic on — on some
  machines several seconds — and it ticks, one key at a time, while they do.
  Two notes going up then mean the mic really is on: talk. From there it is a
  conversation: say something, it answers, say the next thing — no gesture
  and no chime in between, because the mic stays open until you finish, so
  the earbuds switch only once. Soft typing, in threes, means it is working
  on what you said. A pause of a second and a half ends what you are saying
  — three seconds when you trail off mid-thought, on an "and" or an "um";
  carry on while it is still working it out and the rest is added rather
  than sent as half a question, and a moment where the mic drops out is not
  taken for a pause. Talk over an answer and it stops at once: ask something
  else and that is answered instead, say "stop" or "wait" and it just stops,
  and a cough or an "mm-hm" does not count — it carries on where it was.
  A rolled chord, downwards, says the conversation is over — after a hold, or
  after two minutes with nobody talking. One low note twice means the mic
  never came on. A hold the earbuds report twice in quick succession counts
  once.
- **Only your voice.** `/voice me calibrate` has you read five short
  sentences (on the mic you talk to Wumpy with — your earbuds), and from
  then on someone else talking — a person in the room, a video, a call — is
  not answered, and talking over an answer only pauses it a moment. Without
  calibrating, it learns your voice from the first six things you say in
  conversations instead (each a second and a half or longer), which works
  as long as nobody else gets in first. Everything you say clearly in your
  own voice keeps teaching it, so a new microphone or a tired voice is taken
  in rather than turned away — but always anchored to the sentences you
  read, so it cannot drift into someone else's. Short things ("stop", "the
  second one") are always heard, except a spoken **yes or no to run
  something**: that is checked however short it is, and a "yes" in someone
  else's voice is not taken (three of those and the request stays on the
  screen for a click). The voiceprint is made on the PC by a small model
  (CAM++, 29 MB, fetched once) in a process of its own, and the voice never
  leaves it. `/voice me` says how far it has got; `/voice me off` hears
  everyone, `/voice me forget` starts over. It is a filter for a noisy
  room, not a lock: a recording of your voice would get through.
- **Meetings, heard and seen.** Say **"monitor my PC"** (or "monitor my
  screen") and Wumpy transcribes your speakers and microphone as it goes (no
  audio is kept) and looks at your screen about every 20 seconds. A screen
  that has not visibly changed goes nowhere; one that has is described in a
  few lines (slides, shared documents, names in the call) by a model that can
  see, and the note joins the transcript at its time. The screenshot is sent
  to that model and not kept. **Live notes** appear in the chat once there is
  something to note and are rewritten in place about once a minute — when the
  meeting changes something (a date moves, a decision is reversed) the note
  is changed and the old one struck through, not repeated. Every message you
  send carries the transcript, and "notes" writes up the whole thing. Say
  **"stop monitoring"** to end it; the live notes get one last update.
  "Listen to this meeting" still listens without watching, "watch my screen
  too" adds the screen later, and "stop watching my screen" stops only that.
  On Linux under Wayland the screen is read with `grim`, so there is no
  screen-share prompt (and Wumpy's panel shows in the picture if it is open).
- **Jason talks three tenths faster than Magpie makes him**, at the same
  pitch: Magpie ignores SSML's speaking rate, so the sound is time-stretched
  as it arrives (`speakRate` in settings.json; 1 is as made). Lists — the
  models, your chats — are read a little slower, at 0.85 of that, so the
  names can be kept up with.
- **It speaks while it writes.** Each sentence is said as soon as it is
  finished, while the model is still writing the next, and Magpie's sound is
  played as it is made rather than once the whole answer is ready. The
  connection to NVIDIA opens while you are still talking.
- **A stalled model does not leave you in silence.** If the model has said
  nothing after five seconds, the question goes to the quickest model the
  background ranking has seen answer, and the window notes which one did.
- **It knows it is on your earbuds.** Every request in a conversation says so,
  and the model answers in a sentence or two of plain speech instead of tables
  and lists; typed turns are told you are at the screen. Messages that came
  through the buds carry a small *earbuds* mark in the transcript.
- **Approvals are asked out loud.** When it wants to run a command it asks —
  "Can I check how full the disk is? Say yes or no." — and only *yes* or *no*
  answers it. Anything else, or silence, and it asks again; it cannot be
  skipped by ignoring it. Clicking the card in the window answers it too.
- **Saying "slash" types a command.** "Slash remember I like tea" is
  `/remember I like tea`, not the word "slash" sent to the model. Misheard,
  it asks rather than guesses: "slash love" (Whisper's "slash log") is
  answered "Slash log?", and yes runs it. Put right in the same breath —
  "slash love, I mean slash log" — the correction is what runs. "Slash log"
  reads the day's history out in sentences: the latest few things, then the
  re-ranking as one line.
- **Long turns are heard whole.** Whisper listens in thirty-second windows,
  and a 34-second turn heard in one piece lost 22 of its 119 words. A turn
  longer than 25 seconds is cut at a pause, the pieces heard at once, and
  joined: none lost, and quicker.
- **A lead-in waits for the rest.** "Okay. Also," and then a pause to think
  is not sent on its own to be answered: it goes in front of what you say
  next.
- **Choosing a model out loud.** "Slash model" reads out five, quickly: the
  three best overall, then the smartest and the fastest. Answer with a name,
  roughly — "Nemotron super", "Gemma", even "Jemma" or "deep seek" — or a
  place: "the second one" — or the ranking in any words: "the smartest one",
  "the most intelligent model", "the quickest", "best overall", "a generally
  efficient one", "the fastest Nemotron". A name that fits several ("Nemotron")
  reads those back, best first, and asks again. Say nothing for a couple of
  seconds and it reads the rest, five at a time and numbered on from six; a
  model that is not answering is said to be not answering. "Slash model
  fastest" reads the three quickest instead. Typed, `/model nemotron` does the same matching
  and offers the fits as buttons.
- **Your chats, out loud.** "Slash resume" (or "resume a chat") reads your
  twelve most recent chats with numbers, then, each time you stay quiet for
  a moment, the next five, until it has read them all; say a number or a
  title.
- **It can run Wumpy's own commands.** Ask for it in words — "delete this
  chat", "change the model to Gemma", "use the fastest model", and out
  loud "switch to the smartest model" or "can you change to Nemotron
  Ultra?" — or ask the
  model, which proposes the command on a card. Anything that cannot be undone
  asks first: "Delete this chat, Fish pie? Say yes or no." Typing `/delete`
  yourself still just does it. The model can never run `/key` or `/approve`.
- **Music pauses while it listens and talks**, on both Omarchy (any MPRIS
  player: Spotify, browsers, mpv) and Windows (the media session behind the
  volume flyout), and only what was playing is resumed afterwards — once the
  earbuds are back in their music mode, not while they are still in headset
  mode (mono, no spatial sound) or switching back (when for a moment there is
  no earbud output and it would play from the laptop). Holding the spacebar to
  dictate does the same. Calls are left alone. `/music off` turns it off.

Holding the spacebar in the window dictates into the box instead (`/voice on`
first). If there is nothing to transcribe with, it now says so under the box
rather than silently doing nothing.

## Self-reflection

`/reflect` turns on a second opinion for every task. The model works as usual —
answers, runs commands, reads their output — and when it has finished, the task
and everything done for it go to a **mentor**: the same model (or the one set
with `/reflect model <id>`), sent on your *other* key when you have two, so the
review spends the allowance the work did not. The mentor answers ACCEPT or
REVISE with concrete notes. REVISE goes back to the worker automatically and it
has another go; this repeats until the mentor accepts or the round limit is
reached.

| Command | Does |
| --- | --- |
| `/reflect` | toggle it |
| `/reflect on` / `/reflect off` | turn it on or off |
| `/reflect 5` | allow up to 5 reviews per task (1–8, default 3) |
| `/reflect model <id>` | use a different model as the mentor; `/reflect model` alone resets it |

Each review shows as a note in the transcript — *Mentor reviewing…*, then
*Mentor accepted* or *Mentor asked for changes* with the notes — and a
*reflect* chip sits in the status bar while it is on (click it to turn it off).
A new message from you is a new task and starts the count again. Every review
is one request, so it is off by default.

## A time to stop

Say when to stop, in your own words, and Wumpy keeps the clock:

- "keep refining it and do not continue past 10:30"
- "stop at 10:30pm"
- "keep crunching for half an hour"
- "stop after 2 hours"

It says the time back, shows a **stops 10:30 PM** pill in the status bar, and tells the model each turn how long it has left, so it keeps working instead of stopping to ask. When the time comes it stops the answer and every running agent. Nothing goes out on its own after that, whether a command's output or an agent's report, until you say something. A time without am or pm means the next time the clock shows it, so at 4 pm "10:30" means tonight.

Click the pill, or say "no time limit", to lift it. A time mentioned as a fact ("the meeting is at 10:30") or a timer ("set a timer for 5 minutes") is not a stop time. The phrasings are in `src/shared/deadline.ts` and tested by `scripts/check-deadline.mjs`.

## Background agents

With two keys or more, Wumpy can hand work off and keep talking. Ask for
something "in the background", "while I…", "meanwhile", for several things at
once, or for long work — an essay, a long script, research that needs several
searches — and the chat starts an **agent** for it, with a brief that holds
everything the agent needs (it sees nothing of the chat). A card in the answer
shows what each agent is doing, the commands it ran, and its report.

- **How many.** One key is always the chat's. With 2–4 keys, the rest are agents'
  (3 keys: 2 agents). From 5 keys on, two go to the chat for every three to
  agents (5 keys: 3 agents; 10 keys: 6). More asked for than that wait their turn.
- **Each holds its own key** while it works, so the chat and the voice are never
  queued behind one.
- **They only read.** An agent runs a command or a web search only if it reads
  and your approval mode would run it without a click; in manual mode it works
  from the brief alone. It never changes anything, even on accept-all: it hands
  back the text — the script, the letter — and the exact command for any
  change, and the chat makes the change the usual way.
- **They check each other.** Each report is read by a fresh reviewer against the
  brief and the commands' real output: accepted, or sent back with notes, at
  most twice. Claims the output does not show get sent back.
- **Reports come back by themselves**, as a message the chat answers, once that
  chat is open and idle — with the list of what the agent actually ran, so the
  chat can tell a finding from a guess. A **monitor** (a `wumpy-monitor` block)
  makes the chat wait for a set of agents and wake once they are all done, with
  a note of what it meant to do then. Monitors only watch agents, so they need
  no permission.
- Agents do not survive Wumpy restarting.

`wumpy --agents-check` tries all of it on the real models — whether the chat
hands off what it should and only that, three agents on real tasks (one a trap:
plugged in is not charging), and the chat given a report back — and writes
what happened to `wumpy.log`. It is how the instructions were tuned; the runs
found the chat refusing to work in the background, agents asking for the same
refused command ten times, a script agent trying to save a file instead of
handing it back, reviewers undoing each other, and the chat filling in numbers
a report never had. All fixed, and in `npm run check:agents`.

### Building things

Asked for a game, a page, an app or a program — in any language — or a change
to one ("now make it look like a neon arcade"), the chat hands it to a
background agent instead of writing it in its reply, and writes the file when
the agent's report comes back. The rule is in its instructions and, because
that alone was not enough, said again beside the message that asks — and if
the chat writes a game itself anyway, that write is held and the request goes
to an agent. A change to something built ("make it so I die when a car hits
me") goes to an agent too, which reads the saved file and edits it in place
rather than typing it out again. On the way:

- **A page is played, not just loaded.** Out of sight, in a sandboxed window
  with no network, Wumpy loads it, finds its player (a `player`, `chicken`,
  `frog`, the head of a `snake`, a `pacman`...), holds each arrow key in turn
  — and Space, Enter and a click for a title screen — and checks the player
  moved. Then it plays on until the game is over, tries Space, Enter, R and
  the page's own restart button, and checks a new game really runs. It
  watches the ghosts, cars and aliens too: ones that never leave where they
  started, or that cross the screen in under a second, are reported.
- **The player stands in the road.** In a game with cars, Wumpy puts the
  player in a lane with traffic — placed there if walking would end in a
  river — and waits for a car. One that drives right through, with no game
  over and no life lost, sends the page back; so do a lane's cars sitting on
  top of one another and moving as one.
- **A program is compiled, never run.** Python is parsed, every name it uses
  is looked up and every import checked against what is installed (and which
  of tkinter, pygame and curses this Python can draw with); C and C++ are
  compiled and linked with every warning on, into a folder deleted after;
  JavaScript gets `node --check` and shell scripts `bash -n`. An `#include`
  reaching outside the program is refused. With no Python or compiler on the
  computer, the check says so rather than passing.
- **A terminal game is played, in a sandbox.** On Linux, a C, C++ or Python
  program that reads the keyboard (curses, termios, pygame...) runs for six
  seconds inside bubblewrap — no network, no home folder, the system
  read-only, killed after — with Space, Enter and the arrows pressed. A
  crash, a traceback, a program that never draws, or one that quits by
  itself at its own "play again?" comes back as a bug. C and C++ run with
  AddressSanitizer and UBSan, so an index off the end of an array stops the
  program at that line every time instead of crashing one run in five.
- **A tkinter game is played too**, through a stand-in tkinter that needs no
  screen, in the same sandbox, on the game's own clock: minutes of play in
  a second — keys pressed, played to game over, restarted, and watched for
  a loop that stopped (a Tetris whose restart left the piece hanging) or a
  canvas that stopped changing while the game was not over (one whose
  second piece never came). The game's own clocks — `time.time()`, Tcl's
  `clock milliseconds` — follow the stand-in's, and what the stand-in
  cannot follow is never blamed on the game.
  On Windows, programs are compiled or parsed and not run.
- **Errors come back with the lines they point at,** to the agent before any
  review, and to the chat when it writes a file itself.
- **Agents can look inside what they built.** A `wumpy-probe` block plays
  the agent's page as it says — `press: Space, ArrowLeft`, `wait: 500` — and
  reads back any expression on it — `show: pacman`, `show: canMove(3, 4,
  'left')` — so "the player did not move" is answered by looking, not by
  rewriting the movement code blind. `wumpy-show` gives it the file as it
  is now, after its edits; older versions are dropped from what it reads.
- **Fixes are edits, not rewrites.** An agent changes the file in its last
  report with `wumpy-edit` blocks — FIND the lines as they are, REPLACE with
  the new ones — instead of writing twenty thousand characters again and
  breaking what the last version fixed. All the edits are made or none.
- **The file is saved as the agent wrote it.** The chat's write block says
  `from: agent-3` and Wumpy copies the agent's tested file itself; the
  hand-back does not even show the chat the file, so it cannot retype it
  (and a slip in nine thousand characters once broke a working page). A
  build that never passed is not offered for saving at all: the chat is
  told to say so and try again with what broke.
- **The reviewer can see.** When the model takes pictures, the agent that
  reviews a built page is shown it mid-game, as a player would see it — a
  Pac-Man maze typed in rows of different lengths passed every other check.
  A build gets three reviews rather than two.
- **Long replies are stitched cleanly.** A build agent may write sixteen
  thousand tokens a turn, so a whole game usually fits in one; when one is
  cut off and continued, whatever the continuation repeats of the cut line
  is dropped, since the seams were where code broke ("missing ) after
  argument list"). A reply that runs past 45,000 characters is not carried on
  but sent back to be written smaller, and no turn can hang: each has a
  watchdog past its own timeout.
- **The rules for building** are sent to an agent whose brief is for one: a
  game starts on a key press and never kills the player first; game over
  restarts a game that runs; speeds are per second, and
  `requestAnimationFrame` time is milliseconds; one unit for every size and
  position; maps built in code from rectangles and flood-filled as they
  start, never typed as rows that must line up; sizes taken from the data;
  grid games moving tile centre to tile centre; a basic game in a few
  hundred lines.

`wumpy --build-check=<request or spec.json>` plays a request through all of it
— the chat's real instructions, model and keys, its agents, their reviews, the
file written and checked — writing only into `~/Downloads/wumpy-tests` and
running only commands that read, and saves the exchange beside the log.

It came from a retro Crossy Road written in one go and called playable: it
crashed on its first frame (`car is not defined`), the cars crossed the screen
in a twentieth of a second, and the score never went up — and three "fixes"
later most of that was still true, because the model never ran or reread it.
Then a Snake whose Play Again hid the message and left the snake frozen for
ever, a Pac-Man whose ghosts never left their pen, and a Crossy Road whose
cars were thirty tiles wide: each is now something the check finds.

### Each key's real limit

When Wumpy has been idle for ten minutes — no answer, no agent, the panel away —
it tests one key a day: tiny one-token requests, a little faster than the stated
40 a minute, until the key refuses or 75 seconds pass. What it took in the
minute before refusing is its limit, and the pacer keeps a tenth under that on
that key from then on, instead of one figure for every key. It stops the moment
you use Wumpy, and `/log` records each result ("key 2 takes 40 requests a
minute").

## How the Windows shortcut is taken

The shortcut is `Win+Z` (and the dedicated Copilot key), which takes over
Windows 11's own Win+Z snap-layouts flyout. It was `Win+Shift+Z` until
late November 2026, `Win+Shift+D` before that, and `Win+C` before that; the reasoning below — written for that key — is why the hook
exists at all.

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

- Watches for `D` while either Windows key and Shift are held (`--shift`),
  plus the dedicated Copilot key (which reports itself as `Shift+Win+F23`).
- Returns `1` from the hook callback, so the shell never sees the key.
- Injects a harmless `Ctrl` tap, because otherwise releasing `Win` having "seen
  no other key" pops the Start menu.
- Exits when its stdin closes, so it can never outlive the app.

`Win+Z` is the only key bound out of the box. If the helper is missing or
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

## Does the slower tier earn it?

Benchmarked on the same thirteen cases:

| | correct | tok/s | first word |
| --- | --- | --- | --- |
| **phi4-mini:3.8b** (Fast) | 12/13 | **9.0** | **1.5 s** |
| qwen2.5:7b (Thinker) | **13/13** | 2.9 | 7.2 s |

Thinker is genuinely more careful — perfect instruction following where Fast
drops one — and it is three times slower to produce a word. Both score 5/5 on
command decisions, so for *running things* Fast is the better tool, and it can
already read the machine. Reach for Thinker when the thinking is the point, not
when you want a directory listing.

## Tuning the prompt, and knowing when to stop

`npm run bench` scores a model against what the panel actually asks of it. Two
things had to be fixed before its numbers meant anything.

It kept its **own copy** of the prompts, which went stale the moment the real
ones were trimmed — it had been scoring a prompt that had not shipped for
several commits, and reporting a failure the app did not have. It now imports
them from `src/shared/tiers.ts`, so it cannot drift again.

It also ran each case **once**, which is not enough to see past sampling noise.
On one temperature sweep the same model scored 4/6 and 6/6 on identical
questions; two prompt experiments were called a win and a loss on that basis,
wrongly. `--repeat N` now averages, and prints `~` for a case that passes
sometimes.

With honest measurement, most tuning ideas turned out to be worthless:

| change | logic | notes |
| --- | --- | --- |
| current prompt | 11/15 | baseline, bare |
| "work it out in two short lines first" | worse | 4/6 against 5/6 |
| "these questions often have a trap" | no change | |
| a worked trap as a few-shot turn | **much worse** | 3/6, and 35% more tokens |
| temperature 0.0 – 0.6 | no signal | variance exceeded any effect |

What did work was taking prompt *away*. Reasoning degrades as the preamble
grows — 11/15 bare, 6/15 with the old app rules attached — and those rules had
become redundant once `matchIntent` started catching "rename this chat" before
any model saw it. The short replacement answers app questions **11/12 against
9/12**, leaves reasoning alone, and costs 38 fewer tokens per turn.

Scored on the shipped prompts, three runs each: **39/39**.

| | logic | instruction | wumpy rules | shell |
| --- | --- | --- | --- | --- |
| phi4-mini:3.8b | 4/10 | 12/12 | 12/12 | 15/15 |

Everything Wumpy asks of a model is right every time. Reasoning is where a 3.8B
model is weak, and no amount of prompting moved it — that is a model-size
limit, and the lever for it is `/tier`, not another instruction.

## Which model, measured here

Published benchmarks run on hardware nobody here owns, against tasks Wumpy never
performs. `npm run bench` scores every installed model on this machine, on what
the panel actually asks of it: logic puzzles with checkable answers, terse
instruction following, Wumpy's own asking-versus-changing rule, and whether it
proposes a command to check the machine rather than guessing. Every check is
machine-graded; nothing is judged by reading it.

Scored 70% correctness, 30% responsiveness, on a Ryzen 7 7735U:

| model | overall | instruction | wumpy rules | shell | tok/s | first word |
| --- | --- | --- | --- | --- | --- | --- |
| **phi4-mini:3.8b** | **95** | 3/4 | 4/4 | **5/5** | 9.2 | 1.3 s |
| llama3.2:3b | 89 | 3/4 | 4/4 | 4/5 | **12.1** | 1.2 s |
| gemma3:4b | 64 | **4/4** | 4/4 | 3/5 | 9.9 | 8.7 s |
| qwen3.5:2b | 6* | 0/4 | 1/4 | 0/5 | 8.8 | 48.4 s |
| qwen3.5:4b | 6* | 0/4 | 1/4 | 0/5 | 5.7 | 76.9 s |

Only the four tier models are kept installed; the rest were removed after
benchmarking. Re-run `npm run bench` after pulling anything new.

**phi4-mini:3.8b is now the Fast tier.** It is the only model that got every
shell decision right — proposing a command when the answer depends on the
machine, and answering directly when it does not. That was the exact weakness
that kept the CLI out of Quick mode.

Two honest caveats:

- *The qwen3.5 scores are not a quality verdict.* Both are reasoning models and
  spend their whole token budget on scratchpad before emitting a visible answer;
  asked directly, qwen3.5:4b does reply "PONG" correctly. What the benchmark
  does establish is latency, and **48 to 77 seconds to the first word** rules
  them out of a panel you summon mid-task however clever they are.
- *gemma3:4b has the best instruction following of the lot* and a 8.7 s first
  word, because it carries a vision tower that has to be processed. Good model,
  wrong shape for an overlay.

## Thinking tiers

Four tiers, split across two modes. The mode switch (`Ctrl+D`, or the badge in
the header) repaints the panel and swaps which pair of tiers is on offer.

| Tier | Mode | Model | Speed | For |
| --- | --- | --- | --- | --- |
| **Flash** | Quick (light) | `llama3.2:3b` | ~instant | one-liners, lookups |
| **Fast** | Quick (light) | `phi4-mini:3.8b` | fast | the everyday default |
| **Thinker** | Dev (dark) | `qwen2.5:7b` | slow | more depth; can run commands |
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

The model's output is also repaired against the question it came from. Asking
"what are all the ollama ai models i have locally" produced the title
**OLLA MA AI MODELS** — shouted, with a word split in half. Both are fixed
deterministically: a title with no lower case at all is the model shouting
rather than an acronym, and a short fragment that is not a word in the question
is tried joined to the one after it, since "olla" + "ma" is "ollama", which is.
A word the model chose that simply is not in the question is left alone, so
"Quick Pasta Recipe" survives. `npm run check:titles` covers eleven cases.

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

**It remembers what you ask it to, across chats.** "Remember that I prefer
celsius" and the model saves it to your notes. A line in the chat says what
was saved, and the tag it used is never shown or read aloud. The notes are
one plain file (`context.md` in Wumpy's settings folder), read into every
chat, and kept to about a dozen facts because they go with every message.
`/remember <thing>` adds a line yourself; `/remember clear` empties it.

**Skills: instructions for particular things, and each one a command.**
A skill is a folder in the `skills` folder (next to the notes) with a
`SKILL.md` in it, laid out the way Claude's are: how you like summaries, the
rules of a game, a way of working. Every skill is a command: `/grill my plan
to move to Berlin`, `/eli5 how vaccines work`, `/humanize <text>`. They also
come in by themselves: every turn carries one line per skill, and the whole
of one is sent once a word that brings it up is said in the chat ("grill me
on this", "explain like I'm five"), and stays for the rest of it.

Wumpy ships with some, copied into the folder the first time it runs so you
can read and change them. The second half are modelled on Claude's own
skills (skill-creator, brainstorming, systematic debugging, doc co-authoring,
internal comms):

| Command | What it does |
| --- | --- |
| `/grill <plan>` | Relentless questions, one at a time, each with a recommended answer, until every branch of the plan is settled |
| `/eli5 <topic>` | Explained as if to a five-year-old: one idea, one everyday comparison, no jargon |
| `/humanize <text>` | Rewritten so it reads like a person wrote it, without the tells of AI writing |
| `/skill-creator <what>` | Makes a new skill with you: a few questions, then the SKILL.md, saved as a command (`/skills new` uses it) |
| `/brainstorm <idea>` | Shapes a rough idea into a design: questions one at a time, two or three approaches, then the design in sections |
| `/debug <error>` | Finds the cause before fixing anything: reproduce, read the evidence, one hypothesis at a time |
| `/coauthor <document>` | Writes a document with you section by section, then reads it the way its reader would |
| `/comms <what happened>` | A status update, announcement or incident note for a team, the news first |
| `/tldr <text>` | The point in one line, then the few details worth keeping |
| `/proofread <text>` | Spelling, grammar and punctuation fixed with the smallest changes, then a list of them |
| `/decide <choice>` | The options weighed in a small table, and a recommendation with what would change it |
| `/tutor <topic>` | Teaches by asking: hints and one question at a time, not the answer |
| `/detect-ai <text>` | Roughly what share reads as AI-written, the most suspicious passages quoted with their scores and the giveaways, and what reads as human. An estimate, never proof |
| `/fact-check <text>` | Every checkable claim rated true, doubtful, false or can't tell, with the correction or what to look up |
| `/tone-check <message>` | How it will come across, the lines that could land badly, and a better version to send |
| `/grade <work>` | Marked against the rubric (or a sensible one): a grade, why, and the three changes that would raise it most |

A shipped skill you change is yours and stays as you made it; one you
delete stays deleted; one you never touched is updated with Wumpy.

**On the earbuds** a skill is run by saying "use", "run" or "do", its name,
and what it is for: "use grill on my plan", "do a fact check on this",
"run detect AI on my essay". Every skill also answers to easier names,
listed as `aliases:` in its `SKILL.md`: eli5 is "explain like I'm five",
tldr is "sum up", detect-ai is "AI check". Saying "slash" and the name
still works. "What skills do I have?" reads the names out, and the `/skills`
table shows what to say for each one. The result of a skill is spoken as a
summary, such as the grade and the one change that matters, not as its
tables.

`/skills` lists them all. `/skills new <what it should do>` (or "make a
skill that...") has the model write one; `/skills folder` opens the folder.
`/skill <name> <text>` runs one whose name another command already has. A
skill written by hand looks like this:

```markdown
---
name: standup
description: Write my daily standup. Use when I paste what I did.
triggers: standup, stand-up
argument-hint: <what I did>
---
Turn this into a standup with Yesterday, Today and Blockers: $ARGUMENTS
```

**Over Wi-Fi, no account.** `/sync pair` on one device shows a six-digit
code; `/sync pair 482913` on the other pairs them, once. From then on, while
both are on the same network, a skill made, changed or deleted on one shows
up on the other by itself within seconds - same merge rules as below. The
code is never sent (SPAKE2), three wrong tries cancel it, and everything
after is encrypted with the secret only the two devices hold. Nothing
listens on the network until something is paired. On Linux, pairing opens
port 47820 in ufw once, with a password pop-up; Windows asks to allow Wumpy
on private networks the first time. `/sync status` lists paired devices,
`/sync unpair [name]` forgets them.

**On every device, through GitHub.** `/sync on` shares your skills between your devices
through an unlisted gist on your own GitHub account: a skill made, changed
or deleted on one shows up the same on the others, every 30 minutes and a
few seconds after one is saved (`/sync` does it now). Changed on two devices
at once, the newer wins, and a deletion never beats an edit. Shipped skills
nobody changed are not sent. On a machine where `gh` is signed in, that is
all it needs; elsewhere, `/sync key <token>` with a GitHub token that has
only the **gist** scope (kept encrypted, never in input history). An
unlisted gist can be read by anyone who has its link, so keep secrets out of
skills. `/sync off` stops it (and Wi-Fi sync), and with both set up, `/sync`
runs both. Also: "make yourself a skill for...", "save
that as a skill" and "turn what we just did into a skill" all go through
`skill-creator`, which writes the method from the conversation itself.

`$ARGUMENTS` is what followed the command (left out, it goes at the end).
`disable-model-invocation: true` makes a skill a command only, never brought
in by a trigger word; `user-invocable: false` makes it the opposite. A
single `<name>.md` file still works too.

**Games keep their secrets.** A model forgets everything between turns
except the conversation, so a hangman word it never wrote down was gone by
the next guess. It now keeps a note to itself in its answer, a `<keep>` tag
that is never shown or said, with the word spelled out and the guesses so
far, and checks each guess against it. `wumpy --memory-check` tries all
three on the model in use.

## What the model is told

A local model has no clock, no view of the app around it and no idea which chat
it is in, so without help it guesses. Every turn now carries a short block of
live facts — the date, the active tier, the chat's title and length, the OS and
the working directory — which the model may state directly.

Each message you write goes out with the time you sent it — `[sent Thu 19 Nov,
7:26 am]`, and `- 9 hours after their last message` after a long gap — so the
model knows the time, sees when you were away, and checks again rather than
trusting a command it ran before the gap. Only the model sees the stamp; your
chat shows what you typed.

It must check every fact about the computer with a command, and a check of one
thing does not answer the next question: asked "am I plugged in?" it checked,
but asked "is current going in?" it said yes from the plug, twice, while the
battery said "Not charging" (a charge limit). Now it checks that too, and when
asked again or doubted, it checks rather than repeating itself.

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

## Everything selectable is a list

`/resume`, `/delete`, `/tier`, `/model` and `/dock` all open the same picker:
type to filter, arrows to move, `Enter` to choose, `Esc` to back out. Commands
that take a name still accept one, but never require it — you should not have to
remember what things are called when the app can just show you.

## Prompt caching, or: where six seconds a turn went

llama.cpp reuses the KV cache for the longest common *prefix* of a request. Wumpy
sends live facts — the date, the active tier, the chat's title — and these were
placed at the front of the system prompt. Changing text at the front invalidates
the cache for everything behind it, which is the entire prompt and the whole
conversation.

Measured on llama3.2:3b with a 262-token prompt:

| arrangement | prefill per turn |
| --- | --- |
| live facts first (what Wumpy did) | **6,100–8,200 ms** |
| live facts last | 1,170–1,620 ms |
| prefix untouched | **165 ms** |

Six to eight seconds, on every single turn, before a word could appear. The
facts now go in as a system message directly ahead of the latest question, so
the instructions and the whole conversation stay cached and only that block and
the new question are read. The clock time and message count were dropped as
well: both changed every turn and neither earned its place.

The rule this leaves behind: **anything that changes between turns belongs at
the end of the request, never the beginning.**

## The prompt is latency

Prefill measured ~36 tokens/sec on this CPU, so every 100 tokens of preamble is
about three seconds the user waits before a single word appears. Capability
prompts had grown to 920 fixed tokens without anyone noticing, and "list all my
ollama models" took 33.5 s — of which 25.6 s was reading instructions.

Two fixes:

**Shorter.** The preamble is 596 tokens, down from 920, with the parts that
measurably changed behaviour kept verbatim and the restatements cut. Re-scored
afterwards on nine cases: 9/9, up from 8/8 on the previous eight, with
`list all my ollama models` now correctly proposing `ollama list` rather than
hunting the filesystem with `Get-ChildItem`.

**Primed.** Warming a tier no longer just loads the weights, it sends the exact
preamble that tier will use, so the KV cache already holds it. Measured on a
cold model:

| | first word |
| --- | --- |
| cold, unprimed | **23.5 s** |
| primed at startup | **0.7 s** |

The 22 s does not disappear, it moves to startup where nobody is waiting on it.

## Staying out of the model's way

Inference here is CPU-bound, so every core Wumpy takes is a core not producing
tokens. The app is built to be nearly free.

Measured as a share of one core, panel open and doing nothing:

| | before | after |
| --- | --- | --- |
| Quick mode | 1.4% | 2.0% |
| Developer mode | **37.1%** | **2.9%** |

Developer mode had a binary-rain backdrop built from twenty absolutely
positioned elements, each with a CSS transform and a gradient mask. A masked
layer has to be re-rasterised every frame it moves, and it cost thirteen times
the entire rest of the app — burnt in the one mode where the slowest models
live. There are no animations now.

The rest of the budget went the same way:

- **No animation loop while reading.** Each message used to keep an animation
  frame callback alive for the life of the chat, including finished ones.
- **Character-by-character reveal is opt-in** (`smoothText`, off). It looks
  better, but it re-parses markdown many times a second *during generation*,
  which is the worst possible moment to spend CPU.
- **Messages are memoised**, so an arriving token re-renders the message it
  landed in rather than every message in the conversation.
- **Wumpy drops to below-normal priority while a turn generates**, so the
  scheduler hands contested time to Ollama, and restores it afterwards.
- Status polling runs every 30s, not 10s; the elapsed counter ticks at 250ms,
  not 100ms.

## Commands

Type `/` in the composer for an autocompleting palette. Arrow keys to move, Tab
or Enter to accept.

| Command | What it does |
| --- | --- |
| `/new`, `/clear` | Start a fresh chat (`Ctrl+N`) |
| `/resume` | Pick up a previous chat (`Ctrl+R`) |
| `/chats`, `/history` | Browse saved chats |
| `/delete` | Delete this chat (`/delete pick` for the list) |
| `/rename`, `/title <text>` | Retitle this chat |
| `/tier`, `/level` | Switch thinking level, keeping context |
| `/model [name]` | Pick the model; a rough name ("nemotron super") is matched |
| `/music on\|off` | Pause music while Wumpy listens and talks |
| `/startup on\|off` | Start Wumpy in the background when you log in, so the earbuds gesture works without opening it |
| `/restart` | Restart Wumpy and come back to the same chat (also in the tray menu, as `wumpy --restart`, or say "restart yourself") |
| `/skills` | List your skills (each one is a command), `/skills new <what it should do>` to add one, `/skills folder` to open them |
| `/sync` `<pair [code]\|unpair\|on\|off\|status\|key token>` | Share your skills between your devices: over Wi-Fi once paired, or through an unlisted gist on your GitHub account; bare, syncs now |
| `/skill` `<name text>` | Run a skill by name, even one whose name another command has |
| `/update` | Update Wumpy now: on Windows restart into a downloaded release, or look for one; on Linux pull, build and install from the source folder, then restart (`/update force` rebuilds anyway; or say "update yourself") |
| `/mode [quick\|dev]` | Toggle Quick / Developer |
| `/dock` | Move the panel, from a list |
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

## A bug worth recording

Proposed commands rendered as inert code blocks with no Run button for a while,
and nothing failed loudly — the feature was simply dead. The cause was literal
backspace characters (0x08) inside the regex that detects a `wumpy-run` fence,
written there by a careless edit:

```
if (/language-wumpy-run/.test(className))   intended
if (/<BS>language-wumpy-run<BS>/.test(className)) actual
```

The parsers all had tests and all passed, because the parsers were fine. What
had no test was the wiring between them and the renderer. `npm run check:blocks`
now renders every kind of block the model can emit and asserts which component
it becomes, including a lookalike tag that must *not* be runnable. It runs as
part of `npm run typecheck`.

## Approval modes

How much runs without being asked. Click the badge in the status bar, use
`/approve manual|auto|all`, or set it from the tray.

| mode | reads | writes | destructive |
| --- | --- | --- | --- |
| **manual** (default) | asks | asks | asks |
| **auto** | **runs** | asks | asks |
| **accept all** | runs | runs | **asks** |

Destructive commands keep their dialog even in "accept all", because the model
wrote them and a wrong path does not come back. Turn that off in the tray
(`confirmRisky`) if you want it gone — but it is off by your choice, not by
default.

Automatic modes stop themselves after six commands run without you. An automatic
mode plus a model that reads its own output is a loop, and the cap breaks it:
approving one by hand, or sending a message, starts the count again.

### What decides that a command "only reads"

`isReadOnly()` in `src/main/shell.ts`, and it is an **allowlist** — a command
whose head is not on the list counts as a write. Pipelines are checked segment
by segment, and any redirection or mutating verb disqualifies the whole line.
The decision is made in the main process and sent to the renderer, so the UI
obeys it rather than computing it.

The first version of this leaked, and the leaks are worth recording because they
are the obvious ones:

| allowed by the old check | why it is not a read |
| --- | --- |
| `node -e "<anything>"` | arbitrary code |
| `npx create-react-app x` | runs whatever it downloads |
| `python3 -m http.server` | starts a server |
| `find . -delete` | deletes |
| `git config --global …` | rewrites settings |
| `npm config set …` | rewrites settings |

All six passed a test of the form "head is on the list and the subcommand is not
a known write". The fix was to invert it one level deeper: multi-purpose tools
are now listed by the reads they *are* allowed — `git status`, `npm list`,
`ollama ps` — and interpreters get nothing but `--version` and `--help`, because
every one of them runs arbitrary code when given an argument.

Four more, found while letting background agents run reads: nothing looked
inside `$(…)`, backticks or `<(…)`, so `echo $(rm -rf x)` counted as a read;
`2>/dev/null` counted as a write; `grep` was on no list; and pacman's
case-sensitive `-Ss` was lowercased onto no list either. A command inside a
command is now judged as a command, only the null device is a harmless
redirect, and loops are judged by what they run.

`npm run check:approval` asserts all of it: 53 checks covering every mode
against reads, writes and destructive commands, 20 bypass attempts that must
need a click, and 18 ordinary reads that must not.

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

### What each tier may do

| tier | commands |
| --- | --- |
| Flash | none |
| **Fast** | **read only** — versions, files, what is installed |
| Thinker, Deep Thinker | anything, with a click |

Read-only is enforced in the main process against an allowlist of reporting
commands, not requested in the prompt. A blocklist of dangerous commands is
endless and one miss is unrecoverable, so anything not on the list counts as a
write and needs a Developer tier. Pipelines are checked segment by segment, and
any redirection or mutating verb disqualifies the whole line. Covered by 24
cases.

A command the current tier may not run gets **no Run button at all** — the card
says "needs Developer mode" instead. That matters because a small model will
sometimes propose a command it should not, and an inert card is better than a
button that fails.

### No reasoning models

None of the tiers use a reasoning model, because on this hardware they are not a
smarter option, they are a broken one. Six logic questions, same prompts:

| | correct | total time | scratchpad |
| --- | --- | --- | --- |
| phi4-mini:3.8b (no reasoning) | 3/6 | **74 s** | 0 chars |
| qwen3:4b (reasoning) | **2/6** | **774 s** | 12,907 chars |

Four of qwen3's six answers came back **empty**: it spent two to three minutes
on scratchpad per question and never reached a conclusion. Depth now comes from
a bigger non-reasoning model instead — `qwen2.5:7b` answers the bat-and-ball
question correctly in 12 s with no scratchpad at all, where qwen3:4b took 92 s.

### "Is X installed" is two different questions

`Get-Command firefox` reports nothing, because `Get-Command` searches PATH and
Firefox is not on it — but Firefox is installed. The model had copied the
`Get-Command ollama` example from its own instructions and applied it to an
application, and confidently answered "Firefox is not installed."

The prompt now distinguishes the two: `Get-Command` for command-line tools, and
the uninstall registry for applications. It also says not to trust
`Get-Command`'s Version column, which is file metadata and reads `0.0.0.0` for
most tools — asked for a version the model now proposes the tool's own
`--version`, which reports `ollama version is 0.40.0` where `Get-Command` said
`0.0.0.0`. Verified on this machine, the registry
query returns `Mozilla Firefox (x64 en-US) 155.0.1`, and it is read-only so Fast
can run it. Asked about Firefox and Chrome the model now reaches for the
registry, and still uses `Get-Command` for Ollama, which is the right call for a
CLI tool.

### Teaching a small model when *not* to act

Getting phi4-mini to propose a command only when it should took measuring, not
rewriting. Eight cases, half of which must produce no command at all:

| prompt shape | score |
| --- | --- |
| "propose a command whenever the answer depends on this machine" | 5/8 |
| the same, restated as a decision to make first | 6/8 |
| decision, plus the examples described in prose | 7/8 |
| **decision, plus the examples as real conversation turns** | **8/8** |

The last one is the whole trick: a 3.8B model imitates far better than it
follows instructions. Three worked turns — a general-knowledge question answered
plainly, a request it must refuse, and a real command proposal — do what four
paragraphs of rules could not. They sit at the front of every request where they
stay in the KV cache, so they cost one prefill rather than one per message.

The prompt itself is now a question rather than a rule: *does this depend on
what is on THIS computer? No → answer in words, most questions are this.*
Naming the common answer mattered.

### Web search

Developer tiers and Fast can search, behind the same click as a command — the
query leaves the machine, and a model can put anything in one.

```wumpy-search
# Find the current default for Ollama keep_alive
ollama keep_alive default
```

Results come back into the card and are handed to the model to answer from.

**Scraping was tried first and abandoned.** DuckDuckGo's HTML pages parse
cleanly for a handful of requests and then return HTTP 202 with an anti-bot
challenge on every call. A feature that breaks the moment it is used is worse
than one with stated limits, so search now uses documented endpoints only:

| | covers | needs |
| --- | --- | --- |
| DuckDuckGo Instant Answer | definitions, people, places, concepts | nothing |
| Wikipedia search | the same, with broader recall | nothing |
| Brave Search | general web — docs, forums, versions | a free API key |

Measured keyless: "what is speculative fiction", "mutex", "WH_KEYBOARD_LL" and
"ryzen 7735u" all return useful results. "ollama keep_alive setting" returns
none, and says so — that is the honest shape of a keyless search. Put a Brave
key in `searchApiKey` for general web results; it is the only thing in Wumpy
that needs an account.

### Asking instead of guessing

A model can put a question back rather than guess, and the answer is one click:

```wumpy-ask
Which folder did you mean?
- Downloads
- Documents
```

A wrong guess costs a whole slow turn to discover and another to correct, which
on this hardware is a minute of your life.

### Quotation marks are a question, not a guess

`rename this chat to "very funny"` has no safe default. The quotes might be
punctuation, or they might be the joke. Nothing in the text distinguishes
`"mathematics"` (probably punctuation) from `"very funny"` or `happy "fantasy"`
(probably the name). So Wumpy does not guess: it offers both readings and one
click settles it, instantly and with no model involved.

This replaced the worst behaviour in the app. Asked to rename a chat to
`'mathematics'`, the reasoning tier spent close to two minutes deliberating over
whether the quotes belonged in the name, and produced nothing.

### Things Wumpy does itself

"rename this chat to X", "start a new chat", "switch to deep" and similar never
reach a model at all. The answer is always the same slash command, and asking is
pure cost: measured, "rename this chat to Speculative Fiction" took 6.4s on
phi4-mini to be told the command, and on qwen3:4b took **129 seconds, produced
3,620 characters of scratchpad, and then no answer at all**. Matching is
deliberately narrow — a question, a long sentence, or anything without a
concrete title falls through to the model. Covered by 21 cases, 10 of which must
*not* match.

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
| `hotkeys` | `[]` | Extra accelerators; `Win+Z` comes from the hook |
| `keepAlive` | `30m` | How long Ollama holds a model resident |
| `warmOnStart` | `true` | Preload tier models at startup |
| `smoothText` | `false` | Reveal character by character (costs CPU while generating) |
| `maxTurnMs` | `180000` | Hard ceiling on one turn |
| `shellEnabled` | `true` | Let Dev tiers propose commands |
| `shellCwd` | `""` | Working directory; empty means home |
| `approvalMode` | `manual` | `manual`, `auto` or `all` |
| `confirmRisky` | `true` | Keep the dialog for destructive commands |
| `searchEnabled` | `true` | Let tiers propose web searches |
| `searchApiKey` | `""` | Brave Search key; without it, encyclopedic only |
| `tierModels` | `{}` | Per-tier model overrides |
| `launchAtLogin` | `false` | Start with Windows (packaged builds only) |

## Keys

| Key | Action |
| --- | --- |
| `Win+Z` / `Super+Z` | Toggle the panel (also: click the tray icon) |
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
│  ├─ lowlevelhook.ts drives the Win+Z helper process
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
