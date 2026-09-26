// Terminal simulada (contrato ExecSession de xterm): mini-shell con ANSI. Recibe las teclas tal cual las manda xterm
// (\r, \x7f, \x03, \x0c, \x1b[A/B) y responde con bytes (Uint8Array). Cuenta sesiones abiertas/cerradas para detectar fugas.
import type { EngineApi } from '../../api'
import type { ExecExit, ExecInfo, ExecSession, Unsubscribe } from '../../types'
import { apiError, isRunning, type SimCtx } from './ctx'

const enc = new TextEncoder()
const C = { reset: '\x1b[0m', green: '\x1b[1;32m', blue: '\x1b[1;34m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m' }

export interface ExecStats { opened: number; closed: number; live: number }

class Replay<T> {
  private buf: T[] = []
  private subs = new Set<(v: T) => void>()
  emit(v: T) { if (this.subs.size === 0) this.buf.push(v); else for (const s of this.subs) s(v) }
  on(cb: (v: T) => void): Unsubscribe {
    this.subs.add(cb)
    const p = this.buf
    this.buf = []
    for (const v of p) cb(v)
    return () => { this.subs.delete(cb) }
  }
}

export function createSimExec(ctx: SimCtx): { open: EngineApi['exec']['open']; stats: ExecStats } {
  const stats: ExecStats = { opened: 0, closed: 0, live: 0 }
  const live = new Map<string, Set<(reason: ExecExit['reason']) => void>>()

  ctx.onContainerStopped((id) => {
    for (const end of [...(live.get(id) ?? [])]) end('container_stopped')
  })

  async function open(containerId: string, o: { cols: number; rows: number }): Promise<ExecSession> {
    const c = ctx.find(containerId)
    if (!isRunning(c)) throw apiError('conflict', 'el contenedor no está en ejecución')
    const id12 = c.id.slice(0, 12)
    const info: ExecInfo = {
      shell: '/bin/sh',
      risk: { privileged: false, docker_socket: c.mounts.some((m) => m.source.endsWith('docker.sock')), host_pid: false, host_network: false },
    }
    const opened = new Replay<ExecInfo>()
    const output = new Replay<Uint8Array>()
    const exited = new Replay<ExecExit>()
    let closed = false
    let ended = false
    let cols = o.cols
    let rows = o.rows
    let line = ''
    const history: string[] = []
    let hIdx = 0
    stats.opened++
    stats.live++
    const set = live.get(c.id) ?? new Set()
    live.set(c.id, set)

    const out = (s: string) => { if (!closed && !ended) output.emit(enc.encode(s)) }
    const prompt = () => out(`${C.green}root@${id12}${C.reset}:${C.blue}/app${C.reset}# `)
    const finish = (reason: ExecExit['reason'], code: number | null) => {
      if (ended) return
      ended = true
      set.delete(endFn)
      exited.emit({ reason, exit_code: code, error: null })
    }
    const endFn = (reason: ExecExit['reason']) => {
      if (reason === 'container_stopped') out('\r\n[el contenedor se detuvo]\r\n')
      finish(reason, null)
    }
    set.add(endFn)

    const run = (raw: string) => {
      const [name = '', ...args] = raw.trim().split(/\s+/)
      if (name === '') return
      if (name === 'clear') return out('\x1b[2J\x1b[H')
      if (name === 'exit') { out('exit\r\n'); return finish('process_exited', 0) }
      if (name === 'date') return out(new Date().toString().replace(/ GMT.*/, '') + '\r\n')
      if (name === 'echo') return out(args.join(' ') + '\r\n')
      if (name === 'stty' && args[0] === 'size') return out(`${rows} ${cols}\r\n`)
      if (name === 'flood') {
        // Salida masiva (rendimiento del renderer): N líneas de ~80 caracteres en trozos de 32 KiB.
        const n = Math.min(Math.max(parseInt(args[0] ?? '1000', 10) || 1000, 1), 200_000)
        const lineText = `${'0123456789abcdefghijklmnopqrstuvwxyz'.repeat(2)}-${'x'.repeat(8)}\r\n`
        let sent = 0
        const chunk = () => {
          if (closed || ended) return
          const k = Math.min(400, n - sent)
          out(Array.from({ length: k }, (_, i) => `${sent + i} ${lineText}`).join(''))
          sent += k
          if (sent < n) setTimeout(chunk, 0)
          else { out('\r\n'); prompt() }
        }
        chunk()
        pendingPrompt = false
        return
      }
      if (name === 'osc8') return out('\x1b]8;;https://evil.example/x\x07CLICKME\x1b]8;;\x07\r\n') // enlace OSC 8 hostil (prueba de que la terminal no abre nada)
      if (name === 'ls') {
        const colored = args.includes('--color')
        return out(colored ? `${C.blue}dist${C.reset}  ${C.blue}node_modules${C.reset}  ${C.blue}uploads${C.reset}  package.json  ${C.green}entrypoint.sh${C.reset}  ${C.cyan}latest -> dist${C.reset}\r\n` : 'dist  node_modules  uploads  package.json  entrypoint.sh\r\n')
      }
      const CMD: Record<string, string> = {
        help: 'Comandos de la demo: ls [--color], pwd, whoami, ps, env, node, uname, date, echo, stty size, flood N, osc8, clear, exit',
        pwd: '/app', whoami: 'root', node: 'v20.17.0',
        uname: `Linux ${id12} 6.10.11-arch1-1 x86_64 GNU/Linux`,
        ps: 'PID   USER     TIME  COMMAND\r\n    1 root      0:04 node dist/main.js\r\n   23 root      0:00 sh\r\n   31 root      0:00 ps',
        env: `NODE_ENV=production\r\nPORT=3000\r\nHOSTNAME=${id12}\r\nHOME=/root`,
      }
      // Object.hasOwn: «constructor» o «__proto__» no ejecutan nada.
      out(Object.hasOwn(CMD, name) ? CMD[name] + '\r\n' : `${C.red}sh: ${name}: no se encontró la orden${C.reset}\r\n`)
    }
    let pendingPrompt = true

    // Bienvenida (como un shell real: el primer prompt llega tras abrir).
    queueMicrotask(() => {
      opened.emit(info)
      out(`${C.dim}Conectado a ${c.names[0]} (sh). Escribe «help» para ver los comandos de la demo.${C.reset}\r\n`)
      prompt()
    })

    const feed = (data: string) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data[i]
        if (ch === '\x1b') {
          const seq = data.slice(i, i + 3)
          if (seq === '\x1b[A') { if (hIdx > 0) { hIdx--; out('\r\x1b[K'); line = history[hIdx] ?? ''; prompt(); out(line) } i += 2; continue }
          if (seq === '\x1b[B') { hIdx = Math.min(history.length, hIdx + 1); out('\r\x1b[K'); line = history[hIdx] ?? ''; prompt(); out(line); i += 2; continue }
          continue
        }
        if (ch === '\r' || ch === '\n') {
          out('\r\n')
          const cmd = line
          line = ''
          if (cmd.trim()) { history.push(cmd); hIdx = history.length }
          pendingPrompt = true
          run(cmd)
          if (pendingPrompt && !ended) prompt()
        } else if (ch === '\x7f' || ch === '\b') {
          if (line) { line = line.slice(0, -1); out('\b \b') }
        } else if (ch === '\x03') {
          line = ''
          out(`${C.dim}^C${C.reset}\r\n`)
          prompt()
        } else if (ch === '\x0c') {
          out('\x1b[2J\x1b[H')
          prompt()
          out(line)
        } else if (ch >= ' ') {
          line += ch
          out(ch)
        }
      }
    }

    return {
      write: (data) => { if (!closed && !ended) feed(data) },
      resize(c2, r2) { cols = c2; rows = r2 },
      onOpen: (cb) => opened.on(cb),
      onOutput: (cb) => output.on(cb),
      onExit: (cb) => exited.on(cb),
      close() {
        if (closed) return
        closed = true
        set.delete(endFn)
        stats.closed++
        stats.live--
      },
    }
  }
  return { open, stats }
}
