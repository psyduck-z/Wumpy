/**
 * Skills between their devices over Wi-Fi, with no account at all: "is there
 * a way to sync without having to sign into github" - "over wifi, auto sync".
 * GitHub (main/skillsync.ts) still works beside it, for devices that are
 * never on the same network.
 *
 * PAIRING, ONCE. `/sync pair` on one device shows a six-digit code; typed on
 * the other (`/sync pair 482913`), the two agree a secret only they know. The
 * code is never sent: it goes through SPAKE2, a password-authenticated key
 * exchange, so somebody on the same Wi-Fi who watches the whole exchange
 * learns nothing they could test guesses against offline, and somebody who
 * pretends to be one of the devices gets one guess in a million per try - and
 * three wrong tries end the code. That matters more here than for most sync:
 * a skill is instructions Wumpy follows, and Wumpy can run commands.
 *
 * THEN BY ITSELF. Each paired device says it is there on the local network
 * (a UDP broadcast) once a minute and the moment a skill changes, with a
 * fingerprint of its skills. A paired device that hears one whose skills
 * have changed since they last agreed connects (TCP), proves it holds the
 * secret, and the two merge exactly as GitHub sync does - @shared/skillsync's
 * plan(), against what these two last agreed - over an encrypted connection.
 *
 * FIREWALLS. Either side may block connections coming in (Omarchy's ufw does,
 * Windows does on a "public" network). A device that hears a broadcast
 * answers it directly, which a firewall lets back in as a reply; so as long
 * as one of the two accepts connections, both learn where the other is and
 * the one that can reach the other connects. On Linux, pairing opens the port
 * in ufw once, with a password pop-up (pkexec) - never a stored password.
 *
 * Nothing here starts until they pair: no broadcasts, no port, no firewall
 * prompt for anyone who never uses it.
 *
 * No Electron here, so scripts/check-lansync.mjs runs two of these against
 * each other for real.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, getDiffieHellman, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createSocket, type RemoteInfo, type Socket as Udp } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { parseSkill } from '@shared/skills'
import { plan, summary } from '@shared/skillsync'

/** TCP and UDP both. Opened in ufw by pairing, so it has to stay the same. */
export const LAN_PORT = 47820
const HELLO = 'wumpy-lan/1'
/** How long a code shown by `/sync pair` lasts. */
const CODE_MS = 5 * 60_000
/** How long `/sync pair <code>` looks for the device showing it. */
const LOOK_MS = 25_000
/** Wrong codes a shown code survives. */
const MAX_FAILS = 3
const MAX_LINE = 512 * 1024

/* ================================================================ SPAKE2
 * In the 2048-bit MODP group of RFC 3526 (whose prime Node has built in): p
 * a safe prime, so its squares form a group of prime order q, which g = 2 -
 * a square, as p = 7 mod 8 - generates. M and N are hashes squared into it,
 * so nobody knows their logarithms, which is what the exchange rests on.
 */
const P = BigInt(`0x${getDiffieHellman('modp14').getPrime('hex')}`)
const Q = (P - 1n) / 2n
const G = 2n

function modpow(base: bigint, exp: bigint): bigint {
  let r = 1n
  let b = base % P
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P
    b = (b * b) % P
    e >>= 1n
  }
  return r
}

function inverse(a: bigint): bigint {
  let [r0, r1, s0, s1] = [a % P, P, 1n, 0n]
  while (r1) {
    const k = r0 / r1
    ;[r0, r1] = [r1, r0 - k * r1]
    ;[s0, s1] = [s1, s0 - k * s1]
  }
  return ((s0 % P) + P) % P
}

const big = (b: Buffer): bigint => BigInt(`0x${b.toString('hex') || '0'}`)
const hex = (n: bigint): string => n.toString(16).padStart(512, '0')

function element(label: string): bigint {
  let h = Buffer.alloc(0)
  for (let i = 0; h.length < 288; i++) h = Buffer.concat([h, createHash('sha256').update(`${label}:${i}`).digest()])
  return modpow(big(h) % P, 2n)
}
const M = element('wumpy spake2 M')
const N = element('wumpy spake2 N')

const inGroup = (v: bigint): boolean => v > 1n && v < P - 1n && modpow(v, Q) === 1n

export interface SpakeHalf {
  shows: boolean
  w: bigint
  x: bigint
  /** What is sent. */
  msg: bigint
}

/** One side's half: the device showing the code masks with M, the one typing it with N. */
export function spakeStart(code: string, shows: boolean): SpakeHalf {
  const w = big(createHash('sha256').update(`wumpy pair code ${code}`).digest())
  const x = big(randomBytes(32)) + 2n
  return { shows, w, x, msg: (modpow(G, x) * modpow(shows ? M : N, w)) % P }
}

/** The shared key, from the other side's half; null for one not in the group. */
export function spakeFinish(mine: SpakeHalf, theirs: bigint, ids: { shows: string; types: string }): Buffer | null {
  if (!inGroup(theirs)) return null
  const unmasked = (theirs * inverse(modpow(mine.shows ? N : M, mine.w))) % P
  const z = modpow(unmasked, mine.x)
  const [x, y] = mine.shows ? [mine.msg, theirs] : [theirs, mine.msg]
  return createHash('sha256')
    .update(['wumpy-spake2', ids.shows, ids.types, hex(x), hex(y), hex(z), mine.w.toString(16)].join('|'))
    .digest()
}

const mac = (key: Buffer | string, ...parts: string[]): string =>
  createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'base64') : key)
    .update(parts.join('|'))
    .digest('base64')

function same(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** "482 913", "482-913" or "482913": the six digits, or null. */
export function pairCode(raw: string): string | null {
  const d = String(raw ?? '').replace(/[\s-]/g, '')
  return /^\d{6}$/.test(d) ? d : null
}

/* ================================================================ the wire
 * One JSON message a line; once both sides have proved the secret, each
 * line is AES-256-GCM sealed, with a key per direction and the line number
 * as the nonce - so nothing can be read, changed, replayed or reordered.
 */
type Msg = Record<string, unknown> & { t?: string }

class Wire {
  private buf = ''
  private queue: unknown[] = []
  private waiting: Array<(m: Msg | null) => void> = []
  private closed = false
  private keys: { send: Buffer; recv: Buffer; sent: bigint; got: bigint } | null = null

  constructor(readonly sock: Socket) {
    sock.setEncoding('utf8')
    sock.setTimeout(20_000, () => sock.destroy())
    sock.on('data', (d: string) => {
      this.buf += d
      if (this.buf.length > MAX_LINE) return void sock.destroy()
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        try {
          this.push(JSON.parse(line))
        } catch {
          sock.destroy()
        }
      }
    })
    sock.on('close', () => {
      this.closed = true
      for (const w of this.waiting.splice(0)) w(null)
    })
    sock.on('error', () => undefined)
  }

  private push(raw: unknown): void {
    const w = this.waiting.shift()
    if (w) w(this.read(raw))
    else this.queue.push(raw)
  }

  /* Opened when taken, not when it arrives: the first sealed line can come in
     the same packet as the last plain one, before the keys are set. */
  private read(raw: unknown): Msg | null {
    if (!this.keys) return raw && typeof raw === 'object' ? (raw as Msg) : null
    try {
      const all = Buffer.from(String((raw as Msg).e ?? ''), 'base64')
      const d = createDecipheriv('aes-256-gcm', this.keys.recv, nonce(this.keys.got++))
      d.setAuthTag(all.subarray(all.length - 16))
      const plain = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()])
      return JSON.parse(plain.toString('utf8')) as Msg
    } catch {
      this.sock.destroy()
      return null
    }
  }

  next(): Promise<Msg | null> {
    if (this.queue.length) return Promise.resolve(this.read(this.queue.shift()))
    if (this.closed) return Promise.resolve(null)
    return new Promise((r) => this.waiting.push(r))
  }

  send(m: Msg): void {
    if (this.closed) return
    let out: unknown = m
    if (this.keys) {
      const c = createCipheriv('aes-256-gcm', this.keys.send, nonce(this.keys.sent++))
      const body = Buffer.concat([c.update(JSON.stringify(m), 'utf8'), c.final(), c.getAuthTag()])
      out = { e: body.toString('base64') }
    }
    this.sock.write(`${JSON.stringify(out)}\n`)
  }

  /** Asks, and waits for the answer. */
  async ask(m: Msg): Promise<Msg | null> {
    this.send(m)
    return this.next()
  }

  seal(send: Buffer, recv: Buffer): void {
    this.keys = { send, recv, sent: 0n, got: 0n }
  }

  close(): void {
    this.sock.end()
  }
}

/** A device's address from the connection it came in on, and the port it said it listens on. */
function where(wire: Wire, port: unknown, heard?: { address: string; port: number }): { addr?: string; port?: number } {
  const addr = (wire.sock.remoteAddress ?? heard?.address ?? '').replace(/^::ffff:/, '')
  const p = Number(port) || heard?.port || 0
  return addr && p ? { addr, port: p } : {}
}

function nonce(n: bigint): Buffer {
  const b = Buffer.alloc(12)
  b.writeBigUInt64BE(n, 4)
  return b
}

function dial(address: string, port: number, ms = 4000): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect({ host: address, port })
    const fail = (): void => {
      s.destroy()
      resolve(null)
    }
    const timer = setTimeout(fail, ms)
    s.once('connect', () => {
      clearTimeout(timer)
      resolve(s)
    })
    s.once('error', () => {
      clearTimeout(timer)
      fail()
    })
  })
}

/* ================================================================ the store */

export interface LanStore {
  syncView(also?: ReadonlySet<string>): Record<string, { text: string; hash: string; at: number }>
  put(name: string, text: string): boolean
  drop(name: string): boolean
}

interface Peer {
  id: string
  name: string
  /** The pair secret, sealed by the system keychain where there is one. */
  secret: string
  /** Each skill's hash when these two last agreed; null, agreed deleted. */
  base: Record<string, string | null>
  /** Each side's fingerprint then: a change on either means a sync is due. */
  agreed?: { mine: string; theirs: string }
  addr?: string
  port?: number
  /** ms: the last sync that went through. */
  synced?: number
}

interface State {
  id: string
  peers: Peer[]
}

export interface LanOptions {
  /** Where lan-sync.json is kept. */
  dir: string
  store: LanStore
  /** What the other device calls this one: its host name. */
  name: string
  log: (line: string) => void
  /** Skills here changed because of another device. */
  changed: () => void
  /** Something worth showing them that they did not just ask for: "Paired with X." */
  note?: (text: string) => void
  /** The pair secret, for the disk; null when it cannot be protected. */
  seal?: (secret: string) => string | null
  open?: (sealed: string) => string | null
  port?: number
  udpPort?: number
  /** Where announcements go; the local broadcast addresses by default. */
  targets?: () => Array<{ address: string; port: number }>
  /** Shorter waits, for the check. */
  quick?: boolean
}

export interface LanResult {
  ok: boolean
  message: string
  changed: boolean
  /** Which device, for a sync. */
  peer?: string
}

interface Heard {
  id: string
  name: string
  address: string
  port: number
  rev: string
  pairing: boolean
  looking: boolean
  at: number
}

export class LanSync {
  private st: State
  private tcp: Server | null = null
  private udp: Udp | null = null
  private tcpPort = 0
  private beat: ReturnType<typeof setInterval> | null = null
  private fast: ReturnType<typeof setInterval> | null = null
  private busy = false
  private pairing = false
  private showing: { code: string; until: number; fails: number } | null = null
  private looking: { code: string; until: number; done: (r: LanResult) => void } | null = null
  private heard = new Map<string, Heard>()
  private replied = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private tried = new Map<string, number>()
  private revCache: { at: number; rev: string } | null = null

  constructor(private readonly o: LanOptions) {
    this.st = this.load()
  }

  private get file(): string {
    return join(this.o.dir, 'lan-sync.json')
  }

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>
      if (typeof s.id === 'string' && /^[0-9a-f]{32}$/.test(s.id)) return { id: s.id, peers: Array.isArray(s.peers) ? s.peers : [] }
    } catch {
      /* None yet. */
    }
    return { id: randomBytes(16).toString('hex'), peers: [] }
  }

  private save(): void {
    try {
      writeAtomic(this.file, JSON.stringify(this.st, null, 2))
    } catch (err) {
      this.o.log(`[skills] wifi: could not save the paired devices: ${(err as Error)?.message}`)
    }
  }

  private secretOf(p: Peer): string | null {
    return this.o.open ? this.o.open(p.secret) : p.secret
  }

  get id(): string {
    return this.st.id
  }

  peers(): Array<{ id: string; name: string; synced?: number; here: boolean }> {
    return this.st.peers.map((p) => ({ id: p.id, name: p.name, synced: p.synced, here: this.heardRecently(p.id) }))
  }

  private heardRecently(id: string): boolean {
    const h = this.heard.get(id)
    return Boolean(h && Date.now() - h.at < 3 * 60_000)
  }

  /** Forgets one paired device by name, or all of them; how many went. */
  unpair(name?: string): number {
    const before = this.st.peers.length
    const n = (name ?? '').trim().toLowerCase()
    this.st.peers = n ? this.st.peers.filter((p) => p.name.toLowerCase() !== n) : []
    this.save()
    if (!this.st.peers.length) this.stop()
    return before - this.st.peers.length
  }

  /* ------------------------------------------------------------ the network */

  get running(): boolean {
    return Boolean(this.udp)
  }

  async start(): Promise<void> {
    if (this.udp) return
    this.tcp = createServer((s) => void this.serve(new Wire(s)))
    this.tcpPort = await new Promise<number>((resolve) => {
      const server = this.tcp as Server
      const at = (port: number): void => {
        server.once('error', () => (port ? at(0) : resolve(0)))
        server.listen(port, () => {
          const a = server.address()
          resolve(typeof a === 'object' && a ? a.port : 0)
        })
      }
      at(this.o.port ?? LAN_PORT)
    })
    const udp = createSocket({ type: 'udp4', reuseAddr: true })
    udp.on('message', (buf, rinfo) => this.onAnnounce(buf, rinfo))
    udp.on('error', (err) => this.o.log(`[skills] wifi: ${err.message}`))
    await new Promise<void>((resolve) => {
      udp.once('error', () => resolve())
      udp.bind(this.o.udpPort ?? LAN_PORT, () => {
        try {
          udp.setBroadcast(true)
        } catch {
          /* Unicast still works. */
        }
        resolve()
      })
    })
    this.udp = udp
    this.beat = setInterval(() => this.announce(), this.o.quick ? 1000 : 60_000)
    this.beat.unref?.()
    this.announce()
    this.o.log(`[skills] wifi: listening on ${this.tcpPort}`)
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat)
    if (this.fast) clearInterval(this.fast)
    this.beat = this.fast = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.tcp?.close()
    this.tcp = null
    try {
      this.udp?.close()
    } catch {
      /* Already closed. */
    }
    this.udp = null
  }

  /** The broadcast address of every network this device is on. */
  private targets(): Array<{ address: string; port: number }> {
    if (this.o.targets) return this.o.targets()
    const port = this.o.udpPort ?? LAN_PORT
    const out = new Set<string>(['255.255.255.255'])
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue
        const ip = a.address.split('.').map(Number)
        const mask = a.netmask.split('.').map(Number)
        out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'))
      }
    }
    return [...out].map((address) => ({ address, port }))
  }

  /** A fingerprint of every skill here: it changes when any of them does. */
  rev(): string {
    const now = Date.now()
    if (this.revCache && now - this.revCache.at < 1500) return this.revCache.rev
    const view = this.o.store.syncView()
    const line = Object.keys(view)
      .sort()
      .map((n) => `${n}:${view[n].hash}`)
      .join(',')
    const rev = createHash('sha256').update(line).digest('hex').slice(0, 16)
    this.revCache = { at: now, rev }
    return rev
  }

  private hello(extra: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        w: HELLO,
        id: this.st.id,
        name: this.o.name.slice(0, 60),
        port: this.tcpPort,
        rev: this.rev(),
        ...(this.showing && Date.now() < this.showing.until ? { pairing: true } : {}),
        ...(this.looking ? { looking: true } : {}),
        ...extra
      })
    )
  }

  /** Says it is here: to every network, and straight to each paired device's last address. */
  announce(): void {
    if (!this.udp) return
    const msg = this.hello()
    const to = this.targets()
    for (const p of this.st.peers) if (p.addr) to.push({ address: p.addr, port: this.o.udpPort ?? LAN_PORT })
    for (const t of to) this.udp.send(msg, t.port, t.address, () => undefined)
  }

  private onAnnounce(buf: Buffer, rinfo: RemoteInfo): void {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }
    if (m.w !== HELLO || typeof m.id !== 'string' || m.id === this.st.id || !/^[0-9a-f]{32}$/.test(m.id)) return
    const h: Heard = {
      id: m.id,
      name: String(m.name ?? 'another device').slice(0, 60),
      address: rinfo.address,
      port: Number(m.port) || 0,
      rev: String(m.rev ?? ''),
      pairing: m.pairing === true,
      looking: m.looking === true,
      at: Date.now()
    }
    this.heard.set(h.id, h)
    /* Answered straight back, which a firewall lets in as a reply: so a device
       that blocks broadcasts still learns this one is here. */
    if (m.reply !== true && this.udp) {
      const last = this.replied.get(rinfo.address) ?? 0
      if (Date.now() - last > 1500) {
        this.replied.set(rinfo.address, Date.now())
        this.udp.send(this.hello({ reply: true }), rinfo.port, rinfo.address, () => undefined)
      }
    }
    const peer = this.st.peers.find((p) => p.id === h.id)
    if (peer) {
      if (peer.addr !== h.address || peer.port !== h.port) {
        peer.addr = h.address
        peer.port = h.port
        this.save()
      }
      if (h.port && (h.rev !== peer.agreed?.theirs || this.rev() !== peer.agreed?.mine)) this.soon(peer)
    }
    if (this.looking && h.pairing && h.port) void this.tryPair(h)
    /* The other way round, for when the one typing cannot be reached: the one
       showing the code calls it - but only after giving it time to call first. */
    if (this.showing && h.looking && h.port) {
      const first = this.tried.get(`seen:${h.id}`) ?? Date.now()
      this.tried.set(`seen:${h.id}`, first)
      if (Date.now() - first > (this.o.quick ? 300 : 4000)) void this.tryPair(h)
    }
  }

  /* -------------------------------------------------------------- pairing */

  /** Shows a code for the other device to type. */
  show(): { code: string; until: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.showing = { code, until: Date.now() + CODE_MS, fails: 0 }
    this.quicken()
    return { code, until: this.showing.until }
  }

  /** Announces every two seconds while pairing, so the other device finds this one at once. */
  private quicken(): void {
    if (this.fast) clearInterval(this.fast)
    this.announce()
    this.fast = setInterval(
      () => {
        const live = (this.showing && Date.now() < this.showing.until) || this.looking
        if (!live) {
          if (this.fast) clearInterval(this.fast)
          this.fast = null
          this.showing = null
          return
        }
        this.announce()
      },
      this.o.quick ? 200 : 2000
    )
    this.fast.unref?.()
  }

  /** Finds the device showing `code` and pairs with it. */
  join(code: string): Promise<LanResult> {
    if (this.looking) this.looking.done({ ok: false, changed: false, message: 'Stopped: a new code was typed.' })
    return new Promise<LanResult>((resolve) => {
      const timer = setTimeout(
        () => finish({ ok: false, changed: false, message: 'No device showing that code on this Wi-Fi.' }),
        this.o.quick ? 6000 : LOOK_MS
      )
      const finish = (r: LanResult): void => {
        clearTimeout(timer)
        if (this.looking?.done === finish) this.looking = null
        resolve(r)
      }
      this.looking = { code, until: Date.now() + LOOK_MS, done: finish }
      this.quicken()
      /* Devices already heard showing a code: no need to wait for the next announcement. */
      for (const h of this.heard.values()) if (h.pairing && h.port && Date.now() - h.at < 10_000) void this.tryPair(h)
    })
  }

  private async tryPair(h: Heard): Promise<void> {
    const key = `pair:${h.id}`
    if (this.pairing || Date.now() - (this.tried.get(key) ?? 0) < (this.o.quick ? 500 : 3000)) return
    this.tried.set(key, Date.now())
    const sock = await dial(h.address, h.port)
    if (!sock) return
    await this.pairOver(new Wire(sock), true)
  }

  /**
   * One pairing exchange, from whichever end opened the connection. Only one
   * at a time: two at once could each finish with a different secret.
   */
  private async pairOver(wire: Wire, opened: boolean, first?: Msg): Promise<void> {
    if (this.pairing) {
      wire.send({ t: 'busy' })
      return wire.close()
    }
    const shows = Boolean(this.showing && Date.now() < this.showing.until)
    const code = shows ? this.showing?.code : this.looking?.code
    if (!code) {
      wire.send({ t: 'no' })
      return wire.close()
    }
    this.pairing = true
    try {
      const half = spakeStart(code, shows)
      const hello: Msg = { t: 'pair', id: this.st.id, name: this.o.name, port: this.tcpPort, shows, msg: hex(half.msg) }
      const theirs = opened ? await wire.ask(hello) : (first ?? null)
      if (!theirs || theirs.t !== 'pair' || typeof theirs.id !== 'string' || !/^[0-9a-f]{32}$/.test(theirs.id)) return
      /* One shows and one types: two showing (or two typing) is not a pair. */
      if (Boolean(theirs.shows) === shows) {
        if (!opened) wire.send({ t: 'no' })
        return
      }
      const ids = shows ? { shows: this.st.id, types: theirs.id } : { shows: theirs.id, types: this.st.id }
      let other: bigint
      try {
        other = BigInt(`0x${String(theirs.msg ?? '').slice(0, 600)}`)
      } catch {
        return
      }
      const k = spakeFinish(half, other, ids)
      if (!k) return
      const me = shows ? 'shows' : 'types'
      const them = shows ? 'types' : 'shows'
      const name = String(theirs.name ?? 'another device').slice(0, 60)
      /*
       * The answering side sends its half and its proof together; the opener
       * checks it, then sends its own; the answer keeps the pairing and says
       * so, and only then does the opener keep it.
       */
      if (opened) {
        if (!same(theirs.conf, mac(k, 'confirm', them))) return this.wrongCode(shows, wire)
        const done = await wire.ask({ t: 'conf', conf: mac(k, 'confirm', me) })
        if (done?.t !== 'ok') return
      } else {
        const back = await wire.ask({ ...hello, conf: mac(k, 'confirm', me) })
        if (!back || back.t !== 'conf' || !same(back.conf, mac(k, 'confirm', them))) return this.wrongCode(shows, wire)
      }
      const secret = mac(k, 'pair secret')
      const sealed = this.o.seal ? this.o.seal(secret) : secret
      if (!sealed) {
        this.o.log('[skills] wifi: paired, but the secret could not be protected, so it was not kept')
        return
      }
      this.st.peers = this.st.peers.filter((p) => p.id !== theirs.id)
      /* Where it is, from this very connection: no waiting for its next announcement. */
      this.st.peers.push({ id: theirs.id, name, secret: sealed, base: {}, ...where(wire, theirs.port, this.heard.get(theirs.id)) })
      this.save()
      if (!opened) wire.send({ t: 'ok' })
      this.o.log(`[skills] wifi: paired with ${name}`)
      this.showing = null
      const looking = this.looking
      this.looking = null
      this.pairing = false
      wire.close()
      if (looking) {
        const peer = this.st.peers.find((p) => p.id === theirs.id) as Peer
        const r = await this.syncWith(peer)
        looking.done({ ok: true, changed: r.changed, message: `Paired with **${name}**${r.ok ? `: ${r.message}` : ''}.` })
      } else this.o.note?.(`Paired with **${name}**. Skills sync over Wi-Fi now.`)
    } finally {
      this.pairing = false
      wire.close()
    }
  }

  private wrongCode(shows: boolean, wire: Wire): void {
    wire.close()
    if (shows && this.showing) {
      this.showing.fails++
      this.o.log(`[skills] wifi: a wrong pairing code (${this.showing.fails} of ${MAX_FAILS})`)
      if (this.showing.fails >= MAX_FAILS) {
        this.showing = null
        this.o.note?.('Pairing code cancelled after 3 wrong tries. `/sync pair` for a new one.')
      }
    }
    if (!shows && this.looking) this.looking.done({ ok: false, changed: false, message: 'That code did not match.' })
  }

  /* -------------------------------------------------------------- syncing */

  /** Shortly: at once from the device with the lower id, a few seconds later from the other. */
  private soon(peer: Peer): void {
    if (this.timers.has(peer.id)) return
    const quick = this.o.quick
    const ms = this.st.id < peer.id ? (quick ? 50 : 500) : (quick ? 400 : 6000) + randomInt(0, quick ? 100 : 3000)
    const t = setTimeout(() => {
      this.timers.delete(peer.id)
      const h = this.heard.get(peer.id)
      if (h && h.rev === peer.agreed?.theirs && this.rev() === peer.agreed?.mine) return
      void this.syncWith(peer)
    }, ms)
    t.unref?.()
    this.timers.set(peer.id, t)
  }

  /** A skill here changed: say so now, so the others come for it. */
  nudge(): void {
    this.revCache = null
    if (!this.udp) return
    this.announce()
    for (const p of this.st.peers) if (p.addr && p.port) this.soon(p)
  }

  /** Every paired device that can be reached, now. */
  async syncAll(): Promise<LanResult[]> {
    const out: LanResult[] = []
    for (const p of this.st.peers) out.push(await this.syncWith(p))
    return out
  }

  private async syncWith(peer: Peer): Promise<LanResult> {
    const fail = (why: string): LanResult => ({ ok: false, changed: false, message: why, peer: peer.name })
    const h = this.heard.get(peer.id)
    const address = h?.address ?? peer.addr
    const port = h?.port ?? peer.port
    if (!address || !port) return fail('not found on this Wi-Fi')
    const secret = this.secretOf(peer)
    if (!secret) return fail('its pairing could not be read; pair again')
    if (this.busy) return fail('busy, try again')
    this.busy = true
    let wire: Wire | null = null
    try {
      const sock = await dial(address, port)
      if (!sock) return fail('not found on this Wi-Fi')
      wire = new Wire(sock)
      const n1 = randomBytes(16).toString('base64')
      const back = await wire.ask({ t: 'hello', id: this.st.id, port: this.tcpPort, n: n1 })
      if (!back || back.t !== 'hello' || back.id !== peer.id) return fail(back?.t === 'unknown' ? 'it no longer knows this device; pair again' : 'did not answer')
      const n2 = String(back.n ?? '')
      if (!same(back.proof, mac(secret, 'answer', n1, n2, peer.id, this.st.id))) return fail('could not prove it is the same device; pair again')
      wire.send({ t: 'proof', proof: mac(secret, 'open', n1, n2, this.st.id, peer.id) })
      wire.seal(Buffer.from(mac(secret, 'key', 'out', n1, n2), 'base64'), Buffer.from(mac(secret, 'key', 'back', n1, n2), 'base64'))
      const ready = await wire.next()
      if (ready?.t !== 'ready') return fail(ready?.t === 'busy' ? 'busy, try again' : 'did not answer')

      const base = { ...peer.base }
      const first = this.o.store.syncView(new Set(Object.keys(base)))
      const theirs = await wire.ask({ t: 'view', also: [...new Set([...Object.keys(first), ...Object.keys(base)])] })
      const remote = (theirs?.view ?? {}) as Record<string, { hash: string; at: number }>
      if (theirs?.t !== 'view') return fail('stopped answering')
      const view = this.o.store.syncView(new Set([...Object.keys(base), ...Object.keys(remote)]))
      const local = Object.fromEntries(Object.entries(view).map(([n, v]) => [n, { hash: v.hash, at: v.at }]))
      const steps = plan(local, remote, base)
      let changed = false
      for (const [name, step] of Object.entries(steps)) {
        if (step === 'same') base[name] = local[name]?.hash ?? null
        else if (step === 'upload') {
          if ((await wire.ask({ t: 'put', name, text: view[name].text }))?.ok === true) base[name] = local[name].hash
        } else if (step === 'deleteRemote') {
          if ((await wire.ask({ t: 'drop', name }))?.ok === true) base[name] = null
        } else if (step === 'download') {
          const got = await wire.ask({ t: 'get', name })
          const text = typeof got?.text === 'string' ? got.text : ''
          if (text && parseSkill(name, text).name === name && this.o.store.put(name, text)) {
            base[name] = remote[name].hash
            changed = true
          }
        } else if (step === 'deleteLocal') {
          if (this.o.store.drop(name)) {
            base[name] = null
            changed = true
          }
        }
      }
      this.revCache = null
      const mine = this.rev()
      const done = await wire.ask({ t: 'done', base, rev: mine })
      if (done?.t !== 'done') return fail('stopped before the end; it will finish next time')
      peer.base = base
      peer.agreed = { mine, theirs: String(done.rev ?? '') }
      peer.synced = Date.now()
      peer.addr = address
      peer.port = port
      this.save()
      if (changed) this.o.changed()
      const line = summary(steps).line
      this.o.log(`[skills] wifi sync with ${peer.name}: ${line}`)
      return { ok: true, changed, message: line, peer: peer.name }
    } catch (err) {
      return fail(String((err as Error)?.message ?? err).slice(0, 120))
    } finally {
      wire?.close()
      this.busy = false
    }
  }

  /** A connection from another device: a pairing, or a paired device come to sync. */
  private async serve(wire: Wire): Promise<void> {
    const first = await wire.next()
    if (!first) return wire.close()
    if (first.t === 'pair') return this.pairOver(wire, false, first)
    if (first.t !== 'hello') return wire.close()
    const peer = this.st.peers.find((p) => p.id === first.id)
    const secret = peer ? this.secretOf(peer) : null
    if (!peer || !secret) {
      wire.send({ t: 'unknown' })
      return wire.close()
    }
    const n1 = String(first.n ?? '')
    const n2 = randomBytes(16).toString('base64')
    const proof = await wire.ask({ t: 'hello', id: this.st.id, n: n2, proof: mac(secret, 'answer', n1, n2, this.st.id, peer.id) })
    if (!proof || !same(proof.proof, mac(secret, 'open', n1, n2, peer.id, this.st.id))) return wire.close()
    /* Proved: so this is where it is now. */
    Object.assign(peer, where(wire, first.port, this.heard.get(peer.id)))
    wire.seal(Buffer.from(mac(secret, 'key', 'back', n1, n2), 'base64'), Buffer.from(mac(secret, 'key', 'out', n1, n2), 'base64'))
    if (this.busy) {
      wire.send({ t: 'busy' })
      return wire.close()
    }
    this.busy = true
    let changed = false
    try {
      wire.send({ t: 'ready' })
      for (;;) {
        const m = await wire.next()
        if (!m) return
        const name = typeof m.name === 'string' ? m.name : ''
        if (m.t === 'view') {
          const also = new Set(Array.isArray(m.also) ? m.also.map(String) : [])
          const v = this.o.store.syncView(also)
          wire.send({ t: 'view', view: Object.fromEntries(Object.entries(v).map(([n, x]) => [n, { hash: x.hash, at: x.at }])) })
        } else if (m.t === 'get') {
          wire.send({ t: 'text', text: this.o.store.syncView(new Set([name]))[name]?.text ?? '' })
        } else if (m.t === 'put') {
          const text = typeof m.text === 'string' ? m.text : ''
          const ok = Boolean(text && parseSkill(name, text).name === name && this.o.store.put(name, text))
          changed ||= ok
          wire.send({ t: 'ok', ok })
        } else if (m.t === 'drop') {
          const ok = this.o.store.drop(name)
          changed ||= ok
          wire.send({ t: 'ok', ok })
        } else if (m.t === 'done') {
          const base = (m.base && typeof m.base === 'object' ? m.base : {}) as Record<string, string | null>
          this.revCache = null
          const mine = this.rev()
          peer.base = base
          peer.agreed = { mine, theirs: String(m.rev ?? '') }
          peer.synced = Date.now()
          this.save()
          wire.send({ t: 'done', rev: mine })
          this.o.log(`[skills] wifi sync from ${peer.name}${changed ? ': skills changed' : ''}`)
          return
        } else return
      }
    } finally {
      this.busy = false
      wire.close()
      if (changed) this.o.changed()
    }
  }
}

/**
 * Lets the other device in through ufw, which Omarchy turns on with every
 * port closed: once, behind a password pop-up - "just make it pop-up box and
 * then I will type in the passwords". Elsewhere there is nothing to do here:
 * Windows asks by itself the first time Wumpy listens.
 */
export async function openFirewall(port = LAN_PORT): Promise<'open' | 'opened' | 'refused'> {
  if (process.platform !== 'linux') return 'open'
  let conf = ''
  try {
    conf = readFileSync('/etc/ufw/ufw.conf', 'utf8')
  } catch {
    return 'open'
  }
  if (!/^ENABLED=yes/m.test(conf)) return 'open'
  try {
    if (new RegExp(`--dport ${port}\\b`).test(readFileSync('/etc/ufw/user.rules', 'utf8'))) return 'open'
  } catch {
    /* Cannot tell: ask. */
  }
  return new Promise((resolve) => {
    execFile('pkexec', ['/usr/bin/ufw', 'allow', String(port), 'comment', 'Wumpy skills sync'], { timeout: 180_000 }, (err) =>
      resolve(err ? 'refused' : 'opened')
    )
  })
}
