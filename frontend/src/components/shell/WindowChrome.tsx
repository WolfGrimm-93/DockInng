// Barra de ventana PROPIA para cuando la app va sin marco (pref `window_decorations` = false): zona de arrastre, minimizar/maximizar/cerrar
// y 8 tiras de redimensionado. Todo va por comandos propios del backend (`window_*`), sin permisos `core:window` en la webview.
// Con la barra del sistema (por defecto) no se dibuja nada. El botón de cerrar pasa por el cierre controlado (respeta «cerrar a la bandeja»).
// Siempre hay una salida: «Volver a la barra del sistema».
import { useEffect, type MouseEvent } from 'react'
import { Icon } from '@/components/shared/Icon'
import { useEngineApi } from '@/data/store/hooks'
import { useShellPrefs } from '@/data/shellPrefs'
import type { WindowEdge } from '@/data/types'

const EDGES: WindowEdge[] = ['north', 'south', 'east', 'west', 'north_east', 'north_west', 'south_east', 'south_west']

export function WindowChrome() {
  const api = useEngineApi()
  const loaded = useShellPrefs((s) => s.loaded)
  const decorations = useShellPrefs((s) => s.decorations)
  const setDecorations = useShellPrefs((s) => s.setDecorations)
  const shown = loaded && !decorations
  // El contenido baja la altura de la barra (ver `.has-chrome .shell` en ola3.css).
  useEffect(() => {
    document.documentElement.classList.toggle('has-chrome', shown)
    return () => document.documentElement.classList.remove('has-chrome')
  }, [shown])
  if (!shown) return null
  const run = (p: Promise<void>) => { void p.catch(() => {}) }
  const startDrag = (e: MouseEvent) => { if (e.button === 0 && e.detail < 2) run(api.window.startDrag()) }
  return (
    <>
      <div className="window-chrome" role="toolbar" aria-label="Controles de la ventana">
        <div className="wc-title" data-testid="window-drag" onMouseDown={startDrag} onDoubleClick={() => run(api.window.toggleMaximize())}>
          <Icon name="box" size="sm" />DockInng
        </div>
        <div className="wc-btns">
          <button type="button" className="wc-btn" aria-label="Volver a la barra del sistema" title="Volver a la barra del sistema" onClick={() => void setDecorations(api, true)}><Icon name="panel" size="sm" /></button>
          <button type="button" className="wc-btn" aria-label="Minimizar" title="Minimizar" onClick={() => run(api.window.minimize())}><Icon name="minus" size="sm" /></button>
          <button type="button" className="wc-btn" aria-label="Maximizar o restaurar" title="Maximizar o restaurar" onClick={() => run(api.window.toggleMaximize())}><Icon name="maximize" size="sm" /></button>
          <button type="button" className="wc-btn wc-close" aria-label="Cerrar" title="Cerrar" onClick={() => run(api.window.close())}><Icon name="x" size="sm" /></button>
        </div>
      </div>
      {EDGES.map((edge) => (
        <div key={edge} className="win-edge" data-edge={edge} aria-hidden="true" onMouseDown={(e) => { if (e.button === 0) run(api.window.startResize(edge)) }} />
      ))}
    </>
  )
}
