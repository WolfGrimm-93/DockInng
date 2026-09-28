// Arrastrar filas de la tabla de contenedores a un grupo, con eventos de puntero propios (no HTML5 DnD: en Tauri depende de `dragDropEnabled`
// y una fila virtualizada puede desmontarse a mitad del gesto; con listeners en `window` el gesto no se pierde).
// - Solo botón primario; umbral de 5 px antes de empezar (un clic simple no arrastra).
// - Destino = el elemento bajo el puntero con `data-drop-key` (`none` | `g:<id>` grupo propio | `s:<proyecto>` stack, no válido).
// - El resalte se pone por atributo (`data-drop="over|deny"`) directo en el DOM; el autoscroll usa rAF sobre el contenedor de la tabla.
// - Escape, pérdida de foco de la ventana o desmontaje cancelan el arrastre sin mover nada.
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Container } from '@/data/types'
import { containerName } from '@/data/store/engineStore'
import { toast } from '@/lib/toastStore'
import { assignKey, useGroupsStore } from './groupsStore'
import { useDragStore } from './dragStore'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
export const DRAG_THRESHOLD_PX = 5
const EDGE_PX = 48
const MAX_SCROLL_STEP = 18
const KEY_ATTR = 'data-drop-key'
const SELECTOR = `[${KEY_ATTR}]`

export interface RowDragOptions {
  profileId: string
  scrollRef: RefObject<HTMLElement | null>
  /** Conjunto a arrastrar al empezar por `c`: la selección efectiva si `c` está seleccionada; si no, solo `c`. */
  getDragged(c: Container): Container[]
}

/** Resultado de intentar soltar sobre una clave. Función pura para poder probarla sin DOM. */
export function dropOutcome(key: string, names: readonly string[], profileId: string, groups: readonly { id: string; name: string }[], assign: Record<string, string>): { kind: 'move'; groupId: string | null; label: string } | { kind: 'deny' | 'noop'; text: string } {
  if (key.startsWith('s:')) return { kind: 'deny', text: 'Un stack de Compose es automático: elige un grupo propio' }
  if (key === 'none') {
    if (!names.some((n) => assign[assignKey(profileId, n)] !== undefined)) return { kind: 'noop', text: 'Ya no pertenecían a ningún grupo propio' }
    return { kind: 'move', groupId: null, label: 'Sin grupo' }
  }
  const gid = key.startsWith('g:') ? key.slice(2) : ''
  const g = groups.find((x) => x.id === gid)
  if (!g) return { kind: 'deny', text: 'Ese grupo ya no existe' }
  if (names.every((n) => assign[assignKey(profileId, n)] === gid)) return { kind: 'noop', text: `Ya estaban en «${g.name}»` }
  return { kind: 'move', groupId: gid, label: g.name }
}

/** Devuelve el manejador `pointerdown` del asa de cada fila (estable: lee lo último desde refs). */
export function useRowDrag(opts: RowDragOptions): (e: ReactPointerEvent<HTMLElement>, c: Container) => void {
  const optsRef = useRef(opts)
  // Se actualiza tras cada render (no durante): el manejador estable lee siempre lo último.
  useEffect(() => { optsRef.current = opts })
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  return useCallback((e, c) => {
    if (e.button !== 0 || e.isPrimary === false) return
    cleanupRef.current?.()
    const startX = e.clientX
    const startY = e.clientY
    let started = false
    let over: Element | null = null
    let raf = 0
    let last = { x: startX, y: startY }
    let names: string[] = []

    const setOver = (el: Element | null, state: 'over' | 'deny' | null) => {
      if (over && over !== el) over.removeAttribute('data-drop')
      over = el
      if (el) { if (state) el.setAttribute('data-drop', state); else el.removeAttribute('data-drop') }
    }
    const targetAt = (x: number, y: number): Element | null => document.elementFromPoint?.(x, y)?.closest(SELECTOR) ?? null
    const refreshTarget = () => {
      const t = targetAt(last.x, last.y)
      const key = t?.getAttribute(KEY_ATTR)
      setOver(t, key ? (key.startsWith('s:') ? 'deny' : 'over') : null)
    }
    const ghost = () => document.querySelector<HTMLElement>('[data-drag-ghost]')
    const placeGhost = () => {
      const g = ghost()
      if (g) g.style.transform = `translate(${last.x + 14}px, ${last.y + 14}px)`
    }
    const loop = () => {
      const sc = optsRef.current.scrollRef.current
      if (sc) {
        const r = sc.getBoundingClientRect()
        let dy = 0
        if (last.y < r.top + EDGE_PX) dy = -Math.ceil(((r.top + EDGE_PX - last.y) / EDGE_PX) * MAX_SCROLL_STEP)
        else if (last.y > r.bottom - EDGE_PX) dy = Math.ceil(((last.y - (r.bottom - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_STEP)
        if (dy !== 0 && r.height > 0) { sc.scrollTop += dy; refreshTarget() }
      }
      raf = requestAnimationFrame(loop)
    }

    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onCancel)
      if (raf) cancelAnimationFrame(raf)
      setOver(null, null)
      document.body.classList.remove('is-row-dragging')
      cleanupRef.current = null
    }
    const cancel = (message = '') => {
      const was = started
      stop()
      if (was) useDragStore.getState().end(message)
    }
    function onCancel() { cancel(started ? 'Arrastre cancelado.' : '') }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape' && started) { ev.preventDefault(); ev.stopPropagation(); cancel('Arrastre cancelado.') }
    }
    function onMove(ev: PointerEvent) {
      last = { x: ev.clientX, y: ev.clientY }
      if (!started) {
        if (Math.hypot(last.x - startX, last.y - startY) < DRAG_THRESHOLD_PX) return
        const dragged = optsRef.current.getDragged(c)
        names = dragged.map((d) => containerName(d))
        started = true
        document.body.classList.add('is-row-dragging')
        useDragStore.getState().start(dragged.map((d) => d.id), names)
        raf = requestAnimationFrame(loop)
      }
      placeGhost()
      refreshTarget()
    }
    function onUp(ev: PointerEvent) {
      if (!started) { stop(); return }
      const key = targetAt(ev.clientX, ev.clientY)?.getAttribute(KEY_ATTR) ?? null
      const dragged = names
      stop()
      if (!key) { useDragStore.getState().end('Arrastre cancelado.'); return }
      const { groups, assign, moveContainers } = useGroupsStore.getState()
      const out = dropOutcome(key, dragged, optsRef.current.profileId, groups, assign)
      if (out.kind === 'move') {
        moveContainers(optsRef.current.profileId, dragged, out.groupId)
        const msg = `${plural(dragged.length, 'contenedor movido', 'contenedores movidos')} a «${out.label}»`
        toast.ok(msg)
        useDragStore.getState().end('') // el aviso lo anuncia el toast (role=status): no se repite aquí
      } else {
        toast.warn(out.text)
        useDragStore.getState().end('')
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onCancel)
    cleanupRef.current = () => cancel('')
  }, [])
}
