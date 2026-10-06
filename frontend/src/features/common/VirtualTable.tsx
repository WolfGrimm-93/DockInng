// Tabla con filas virtualizadas de altura fija (imágenes, volúmenes, redes). Mantiene <table>, <caption> y <th> sticky.
// Contrato: <VirtualTable caption cols head rows rowKey renderRow(row, {index, measure}) scrollRef empty? />
//   `head` = <tr> de cabecera. `scrollRef` = ref del `.view-body` (elemento con scroll) que crea el padre.
import { useMemo, useRef, type ReactNode, type Ref, type RefObject } from 'react'
import { readRowHeight, useVirtualTable } from './useVirtualTable'

export function VirtualTable<T>({ caption, cols, head, rows, rowKey, renderRow, scrollRef, empty }: {
  caption: string
  cols: number
  head: ReactNode
  rows: T[]
  rowKey(row: T): string
  renderRow(row: T, o: { index: number; measure: Ref<HTMLTableRowElement> }): ReactNode
  scrollRef: RefObject<HTMLElement | null>
  empty?: ReactNode
}) {
  const tableRef = useRef<HTMLTableElement>(null)
  const rowH = useMemo(() => readRowHeight(), [])
  const virt = useVirtualTable({ count: rows.length, scrollRef, tableRef, estimate: () => rowH })
  const spacer = (h: number, k: string) => (
    <tr key={k} aria-hidden="true" className="bg-transparent pointer-events-none">
      <td colSpan={cols} className="p-0 border-0" style={{ height: h }} />
    </tr>
  )
  return (
    <div className="table-wrap">
      <table ref={tableRef} aria-rowcount={rows.length + 1}>
        <caption className="sr-only">{caption}</caption>
        <thead>{head}</thead>
        <tbody>
          {!rows.length ? (
            <tr><td colSpan={cols} className="h-auto">{empty}</td></tr>
          ) : (
            <>
              {virt.padTop > 0 ? spacer(virt.padTop, 'top') : null}
              {virt.items.map((v) => {
                const r = rows[v.index]
                return r === undefined ? null : <FragmentKey key={rowKey(r)}>{renderRow(r, { index: v.index, measure: virt.measure })}</FragmentKey>
              })}
              {virt.padBottom > 0 ? spacer(virt.padBottom, 'bottom') : null}
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FragmentKey({ children }: { children: ReactNode }) {
  return <>{children}</>
}
