// Asa de la columna «Nombre» (dentro de su `th`): separador vertical con ratón (arrastrar), teclado (←/→ ±16 px, Mayús ±64) y restablecer
// (doble clic o Inicio). Los listeners van en `window`; durante el arrastre solo se toca el DOM y el estado se fija al soltar.
import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { NAME_W_MAX, NAME_W_MIN, clampNameWidth, type NameColumnWidth } from './useNameColumnWidth'

export function NameResizer({ th, ctl }: { th: RefObject<HTMLTableCellElement | null>; ctl: Pick<NameColumnWidth, 'width' | 'preview' | 'commit'> }) {
  const btn = useRef<HTMLDivElement>(null)
  const current = (): number => ctl.width ?? Math.round(th.current?.getBoundingClientRect().width ?? NAME_W_MIN)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    btn.current?.focus()
    const x0 = e.clientX
    const w0 = current()
    let last = w0
    btn.current?.classList.add('is-active')
    document.body.classList.add('is-col-resizing')
    const move = (ev: PointerEvent) => { last = clampNameWidth(w0 + ev.clientX - x0); ctl.preview(last) }
    const end = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      btn.current?.classList.remove('is-active')
      document.body.classList.remove('is-col-resizing')
      if (commit) ctl.commit(last)
      else ctl.preview(ctl.width)
    }
    const up = () => end(true)
    const cancel = () => end(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') { e.preventDefault(); ctl.commit(current() - step) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ctl.commit(current() + step) }
    else if (e.key === 'Home') { e.preventDefault(); ctl.commit(null) }
  }
  return (
    <div
      ref={btn}
      className="name-resizer"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label="Ancho de la columna Nombre"
      aria-valuemin={NAME_W_MIN}
      aria-valuemax={NAME_W_MAX}
      aria-valuenow={ctl.width ?? undefined}
      aria-valuetext={ctl.width === null ? 'Automático' : `${ctl.width} píxeles`}
      title="Arrastra para cambiar el ancho · doble clic o Inicio: automático"
      onPointerDown={onPointerDown}
      onDoubleClick={() => ctl.commit(null)}
      onKeyDown={onKeyDown}
    />
  )
}
