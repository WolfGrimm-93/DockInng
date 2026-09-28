// Ajustes > Notificaciones: avisos nativos del sistema (apagados por defecto), qué eventos avisan y el estado de la bandeja.
// Los avisos los envía el backend (`notify_user`); aquí solo se eligen las preferencias. Con la bandeja no disponible se avisa (y sigue funcionando).
import { Icon } from '@/components/shared/Icon'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/checkbox'
import { useEngineApi } from '@/data/store/hooks'
import { NOTIFY_EVENT_KEYS, useShellPrefs } from '@/data/shellPrefs'
import type { NotifyKind } from '@/data/types'
import { toast } from '@/lib/toastStore'

const EVENTS: Record<(typeof NOTIFY_EVENT_KEYS)[number], { title: string; text: string }> = {
  die: { title: 'Un contenedor se detiene con error', text: 'Solo si termina con un código distinto de 0 y no lo detuviste tú desde la app.' },
  oom: { title: 'Un contenedor se queda sin memoria', text: 'El motor lo detuvo por superar su límite de memoria.' },
  unhealthy: { title: 'Un contenedor deja de estar sano', text: 'Una vez por cambio de estado, cuando su comprobación de salud falla.' },
  op_done: { title: 'Termina una descarga o una operación de stack', text: 'Solo si la ventana no está a la vista (sin foco u oculta en la bandeja).' },
}

export function NotificationsSection() {
  const api = useEngineApi()
  const { notifyEnabled, notifyEvents, tray } = useShellPrefs()
  const setPref = useShellPrefs((s) => s.setPref)
  const test = () => {
    void api.window.notifyUser({ kind: 'die' satisfies NotifyKind, title: 'Aviso de prueba', body: 'Así se verán las notificaciones de DockInng.' })
      .then(() => toast.ok('Aviso de prueba enviado'), () => toast.warn('No se pudo enviar el aviso de prueba'))
  }
  return (
    <>
      <section aria-labelledby="sNotif">
        <h2 className="section-title" id="sNotif">Notificaciones</h2>
        <div className="card">
          <div className="setting-row">
            <div className="grow"><b>Avisos del sistema</b><small>Notificaciones nativas del escritorio. Nunca incluyen variables de entorno ni registros. Apagado por defecto.</small></div>
            <Switch aria-label="Avisos del sistema" checked={notifyEnabled} onChange={(e) => void setPref(api, 'notify_enabled', e.target.checked)} />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>Las reglas de anti-ruido agrupan los avisos: como máximo uno por contenedor cada 30 s.</p>
      </section>

      <section aria-labelledby="sNotifEv">
        <h2 className="section-title" id="sNotifEv">Qué avisa</h2>
        <div className={`card${notifyEnabled ? '' : ' is-disabled'}`}>
          {NOTIFY_EVENT_KEYS.map((k) => (
            <div className={`setting-row${notifyEnabled ? '' : ' is-disabled'}`} key={k}>
              <div className="grow"><b>{EVENTS[k].title}</b><small>{EVENTS[k].text}</small></div>
              <Switch
                aria-label={EVENTS[k].title}
                checked={notifyEvents[k]}
                disabled={!notifyEnabled}
                onChange={(e) => void setPref(api, 'notify_events', { ...notifyEvents, [k]: e.target.checked })}
              />
            </div>
          ))}
        </div>
        {!notifyEnabled ? <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>Activa «Avisos del sistema» para elegir qué eventos avisan.</p> : null}
        <div style={{ marginTop: 10 }}>
          <Button variant="secondary" size="sm" disabled={!notifyEnabled} onClick={test}><Icon name="bell" size="sm" />Enviar aviso de prueba</Button>
        </div>
      </section>

      {tray && !tray.available ? (
        <AlertBox
          kind="warn"
          icon="warn"
          title="La bandeja del sistema no está disponible"
          text="Los avisos siguen funcionando, pero «Cerrar a la bandeja» se ignora hasta que haya una bandeja. En KDE y GNOME hace falta libayatana-appindicator (o libappindicator) y, en GNOME, la extensión AppIndicator."
        />
      ) : null}
    </>
  )
}
