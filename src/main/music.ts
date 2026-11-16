/**
 * Music off while Wumpy listens and talks, and back on afterwards.
 *
 * Asked for in these words: "when I'm using Wumpy, turn off the background
 * music too." A song under a spoken question is noise the recogniser has to
 * hear through, and an answer read over the top of one is hard to follow in
 * an earbud. So whatever is PLAYING is paused when a voice turn or a
 * dictation starts, and exactly those players are resumed when it ends -
 * never something that was already paused, which would be starting music
 * nobody asked for.
 *
 * Calls are left alone ("I don't know about calls, but just leave that"):
 * only media players are touched, through the same controls the keyboard's
 * play/pause key uses, and a call is not one.
 *
 *   Linux    MPRIS over the session bus, with busctl (systemd, always there).
 *            Every player that implements it - Spotify, mpv, browsers - is a
 *            name under org.mpris.MediaPlayer2.
 *   Windows  The system media session manager (the one behind the volume
 *            flyout), from Windows PowerShell - the WinRT projection it
 *            needs is not in PowerShell 7.
 *
 * Holds nest: a dictation inside a voice turn does not resume the music
 * halfway through. Every step runs in order on one chain, so a release that
 * arrives while the pause is still being sent waits for it.
 */
import { execFile } from 'node:child_process'
import { backToMusicMode } from './btmic'

let holds = 0
/** The players this paused, to resume and nothing else. */
let paused: string[] = []
let chain: Promise<void> = Promise.resolve()

function run(file: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    )
  })
}

/* ------------------------------------------------------------------ Linux */

const MPRIS = 'org.mpris.MediaPlayer2.'

async function linuxPlayers(): Promise<string[]> {
  const out = await run('busctl', [
    '--user',
    '--json=short',
    'call',
    'org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus',
    'ListNames'
  ])
  try {
    const names: string[] = JSON.parse(out).data[0]
    /* playerctld is a proxy for the others: pausing through it as well
       would pause the same player twice and resume it once. */
    return names.filter((n) => n.startsWith(MPRIS) && !n.includes('playerctld'))
  } catch {
    return []
  }
}

async function linuxStatus(name: string): Promise<string> {
  const out = await run('busctl', [
    '--user',
    'get-property',
    name,
    '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Player',
    'PlaybackStatus'
  ])
  return /"(\w+)"/.exec(out)?.[1] ?? ''
}

function linuxSend(name: string, method: 'Pause' | 'Play'): Promise<string> {
  return run('busctl', ['--user', 'call', name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', method])
}

async function linuxPause(): Promise<string[]> {
  const players = await linuxPlayers()
  const playing: string[] = []
  await Promise.all(
    players.map(async (name) => {
      if ((await linuxStatus(name)) !== 'Playing') return
      await linuxSend(name, 'Pause')
      playing.push(name)
    })
  )
  return playing
}

async function linuxResume(names: string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      /* Still paused: nobody stopped it, skipped it or started it by hand
         in the meantime. Anything else is theirs now. */
      if ((await linuxStatus(name)) === 'Paused') await linuxSend(name, 'Play')
    })
  )
}

/* ---------------------------------------------------------------- Windows */

const WINRT_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
  'function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(3000); $t.Result }',
  '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  '$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])'
].join('\n')

function powershell(script: string): Promise<string> {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    8000
  )
}

async function windowsPause(): Promise<string[]> {
  const out = await powershell(
    [
      WINRT_PRELUDE,
      'foreach ($s in $manager.GetSessions()) {',
      "  if ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') {",
      '    if (Await ($s.TryPauseAsync()) ([bool])) { $s.SourceAppUserModelId }',
      '  }',
      '}'
    ].join('\n')
  )
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

async function windowsResume(ids: string[]): Promise<void> {
  /* App ids are paths and package names; quoted for PowerShell, with its
     own quote doubled, so none of them can end the string early. */
  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')
  await powershell(
    [
      WINRT_PRELUDE,
      `$ids = @(${list})`,
      'foreach ($s in $manager.GetSessions()) {',
      "  if ($ids -contains $s.SourceAppUserModelId -and $s.GetPlaybackInfo().PlaybackStatus -eq 'Paused') {",
      '    $null = Await ($s.TryPlayAsync()) ([bool])',
      '  }',
      '}'
    ].join('\n')
  )
}

/* ---------------------------------------------------------------- the API */

const pauseAll = (): Promise<string[]> =>
  process.platform === 'win32' ? windowsPause() : process.platform === 'linux' ? linuxPause() : Promise.resolve([])

const resumeAll = (ids: string[]): Promise<void> =>
  !ids.length
    ? Promise.resolve()
    : process.platform === 'win32'
      ? windowsResume(ids)
      : process.platform === 'linux'
        ? linuxResume(ids)
        : Promise.resolve()

function queue(step: () => Promise<void>): Promise<void> {
  chain = chain.then(step).catch((err) => console.warn('[wumpy] music:', err))
  return chain
}

/** Pause what is playing, unless an earlier hold already did. */
export function holdMusic(): Promise<void> {
  holds++
  if (holds > 1) return chain
  return queue(async () => {
    /* Added to, not replaced: players a release left paused (see below)
       are still this hold's to resume. */
    const now = await pauseAll()
    paused = [...new Set([...paused, ...now])]
  })
}

/**
 * Resume what the first hold paused, once the last hold lets go - after
 * the earbuds are back in their music mode (see backToMusicMode): "when I
 * stopped, suddenly the music sounded blurry, no spatial sound, and a
 * little bit of audio leaked from the MacBook before it recovered." If
 * something holds the music again meanwhile, it stays paused, for that
 * hold to resume.
 */
export function releaseMusic(waitForEarbuds = true): Promise<void> {
  if (holds === 0) return chain
  holds--
  if (holds > 0) return chain
  return queue(async () => {
    if (!paused.length) return
    if (waitForEarbuds) console.log(`[wumpy] music: ${await backToMusicMode()}, then resumed`)
    if (holds > 0) return
    const ids = paused
    paused = []
    await resumeAll(ids)
  })
}

/** On the way out: nothing stays paused because Wumpy quit mid-sentence. */
export function releaseAllMusic(): Promise<void> {
  if (holds === 0) return chain
  holds = 1
  return releaseMusic(false)
}
