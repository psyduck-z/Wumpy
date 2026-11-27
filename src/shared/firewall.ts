/**
 * Whether the firewall lets their other devices reach Wumpy, for Wi-Fi sync
 * (main/lansync.ts): "add a verification to make sure that you allow Wumpy
 * through Windows firewall to access local network".
 *
 * WINDOWS. The first time Wumpy listens, Windows asks whether to allow it,
 * and the answer is kept as rules for that one Wumpy.exe - Allow, or Block
 * when the box was closed. Every update installs to a new app-x.y.z folder,
 * so those rules are for a program that is no longer there. Wumpy's own
 * rule is for its port instead, from the local network only, which outlives
 * updates; and a Block rule for any Wumpy.exe beats any Allow, so allowing
 * also removes those. Allowing needs an administrator: the Windows pop-up.
 *
 * LINUX. ufw, which Omarchy turns on with every port closed: a rule for the
 * port, added with a password pop-up (pkexec).
 *
 * Pure, for scripts/check-firewall.mjs; the Windows half also runs for real
 * on the Windows build machine (scripts/check-firewall-live.mjs).
 */

export const SYNC_PORT = 47820
export const RULE_NAME = 'Wumpy skills sync'

export type FirewallState =
  /** Other devices can reach it. */
  | 'open'
  /** There is no firewall in the way on this network. */
  | 'off'
  /** Nothing lets them in. */
  | 'closed'
  /** A rule shuts Wumpy out: the box Windows showed was closed. */
  | 'blocked'
  /** Could not tell. */
  | 'unknown'

export interface FirewallVerdict {
  state: FirewallState
  /** One line, for Settings. */
  why: string
  /** Public, Private or Domain: the network it was judged for (Windows). */
  network?: string
}

/** What the PowerShell check reports. */
export interface WindowsFacts {
  /** The connected network's category: Public, Private or DomainAuthenticated. */
  category: string
  profiles: Array<{ name: string; on: boolean }>
  /** Enabled inbound rules for any Wumpy.exe; `self` when it is this one. */
  app: Array<{ program: string; self: boolean; action: string; profile: string }>
  /** Enabled rules named RULE_NAME. */
  port: Array<{ action: string; profile: string; protocol: string }>
}

/** "Domain, Private" or "Any": whether a rule's profiles include `network`. */
function covers(profile: string, network: string): boolean {
  const p = String(profile ?? '').toLowerCase()
  return p === 'any' || p.split(/\s*,\s*/).includes(network.toLowerCase())
}

export function windowsVerdict(f: WindowsFacts | null): FirewallVerdict {
  if (!f) return { state: 'unknown', why: 'Could not read the Windows Firewall settings.' }
  const network = f.category === 'DomainAuthenticated' ? 'Domain' : f.category
  if (!network) return { state: 'unknown', why: 'Not connected to a network.' }
  const where = `this ${network.toLowerCase()} network`
  const profile = f.profiles.find((p) => p.name.toLowerCase() === network.toLowerCase())
  if (profile && !profile.on) return { state: 'off', why: `Windows Firewall is off on ${where}.`, network }
  const here = (r: { profile: string }): boolean => covers(r.profile, network)
  /* Block wins over Allow in Windows Firewall, so this comes first. */
  if (f.app.some((r) => r.self && /block/i.test(r.action) && here(r))) {
    return { state: 'blocked', why: `Windows Firewall is blocking Wumpy on ${where}.`, network }
  }
  const byPort = (proto: string): boolean => f.port.some((r) => /allow/i.test(r.action) && here(r) && r.protocol.toUpperCase() === proto)
  const bySelf = f.app.some((r) => r.self && /allow/i.test(r.action) && here(r))
  if ((byPort('TCP') && byPort('UDP')) || bySelf) return { state: 'open', why: `Allowed through Windows Firewall on ${where}.`, network }
  return { state: 'closed', why: `Windows Firewall has not been told to let your devices reach Wumpy on ${where}.`, network }
}

const ps = (s: string): string => s.replace(/'/g, "''")

/** Reads the facts; prints them as one line of JSON. Needs no administrator. */
export function windowsCheckScript(exe: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = '${ps(exe)}'`,
    "$net = Get-NetConnectionProfile | Where-Object { [string]$_.IPv4Connectivity -ne 'Disconnected' } | Select-Object -First 1",
    "$cat = if ($net) { [string]$net.NetworkCategory } else { '' }",
    "$profiles = @(Get-NetFirewallProfile | ForEach-Object { @{ name = [string]$_.Name; on = ([string]$_.Enabled -eq 'True') } })",
    '$app = @()',
    "foreach ($f in @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\\wumpy.exe' })) {",
    '  $p = [Environment]::ExpandEnvironmentVariables($f.Program)',
    '  foreach ($r in @($f | Get-NetFirewallRule)) {',
    "    if ([string]$r.Enabled -eq 'True' -and [string]$r.Direction -eq 'Inbound') {",
    '      $app += @{ program = $p; self = ($p -eq $exe); action = [string]$r.Action; profile = [string]$r.Profile }',
    '    }',
    '  }',
    '}',
    '$port = @()',
    `foreach ($r in @(Get-NetFirewallRule -DisplayName '${RULE_NAME}')) {`,
    "  if ([string]$r.Enabled -eq 'True') {",
    '    $proto = [string](($r | Get-NetFirewallPortFilter).Protocol)',
    '    $port += @{ action = [string]$r.Action; profile = [string]$r.Profile; protocol = $proto }',
    '  }',
    '}',
    '@{ category = $cat; profiles = $profiles; app = $app; port = $port } | ConvertTo-Json -Depth 4 -Compress'
  ].join('\n')
}

/**
 * Lets their devices in: drops the Block rules Windows made for any Wumpy.exe
 * and allows the sync port, TCP and UDP, from the local network only, on any
 * kind of network - a home Wi-Fi Windows calls "public" included. Run as
 * administrator.
 */
export function windowsAllowScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\\wumpy.exe' } | Get-NetFirewallRule |",
    "  Where-Object { [string]$_.Action -eq 'Block' -and [string]$_.Direction -eq 'Inbound' } | Remove-NetFirewallRule",
    `Get-NetFirewallRule -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    ...['TCP', 'UDP'].map(
      (p) =>
        `New-NetFirewallRule -DisplayName '${RULE_NAME}' -Description 'Lets your other devices sync skills with Wumpy over Wi-Fi.' ` +
        `-Direction Inbound -Action Allow -Protocol ${p} -LocalPort ${SYNC_PORT} -RemoteAddress LocalSubnet -Profile Any | Out-Null`
    ),
    /* Got here, so it worked: a "nothing to remove" above still leaves PowerShell
       exiting 1, which would read as the prompt declined. (Found on the build machine.) */
    'exit 0'
  ].join('\n')
}

/** PowerShell's -EncodedCommand: UTF-16LE, base64. No quoting to get wrong. */
export function encoded(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes.push(c & 255, c >> 8)
  }
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')
}

/**
 * The elevated run: a plain PowerShell asks Windows to start another as
 * administrator (the pop-up) and waits for it. Declined, Start-Process
 * throws and this exits non-zero.
 */
export function windowsElevateScript(inner: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded(inner)}')`,
    'exit $p.ExitCode'
  ].join('\n')
}

/** ufw's files, read without root: on, and whether the port is open. */
export function ufwVerdict(conf: string | null, rules: string | null, port = SYNC_PORT): FirewallVerdict {
  if (conf === null) return { state: 'off', why: 'No firewall (ufw) on this computer.' }
  if (!/^ENABLED=yes/m.test(conf)) return { state: 'off', why: 'The firewall (ufw) is off.' }
  if (rules === null) return { state: 'unknown', why: 'Could not read the firewall (ufw) rules.' }
  const open = (proto: string): boolean => new RegExp(`-p ${proto} --dport ${port}\\b[^\\n]*-j ACCEPT`).test(rules)
  return open('tcp') && open('udp')
    ? { state: 'open', why: `The firewall (ufw) lets your devices in on port ${port}.` }
    : { state: 'closed', why: `The firewall (ufw) keeps port ${port} closed.` }
}

/** Fine as it is: other devices can reach this one. */
export const reachable = (v: FirewallVerdict): boolean => v.state === 'open' || v.state === 'off'
