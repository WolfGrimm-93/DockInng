// Texto de la confirmación de la limpieza guiada (`{type:'cleanup'}`). Vive en el chunk de la página (no en el bundle principal):
// CleanupPage lo pasa como `describe` a `useGuardedAction`. Todo nombre viene de Docker: solo nodos de texto.
import { DialogList } from '@/components/shared/DialogList'
import { listOf, type PlanDescription } from '@/components/shared/planDescribe'
import type { ActionPlan, AffectedItem } from '@/data/types'
import { formatBytes } from '@/lib/format'
import { safeText } from '@/lib/safeText'

export function describeCleanup(plan: ActionPlan): PlanDescription {
  const n = plan.affected.length
  const skipped = plan.warnings.find((w) => w.type === 'skipped') as { type: 'skipped'; items: string[] } | undefined
  const total = plan.total_size_bytes != null ? formatBytes(plan.total_size_bytes) : null
  const by = (k: AffectedItem['kind']) => plan.affected.filter((a) => a.kind === k)
  const parts: [string, AffectedItem[]][] = [['contenedores', by('container')], ['imágenes', by('image')], ['volúmenes', by('volume')], ['redes', by('network')]]
  const vols = by('volume').length
  const resume = parts.filter(([, l]) => l.length).map(([label, l]) => `${l.length} ${label}`).join(', ')
  return {
    title: 'Limpiar recursos sin usar',
    description: (
      <>
        <p>Se eliminarán, uno a uno, <b>{resume}</b>{total ? ` (hasta ${total}; puede ser menos si comparten capas)` : ''}. Antes de borrar cada uno se vuelve a comprobar que siga sin usarse.</p>
        {skipped?.items.length ? <div className="dlg-warn" role="note"><span>Se omiten {skipped.items.length} elemento(s) que ya no existen o pasaron a estar en uso: {skipped.items.slice(0, 5).map((n) => safeText(n, { singleLine: true })).join(', ')}{skipped.items.length > 5 ? '…' : ''}.</span></div> : null}
        {parts.filter(([, l]) => l.length).map(([label, l]) => (
          <div key={label}><p className="mt-2">{label[0].toUpperCase() + label.slice(1)}:</p><DialogList label={`Lista de ${label} a eliminar`} items={listOf(l, label === 'volúmenes' ? 'database' : undefined)} /></div>
        ))}
      </>
    ),
    levelNote: vols ? <><b>Confirmación humana obligatoria.</b> Incluye {vols} volumen(es): sus datos no se pueden recuperar.</> : <><b>Nivel Confirmar.</b> Nunca se ejecuta <code>prune</code>: solo lo que ves en esta lista.</>,
    okLabel: `Eliminar ${n} elementos`,
    okIcon: 'trash',
    success: (o) => ({ msg: `${o.succeeded.length} elementos eliminados`, sub: o.freed_bytes ? `${formatBytes(o.freed_bytes)} liberados (aprox.)` : undefined }),
  }
}
