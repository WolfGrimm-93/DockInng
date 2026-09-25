// Pestaña «Inspeccionar». Datos REALES pero con un rótulo honesto: el JSON viene del MODELO TIPADO del motor,
// no es la salida literal de `docker inspect` y puede diferir. Coloreado por tokens (nodos <span>), nunca HTML.
import { safeText } from '@/lib/safeText'
import { useMemo } from 'react'
import { Icon } from '@/components/shared/Icon'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { ContainerDetail } from '@/data/types'
import { tokenizeJson } from '@/lib/json'
import { toast } from '@/lib/toastStore'

export function InspectTab({ name, detail, error }: { name: string; detail: ContainerDetail | null; error: string | null }) {
  const tokens = useMemo(() => (detail ? tokenizeJson(detail.raw) : []), [detail])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(detail?.raw ?? null, null, 2))
      toast.ok('Copiado al portapapeles')
    } catch {
      toast.warn('No se pudo copiar', { sub: 'El navegador no permitió el acceso al portapapeles.' })
    }
  }
  if (error) return <AlertBox kind="error" icon="alert" title="No se pudo inspeccionar el contenedor" text={error} />
  return (
    <>
      <div className="toolbar">
        <span className="muted">
          JSON del modelo tipado del motor de <b>{safeText(name, { singleLine: true })}</b>. Puede diferir de la salida de <code>docker inspect</code>.
        </span>
        <Button variant="secondary" size="sm" style={{ marginLeft: 'auto' }} disabled={!detail} onClick={() => void copy()}><Icon name="copy" size="sm" />Copiar JSON</Button>
      </div>
      {detail ? (
        <div className="json" tabIndex={0} role="region" aria-label={`JSON de inspección de ${safeText(name, { singleLine: true })}`}>
          {tokens.map((t, i) => (t.kind === 'p' ? t.text : <span key={i} className={t.kind}>{safeText(t.text)}</span>))}
        </div>
      ) : (
        <div className="json" aria-busy="true" role="status" aria-label="Cargando inspección"><Skeleton style={{ width: 240 }} /></div>
      )}
    </>
  )
}
