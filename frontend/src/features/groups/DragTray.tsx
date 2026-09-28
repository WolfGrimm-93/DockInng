// Bandeja de destinos del arrastre: chips fijos («Sin grupo» + cada grupo propio, incluidos los vacíos) que existen SOLO mientras dura el arrastre,
// más el «fantasma» bajo el puntero y la región `role="status"` con el anuncio para lectores de pantalla. La bandeja es visual (aria-hidden):
// la alternativa accesible es el menú «Mover a un grupo» de cada fila y de la barra masiva.
import { createPortal } from 'react-dom'
import { Icon } from '@/components/shared/Icon'
import { safeText } from '@/lib/safeText'
import { useDragStore } from './dragStore'
import { useGroupsStore } from './groupsStore'
import { hueStyle } from './hueStyle'

export const DRAG_HELP_ID = 'row-grip-help'

export function DragTray() {
  const count = useDragStore((s) => s.ids.length)
  const message = useDragStore((s) => s.message)
  const groups = useGroupsStore((s) => s.groups)
  return (
    <>
      {/* Texto al que apuntan las asas (aria-describedby): la alternativa sin arrastre. */}
      <p id={DRAG_HELP_ID} className="sr-only">Arrastra a un grupo, o usa el botón Mover a un grupo.</p>
      <div role="status" aria-live="polite" className="sr-only">{message}</div>
      {count > 0 ? createPortal(
        <>
          <div className="drag-tray" aria-hidden="true" data-drag-tray>
            <span className="drag-tray-label">Soltar en</span>
            <div className="drag-chip" data-drop-key="none"><Icon name="x" size="sm" />Sin grupo</div>
            {groups.map((g) => (
              <div key={g.id} className="drag-chip" data-drop-key={`g:${g.id}`} style={hueStyle(g.hue)}>
                <span className="grp-swatch" aria-hidden="true" />
                <Icon name="folder" size="sm" />{safeText(g.name, { singleLine: true })}
              </div>
            ))}
          </div>
          <div className="drag-ghost" aria-hidden="true" data-drag-ghost>{count} {count === 1 ? 'contenedor' : 'contenedores'}</div>
        </>,
        document.body,
      ) : null}
    </>
  )
}
