// Sección «Volúmenes» del formulario de creación: filas de origen/destino, avisos de montajes sensibles y de rutas en conexión remota.
import { safeText } from '@/lib/safeText'
import { Icon } from '@/components/shared/Icon'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { VolRow } from '@/lib/createForm'
import type { BindWarning } from '@/lib/sensitiveBind'

export interface VolumesSectionProps {
  vols: VolRow[]
  /** Nombre de la conexión activa (solo se muestra con una conexión remota). */
  connName: string
  remoteBind: boolean
  /** Volúmenes con ruta relativa en una conexión remota. */
  relRemote: VolRow[]
  /** Montajes con aviso de sensibilidad. */
  binds: { v: VolRow; w: BindWarning }[]
  /** Mensaje de error de un campo (clave `vols.<id>.<campo>`), si lo hay. */
  fieldError: (k: string) => string | undefined
  onPatch: (id: string, patch: Partial<VolRow>) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onTouch: (k: string) => void
}

export function VolumesSection({ vols, connName, remoteBind, relRemote, binds, fieldError, onPatch, onRemove, onAdd, onTouch }: VolumesSectionProps) {
  return (
    <section className="card form-section">
      <h2>Volúmenes</h2>
      <div className="form-body">
        {remoteBind && !relRemote.length ? <AlertBox kind="warn" icon="server" title="Los montajes se resuelven en el servidor remoto" text={`Con «${safeText(connName, { singleLine: true })}» activa, las rutas de origen (bind) apuntan al disco del servidor, no al de tu equipo. Comprueba que existan allí o usa un volumen con nombre.`} /> : null}
        {relRemote.length ? <AlertBox kind="warn" icon="warn" title="Ruta relativa en una conexión remota" text={`Con «${safeText(connName, { singleLine: true })}» activa, «${safeText(relRemote[0].source, { singleLine: true })}» se resuelve en el servidor, no en tu equipo. Usa una ruta absoluta del servidor o un volumen con nombre.`} /> : null}
        {binds.length ? (
          <AlertBox kind="warn" icon="warn" title="Montaje sensible" text={<>{binds.map(({ v, w }) => <span key={v.id} className="block">{safeText(w.text, { singleLine: true })}</span>)}</>} />
        ) : null}
        {vols.map((v, i) => (
          <div className="rep vol-row" key={v.id}>
            <div><label className="sr-only" htmlFor={`vH${i}`}>Origen (volumen o ruta) {i + 1}</label><Input className="mono" id={`vH${i}`} value={v.source} placeholder="datos-pg o /srv/datos" aria-invalid={!!fieldError(`vols.${v.id}.source`)} aria-describedby={fieldError(`vols.${v.id}.source`) ? `eVH${i}` : undefined} onBlur={() => onTouch(`vols.${v.id}.source`)} onChange={(e) => onPatch(v.id, { source: e.target.value })} /></div>
            <div><label className="sr-only" htmlFor={`vC${i}`}>Ruta en el contenedor {i + 1}</label><Input className="mono" id={`vC${i}`} value={v.target} placeholder="/var/lib/postgresql/data" aria-invalid={!!fieldError(`vols.${v.id}.target`)} aria-describedby={fieldError(`vols.${v.id}.target`) ? `eVC${i}` : undefined} onBlur={() => onTouch(`vols.${v.id}.target`)} onChange={(e) => onPatch(v.id, { target: e.target.value })} /></div>
            <label className="ro-check"><input type="checkbox" checked={v.readOnly} onChange={(e) => onPatch(v.id, { readOnly: e.target.checked })} /> Solo lectura<span className="sr-only"> (volumen {i + 1})</span></label>
            <Button type="button" variant="ghost" size="icon" aria-label={`Quitar volumen ${i + 1}`} onClick={() => onRemove(v.id)}><Icon name="x" /></Button>
            {fieldError(`vols.${v.id}.source`) ? <span className="f-error col-[1/-1]" id={`eVH${i}`} ><Icon name="alert" size="sm" />{fieldError(`vols.${v.id}.source`)}</span> : null}
            {fieldError(`vols.${v.id}.target`) ? <span className="f-error col-[1/-1]" id={`eVC${i}`} ><Icon name="alert" size="sm" />{fieldError(`vols.${v.id}.target`)}</span> : null}
          </div>
        ))}
        <div><Button type="button" variant="secondary" size="sm" onClick={onAdd}><Icon name="plus" size="sm" />Añadir volumen</Button></div>
      </div>
    </section>
  )
}
