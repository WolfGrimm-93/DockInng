// Virtualización de filas de <table> con espaciadores (mantiene la semántica de tabla y los <th> sticky).
// Contrato: useVirtualTable({ count, scrollRef, tableRef, estimate(i) }) ->
//   { items: VirtualItem[], padTop, padBottom, measure(el) }   (el padre pinta <tr aria-hidden> de padTop/padBottom)
// El elemento con scroll es `.view-body`; `scrollMargin` = desplazamiento de la tabla dentro de él.
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { useLayoutEffect, useState, type RefObject } from 'react'

/** Altura de fila en px según el token --row-h (48 px; 44 px en ventanas bajas). */
export function readRowHeight(): number {
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'))
    return Number.isFinite(v) && v > 0 ? v : 48
  } catch {
    return 48
  }
}

export function useVirtualTable(o: {
  count: number
  scrollRef: RefObject<HTMLElement | null>
  tableRef: RefObject<HTMLElement | null>
  estimate(index: number): number
  overscan?: number
}): { items: VirtualItem[]; padTop: number; padBottom: number; measure: (el: Element | null) => void; total: number; scrollToIndex(i: number): void } {
  const [margin, setMargin] = useState(0)
  // Sin dependencias a propósito: el desplazamiento de la tabla cambia si aparece un banner; setMargin solo actúa si cambia.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const s = o.scrollRef.current
    const t = o.tableRef.current
    if (!s || !t) return
    const m = t.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop
    setMargin((prev) => (Math.abs(prev - m) > 0.5 ? m : prev))
  })
  // eslint-disable-next-line react-hooks/incompatible-library
  const virt = useVirtualizer({
    count: o.count,
    getScrollElement: () => o.scrollRef.current,
    estimateSize: o.estimate,
    overscan: o.overscan ?? 8,
    scrollMargin: margin,
    // Sin layout (jsdom, elemento oculto) el alto medido es 0: se usa la estimación para no renderizar todas las filas.
    measureElement: (el) => {
      const h = Math.round(el.getBoundingClientRect().height)
      return h > 0 ? h : o.estimate(Number(el.getAttribute('data-index')) || 0)
    },
    initialRect: { width: 900, height: 640 },
  })
  const items = virt.getVirtualItems()
  const total = virt.getTotalSize()
  const padTop = items.length ? Math.max(0, items[0].start - margin) : 0
  const padBottom = items.length ? Math.max(0, total - (items[items.length - 1].end - margin)) : 0
  return { items, padTop, padBottom, measure: virt.measureElement, total, scrollToIndex: (i) => virt.scrollToIndex(i) }
}
