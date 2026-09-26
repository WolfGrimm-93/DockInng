// Sesión de terminal real sobre `subscribe_exec` (Channel ExecFeed) + `exec_write` / `exec_resize` / `exec_close`.
// Bytes: el backend manda `output` en base64 (bytes crudos); aquí se decodifican a Uint8Array para xterm (UTF-8 con estado).
// Entrada: las escrituras se SERIALIZAN (una invoke a la vez, coalescidas ≤ 16 KiB) para que el orden de teclas no se altere.
import { Channel, invoke } from '@tauri-apps/api/core'
import { toApiError } from '../../errors'
import { toast } from '@/lib/toastStore'
import type { ExecExit, ExecFeed, ExecInfo, ExecOptions, ExecSession, Unsubscribe } from '../../types'

const MAX_WRITE = 16 * 1024

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Emisor que reproduce lo emitido antes de que alguien se suscriba (la sesión empieza a recibir antes de que la UI enganche xterm). */
class Replay<T> {
  private buf: T[] = []
  private subs = new Set<(v: T) => void>()
  emit(v: T) {
    if (this.subs.size === 0) this.buf.push(v)
    else for (const s of this.subs) s(v)
  }
  on(cb: (v: T) => void): Unsubscribe {
    this.subs.add(cb)
    const pending = this.buf
    this.buf = []
    for (const v of pending) cb(v)
    return () => { this.subs.delete(cb) }
  }
}

/** Trocea por BYTES UTF-8 (el backend limita `exec_write` a 16384 bytes) sin partir nunca un carácter (ni un par sustituto). O(n). */
export function chunkText(text: string, maxBytes = MAX_WRITE): string[] {
  const out: string[] = []
  let start = 0
  let bytes = 0
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) as number
    const units = cp > 0xffff ? 2 : 1
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + len > maxBytes) { out.push(text.slice(start, i)); start = i; bytes = 0 }
    bytes += len
    i += units
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

const BACKOFF_MS = [40, 80, 160, 320, 640]
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function openExec(containerId: string, o: ExecOptions): Promise<ExecSession> {
  const opened = new Replay<ExecInfo>()
  const output = new Replay<Uint8Array>()
  const exited = new Replay<ExecExit>()
  const channel = new Channel<ExecFeed>()
  channel.onmessage = (f) => {
    if (f.type === 'opened') opened.emit({ shell: f.shell, risk: f.risk })
    else if (f.type === 'output') output.emit(b64ToBytes(f.data))
    else exited.emit({ reason: f.reason, exit_code: f.exit_code, error: f.error })
  }
  let id: string
  try {
    id = await invoke<string>('subscribe_exec', { id: containerId, cols: o.cols, rows: o.rows, onEvent: channel })
  } catch (e) {
    channel.onmessage = () => {}
    throw toApiError(e)
  }
  let closed = false
  const queue: string[] = []
  let sending = false
  const pump = async () => {
    if (sending) return
    sending = true
    try {
      while (queue.length && !closed) {
        const chunk = queue[0]
        let sent = false
        for (let attempt = 0; !sent && !closed; attempt++) {
          try {
            await invoke('exec_write', { subscriptionId: id, data: chunk })
            sent = true
          } catch (e) {
            const err = toApiError(e)
            // «Terminal saturada» (conflict): se reintenta con espera acotada. Cualquier otro error: se DETIENE la entrada (no se sigue
            // enviando texto salteado a un shell), se vacía lo pendiente y se avisa.
            if (err.code === 'conflict' && attempt < BACKOFF_MS.length) { await sleepMs(BACKOFF_MS[attempt]); continue }
            queue.length = 0
            toast.err('Se perdió parte de lo escrito en la terminal', { sub: err.message })
            return
          }
        }
        queue.shift()
      }
    } finally { sending = false }
  }
  return {
    write(data) {
      if (closed || !data) return
      queue.push(...chunkText(data))
      void pump()
    },
    resize(cols, rows) {
      if (closed) return
      void invoke('exec_resize', { subscriptionId: id, cols, rows }).catch(() => {})
    },
    onOpen: (cb) => opened.on(cb),
    onOutput: (cb) => output.on(cb),
    onExit: (cb) => exited.on(cb),
    close() {
      if (closed) return
      closed = true
      queue.length = 0
      channel.onmessage = () => {}
      void invoke('exec_close', { subscriptionId: id }).catch(() => {})
    },
  }
}
