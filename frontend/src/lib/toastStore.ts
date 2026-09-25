// Store de toasts SIN dependencias de React (lo usan la capa de datos y los componentes). Contrato:
//   toast.ok(msg, {sub?, sticky?}) / toast.warn(...) / toast.err(...) -> id (UUID v7)
//   toast.dismiss(id) · policyDenied(action, reason)
//   ok/warn duran 4500 ms, err 8000 ms (la pausa por hover/foco la gestiona el componente Toaster).
//   role="alert" solo en err (lo pinta Toaster).
import { safeText } from './safeText'
import { uuidv7 } from './uuid7'

export type ToastKind = 'ok' | 'warn' | 'err'
export interface ToastOptions { sub?: string; sticky?: boolean }
export interface ToastItem { id: string; kind: ToastKind; msg: string; sub?: string; sticky: boolean; count: number; /** Solo el resumen «+N más». */ overflow?: number }

const MAX_VISIBLE = 5
/** Por encima de este total visible el resto se agrupa en un único «+N más» (los errores nunca se pierden). */
const MAX_TOTAL = 6
let items: ToastItem[] = []
let expanded = false
let snapshot: ToastItem[] = []
const listeners = new Set<() => void>()
function recompute() {
  if (expanded || items.length <= MAX_TOTAL) snapshot = items
  else {
    const keep = items.slice(-(MAX_TOTAL - 1))
    const hidden = items.length - keep.length
    snapshot = [{ id: 'toast-overflow', kind: 'warn', msg: `+${hidden} más`, sticky: true, count: 1, overflow: hidden }, ...keep]
  }
}
const emit = () => {
  if (items.length <= MAX_TOTAL) expanded = false
  recompute()
  listeners.forEach((l) => l())
}

export function subscribeToasts(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const getToasts = (): ToastItem[] => snapshot

function push(kind: ToastKind, msg: string, o: ToastOptions = {}): string {
  const m = safeText(msg, { singleLine: true })
  const sb = o.sub === undefined ? undefined : safeText(o.sub, { singleLine: true })
  // Mensajes idénticos consecutivos se colapsan con contador ×N (20 errores iguales = un toast «×20»).
  const dup = items.find((t) => t.kind === kind && t.msg === m && t.sub === sb && t.sticky === !!o.sticky)
  if (dup) {
    items = items.map((t) => (t === dup ? { ...t, count: t.count + 1 } : t))
    emit()
    return dup.id
  }
  const id = uuidv7()
  // Tope de 5 visibles. Se expulsa primero el informativo (ok/warn no persistente) más antiguo; los errores y los sticky
  // (policyDenied) nunca se descartan por el tope (si TODOS son errores/sticky se permite pasar de 5 antes que perder uno).
  items = [...items, { id, kind, msg: m, sub: sb, sticky: !!o.sticky, count: 1 }]
  while (items.length > MAX_VISIBLE) {
    const i = items.findIndex((t) => t.kind !== 'err' && !t.sticky)
    if (i < 0) break
    items = items.filter((_, k) => k !== i)
  }
  emit()
  return id
}

export const toast = {
  ok: (msg: string, o?: ToastOptions) => push('ok', msg, o),
  warn: (msg: string, o?: ToastOptions) => push('warn', msg, o),
  err: (msg: string, o?: ToastOptions) => push('err', msg, o),
  /** «Ver todas» del resumen +N más. */
  expandAll() {
    expanded = true
    recompute()
    listeners.forEach((l) => l())
  },
  /** «Descartar» del resumen: quita los toasts ocultos por el tope (los más antiguos). */
  dismissHidden() {
    if (items.length > MAX_TOTAL - 1) items = items.slice(-(MAX_TOTAL - 1))
    emit()
  },
  dismiss(id: string) {
    const n = items.filter((t) => t.id !== id)
    if (n.length !== items.length) {
      items = n
      emit()
    }
  },
  clear() {
    items = []
    expanded = false
    emit()
  },
}

/** Resultado «Deny inesperado» de la política: el backend rechazó algo que la UI permitía (fallo de la app, no del usuario). */
export function policyDenied(action: string, reason: string): string {
  return toast.err(`El motor de seguridad rechazó «${action}»`, { sub: reason, sticky: true })
}
