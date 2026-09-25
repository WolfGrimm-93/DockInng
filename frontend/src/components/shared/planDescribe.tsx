// Textos de confirmación por defecto a partir del ActionPlan del backend (paridad con askDelete* de la plantilla).
// Contrato: describePlan(plan, request, ctx?) -> PlanDescription { title, description, extra?, levelNote?, okLabel, okIcon?, success?(outcome) }
//   Todo el contenido son nodos React con TEXTO (los nombres vienen de Docker: no confiables; nunca HTML).
import type { ReactNode } from 'react'
import type { ActionOutcome, ActionPlan, ActionRequest, AffectedItem, PlanWarning } from '@/data/types'
import { formatBytes, stateLabelEs } from '@/lib/format'
import { safeText } from '@/lib/safeText'
import { DialogList, type DialogListItem } from './DialogList'
import { Icon } from './Icon'
import { SafeName } from './SafeName'
import type { IconName } from './iconNames'

export interface PlanDescription {
  title: string
  description: ReactNode
  extra?: ReactNode
  levelNote?: ReactNode
  okLabel: string
  okIcon?: IconName
  success?(outcome: ActionOutcome): { msg: string; sub?: string }
}

function warnOf<T extends PlanWarning['type']>(ws: PlanWarning[], t: T): Extract<PlanWarning, { type: T }> | undefined {
  return ws.find((w) => w.type === t) as Extract<PlanWarning, { type: T }> | undefined
}

function listOf(items: AffectedItem[], icon?: IconName): DialogListItem[] {
  // key estable id+nombre+índice: prune_images produce una fila por etiqueta con el MISMO id de imagen.
  return items.map((i, n) => ({
    key: `${i.id}|${i.name}|${n}`,
    icon,
    text: i.name,
    end: i.kind === 'container' && i.state ? stateLabelEs(i.state) : i.size_bytes != null ? formatBytes(i.size_bytes) : undefined,
  }))
}

export function describePlan(plan: ActionPlan, request: ActionRequest, ctx: { volumeSize?(name: string): string | undefined } = {}): PlanDescription {
  const n = plan.affected.length
  const total = plan.total_size_bytes != null ? formatBytes(plan.total_size_bytes) : null
  switch (request.type) {
    case 'remove_containers': {
      const single = n === 1
      const running = warnOf(plan.warnings, 'running_force')
      const vols = warnOf(plan.warnings, 'volumes_kept')?.items ?? []
      const binds = warnOf(plan.warnings, 'bind_mounts_kept')?.items ?? []
      return {
        title: single ? 'Eliminar contenedor' : `Eliminar ${n} contenedores`,
        description: single ? (
          <p>Se eliminará <b><SafeName mono>{plan.affected[0].name}</SafeName></b>.</p>
        ) : (
          <>
            <p>Se eliminarán <b>{n} contenedores</b>:</p>
            <DialogList label="Contenedores a eliminar" items={listOf(plan.affected)} />
          </>
        ),
        extra: (
          <>
            {running ? (
              <div className="dlg-warn" role="note">
                <Icon name="warn" size="sm" />
                <span>{single ? 'Está en ejecución.' : `${running.count} están en ejecución.`} Se eliminará con <code>--force</code>: el proceso recibe SIGKILL, sin apagado ordenado.</span>
              </div>
            ) : null}
            {vols.length ? (
              <>
                <p style={{ marginTop: 10 }}>Volúmenes montados (<b>no se eliminan</b>, quedarán sin usar):</p>
                <DialogList label="Volúmenes montados" items={vols.map((v) => ({ key: v, icon: 'database', text: v, end: ctx.volumeSize?.(v) }))} />
              </>
            ) : (
              <p style={{ marginTop: 10 }}>No tiene volúmenes con nombre.{single && binds.length ? ` Los bind mounts (${binds.join(', ')}) tampoco se tocan.` : ''}</p>
            )}
          </>
        ),
        levelNote: <><b>Nivel Confirmar.</b> No se puede deshacer. Los volúmenes y las imágenes no se tocan (no se envía <code>v=true</code>).</>,
        okLabel: single ? 'Eliminar contenedor' : `Eliminar ${n}`,
        success: (o) => ({ msg: o.succeeded.length === 1 ? `${safeText(plan.affected[0]?.name) || 'Contenedor'} eliminado` : `${o.succeeded.length} contenedores eliminados`, sub: vols.length ? `${vols.length} volumen(es) quedan sin usar` : undefined }),
      }
    }
    case 'remove_image':
      return {
        title: 'Eliminar imagen',
        description: <p>Se eliminará <b><SafeName mono>{plan.affected[0]?.name}</SafeName></b>{total ? ` (${total})` : ''}. Podrás volver a descargarla.</p>,
        okLabel: 'Eliminar imagen',
        success: () => ({ msg: 'Imagen eliminada', sub: total ? `${total} liberados` : undefined }),
      }
    case 'prune_images':
      return {
        title: 'Eliminar imágenes sin usar',
        description: (
          <>
            <p>Se eliminarán <b>{n} imágenes</b> que ningún contenedor usa{total ? ` (${total})` : ''}. No afecta a contenedores.</p>
            <DialogList label="Imágenes a eliminar" items={listOf(plan.affected)} />
          </>
        ),
        okLabel: `Eliminar ${n} imágenes`,
        success: (o) => ({ msg: `${o.succeeded.length} imágenes eliminadas`, sub: o.freed_bytes ? `${formatBytes(o.freed_bytes)} liberados` : undefined }),
      }
    case 'remove_volume':
      return {
        title: 'Eliminar volumen',
        description: (
          <>
            <p>Se borrarán <b>para siempre</b> los datos de <b><SafeName mono>{plan.affected[0]?.name}</SafeName></b>.</p>
            <DialogList label="Volumen a eliminar" items={listOf(plan.affected, 'database')} />
          </>
        ),
        levelNote: <><b>Nivel Confirmar con nombre.</b> Los datos de un volumen no se pueden recuperar.</>,
        okLabel: 'Eliminar volumen',
        success: (o) => ({ msg: 'Volumen eliminado', sub: o.freed_bytes ? `${formatBytes(o.freed_bytes)} liberados` : undefined }),
      }
    case 'prune_volumes':
      return {
        title: 'Eliminar volúmenes sin usar',
        description: (
          <>
            <p>Se borrarán <b>{n} volúmenes</b> que ningún contenedor usa, con sus datos{total ? ` (${total} en total)` : ''}.</p>
            <DialogList label="Volúmenes afectados" items={listOf(plan.affected, 'database')} />
          </>
        ),
        levelNote: <><b>Confirmación humana obligatoria.</b> La política la exige aunque la acción se lance con la opción de omitir confirmaciones.</>,
        okLabel: `Eliminar ${n} volúmenes`,
        success: (o) => ({ msg: `${o.succeeded.length} volúmenes eliminados`, sub: o.freed_bytes ? `${formatBytes(o.freed_bytes)} liberados` : undefined }),
      }
    case 'remove_network':
      return {
        title: 'Eliminar red',
        description: <p>Se eliminará la red <b><SafeName mono>{plan.affected[0]?.name}</SafeName></b>. No tiene contenedores conectados.</p>,
        okLabel: 'Eliminar red',
        success: () => ({ msg: 'Red eliminada' }),
      }
    case 'stack_down':
      return {
        title: `Bajar stack ${safeText(request.project, { singleLine: true })}`,
        description: (
          <>
            <p>Se detendrán y eliminarán los <b>{n} contenedores</b> del stack y su red. Los volúmenes se conservan.</p>
            <DialogList label="Contenedores afectados" items={listOf(plan.affected)} />
          </>
        ),
        levelNote: <><b>Nivel Confirmar con nombre.</b> Equivale a <code>docker compose down</code>.</>,
        okLabel: 'Bajar stack',
        success: (o) => ({ msg: `Stack ${safeText(request.project, { singleLine: true })} bajado`, sub: `${o.succeeded.length} contenedores eliminados` }),
      }
    default:
      return { title: 'Confirmar acción', description: <p>Se aplicará a {n} elemento(s).</p>, okLabel: 'Confirmar' }
  }
}
