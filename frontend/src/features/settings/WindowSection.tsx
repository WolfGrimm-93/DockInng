// Ajustes > Ventana: bandeja del sistema, cerrar a la bandeja (apagado por defecto), iniciar minimizada y ventana sin marco.
// Si la bandeja no está disponible, «Cerrar a la bandeja» queda desactivado con el motivo a la vista (si no, la app quedaría invisible e inalcanzable).
import { Icon } from '@/components/shared/Icon'
import { AlertBox } from '@/components/shared/StateViews'
import { Switch } from '@/components/ui/checkbox'
import { useEngineApi } from '@/data/store/hooks'
import { useShellPrefs } from '@/data/shellPrefs'

export function WindowSection() {
  const api = useEngineApi()
  const { trayEnabled, closeToTray, startMinimized, decorations, tray } = useShellPrefs()
  const setPref = useShellPrefs((s) => s.setPref)
  const setDecorations = useShellPrefs((s) => s.setDecorations)
  const trayOk = tray?.available === true && trayEnabled
  return (
    <>
      <section aria-labelledby="sTray">
        <h2 className="section-title" id="sTray">Bandeja del sistema</h2>
        {tray && !tray.available ? (
          <AlertBox
            kind="warn"
            icon="warn"
            title="La bandeja del sistema no está disponible"
            text={<>La aplicación funciona sin ella y «Cerrar a la bandeja» se ignora. Instala <code>libayatana-appindicator</code> (o <code>libappindicator</code>) y, en GNOME, la extensión AppIndicator.{tray.error ? <> Detalle: <span className="mono">{tray.error}</span></> : null}</>}
          />
        ) : null}
        <div className="card">
          <div className="setting-row">
            <div className="grow"><b>Mostrar el icono en la bandeja</b><small>Menú con «Mostrar/Ocultar», los contenedores en marcha y «Salir».</small></div>
            <Switch aria-label="Mostrar el icono en la bandeja" checked={trayEnabled} onChange={(e) => void setPref(api, 'tray_enabled', e.target.checked)} />
          </div>
          <div className={`setting-row${trayOk ? '' : ' is-disabled'}`}>
            <div className="grow">
              <b>Cerrar a la bandeja</b>
              <small>Al cerrar la ventana, la app sigue en la bandeja (para «Salir», usa su menú). Apagado por defecto.</small>
              {!trayOk ? <small role="note"><Icon name="info" size="sm" /> {tray && !tray.available ? 'Necesita una bandeja del sistema disponible.' : 'Activa antes el icono en la bandeja.'}</small> : null}
            </div>
            <Switch aria-label="Cerrar a la bandeja" checked={closeToTray} disabled={!trayOk} onChange={(e) => void setPref(api, 'close_to_tray', e.target.checked)} />
          </div>
          <div className="setting-row">
            <div className="grow"><b>Iniciar minimizada</b><small>Arranca sin mostrar la ventana. Sin bandeja disponible se muestra igualmente para no dejarla inalcanzable.</small></div>
            <Switch aria-label="Iniciar minimizada" checked={startMinimized} onChange={(e) => void setPref(api, 'start_minimized', e.target.checked)} />
          </div>
        </div>
      </section>

      <section aria-labelledby="sFrame">
        <h2 className="section-title" id="sFrame">Ventana</h2>
        <div className="card">
          <div className="setting-row">
            <div className="grow">
              <b>Ventana sin marco</b>
              <small>Quita la barra de título del sistema y dibuja la de DockInng (mover, minimizar, maximizar, cerrar y redimensionar). Se aplica al instante. En Wayland puede perder sombra y bordes de redimensionado.</small>
            </div>
            <Switch aria-label="Ventana sin marco" checked={!decorations} onChange={(e) => void setDecorations(api, !e.target.checked)} />
          </div>
        </div>
      </section>
    </>
  )
}
