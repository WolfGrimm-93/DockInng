// Pestaña «Grupos» de Configuración: gestiona los grupos propios (nombre, color, borrar) y el color de cada stack de Compose.
// Los grupos se guardan solo en esta app (no en Docker). Asignar contenedores se hace desde la tabla: menú de cada fila o barra masiva.
import { useMemo, useState } from 'react'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/data/errors'
import { useContainers, useConnection, useEngineApi } from '@/data/store/hooks'
import { containerName } from '@/data/store/engineStore'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'
import { assignGroupHues } from '../common/groupColor'
import { HuePicker } from './HuePicker'
import { hueStyle } from './hueStyle'
import { MAX_GROUP_NAME, orphanNames, useGroupsStore, validateGroupName, type CustomGroup } from './groupsStore'
import { NewGroupDialog } from './NewGroupDialog'

function GroupRow({ g, count }: { g: CustomGroup; count: number }) {
  const groups = useGroupsStore((s) => s.groups)
  const rename = useGroupsStore((s) => s.renameGroup)
  const setHue = useGroupsStore((s) => s.setGroupHue)
  const del = useGroupsStore((s) => s.deleteGroup)
  const [name, setName] = useState(g.name)
  const [confirmDel, setConfirmDel] = useState(false)
  const err = name === g.name ? null : validateGroupName(name, groups, g.id)
  const commit = () => { if (name === g.name) return; if (!err && rename(g.id, name)) return; setName(g.name) }

  return (
    <div className="setting-row group-row-cfg" role="group" aria-label={`Grupo ${safeText(g.name, { singleLine: true })}`}>
      <span className="grp-swatch grp-swatch-lg" style={hueStyle(g.hue)} aria-hidden="true" />
      <div className="grow" style={{ minWidth: 0, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="sr-only" htmlFor={`gn-${g.id}`}>Nombre del grupo</label>
          <input
            id={`gn-${g.id}`}
            className="input"
            style={{ maxWidth: 260 }}
            value={name}
            maxLength={MAX_GROUP_NAME + 10}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `ge-${g.id}` : undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } else if (e.key === 'Escape') setName(g.name) }}
          />
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{count === 0 ? 'Sin contenedores' : `${count} contenedor${count > 1 ? 'es' : ''}`}</span>
        </div>
        {err ? <small id={`ge-${g.id}`} role="status" className="field-error">{err}</small> : null}
        <HuePicker value={g.hue} onChange={(h) => setHue(g.id, h)} label={`Color del grupo ${safeText(g.name, { singleLine: true })}`} />
      </div>
      {confirmDel ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} role="group" aria-label="Confirmar eliminación del grupo">
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>Los contenedores no se tocan.</span>
          <Button variant="destructive" size="sm" onClick={() => del(g.id)}>Eliminar grupo</Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirmDel(false)}>Cancelar</Button>
        </div>
      ) : (
        <Button variant="outline-destructive" size="sm" aria-label={`Eliminar el grupo ${safeText(g.name, { singleLine: true })}`} onClick={() => setConfirmDel(true)}><Icon name="trash" size="sm" />Eliminar</Button>
      )}
    </div>
  )
}

export function GroupsManager() {
  const { list, status } = useContainers()
  const profileId = useConnection().profile.id
  const groups = useGroupsStore((s) => s.groups)
  const assign = useGroupsStore((s) => s.assign)
  const stackHue = useGroupsStore((s) => s.stackHue)
  const setStackHue = useGroupsStore((s) => s.setStackHue)
  const pruneOrphans = useGroupsStore((s) => s.pruneOrphans)
  const api = useEngineApi()
  const [exportando, setExportando] = useState(false)
  const [importando, setImportando] = useState(false)
  const reloadFromBackend = useGroupsStore((s) => s.reloadFromBackend)
  const importar = async () => {
    setImportando(true)
    try {
      const r = await api.groups.importFile()
      if (!r) return
      await reloadFromBackend()
      toast.ok('Grupos importados', { sub: `${r.groups_created} nuevos, ${r.groups_reused} ya existían, ${r.assignments_imported} asignaciones (${r.assignments_skipped} descartadas)` })
    } catch (ex) {
      const m = apiErrorMessage(ex)
      toast.err('No se pudieron importar los grupos', { sub: m.detail || m.title })
    } finally {
      setImportando(false)
    }
  }
  const [creating, setCreating] = useState(false)
  const exportar = async () => {
    setExportando(true)
    try {
      const ruta = await api.groups.exportGroups()
      if (ruta) toast.ok('Grupos exportados', { sub: ruta })
    } catch (ex) {
      const m = apiErrorMessage(ex)
      toast.err('No se pudieron exportar los grupos', { sub: m.detail || m.title })
    } finally {
      setExportando(false)
    }
  }
  const liveNames = useMemo(() => list.map((c) => containerName(c)), [list])
  // Solo se calcula con el listado completo: con una lista incompleta se quitarían asignaciones válidas.
  const listo = status === 'ready'
  const huerfanas = useMemo(() => (listo ? orphanNames(assign, profileId, liveNames).length : 0), [assign, profileId, liveNames, listo])

  const counts = useMemo(() => {
    const names = new Set(list.map((c) => containerName(c)))
    const m = new Map<string, number>()
    for (const [k, gid] of Object.entries(assign)) {
      const [pid, name] = k.split('\u0000')
      if (pid === profileId && names.has(name)) m.set(gid, (m.get(gid) ?? 0) + 1)
    }
    return m
  }, [assign, list, profileId])

  const stacks = useMemo(() => [...new Set(list.flatMap((c) => (c.compose_project != null ? [c.compose_project] : [])))].sort((a, b) => a.localeCompare(b)), [list])
  const autoHue = useMemo(() => assignGroupHues(stacks), [stacks])

  return (
    <>
      <section aria-labelledby="gCustom">
        <h2 className="section-title" id="gCustom">Grupos propios</h2>
        <div className="card">
          {groups.length === 0 ? (
            <div className="setting-row">
              <div className="grow">
                <b>Todavía no tienes grupos</b>
                <small>Crea uno y muévele contenedores desde la tabla: menú de cada fila («Mover a un grupo») o, con varios seleccionados, desde la barra de acciones. Un contenedor en un grupo propio deja de mostrarse en su stack.</small>
              </div>
            </div>
          ) : groups.map((g) => <GroupRow key={g.id} g={g} count={counts.get(g.id) ?? 0} />)}
          <div className="setting-row">
            <div className="grow"><small>Los grupos se guardan solo en esta app y por conexión; no cambian nada en Docker.</small></div>
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}><Icon name="folder-plus" size="sm" />Nuevo grupo</Button>
          </div>
          <div className="setting-row">
            <div className="grow"><b>Exportar e importar grupos</b><small>Guarda grupos, asignaciones y colores en un archivo JSON (sin secretos). Al importar se fusiona: los grupos con el mismo nombre se reutilizan.</small></div>
            <Button variant="secondary" size="sm" disabled={exportando || importando} onClick={() => void exportar()}><Icon name="download" size="sm" />Exportar…</Button>
            <Button variant="secondary" size="sm" disabled={exportando || importando} onClick={() => void importar()}><Icon name="folder" size="sm" />Importar…</Button>
          </div>
          <div className="setting-row">
            <div className="grow">
              <b>Asignaciones huérfanas</b>
              <small>{!listo ? 'Espera a que se carguen los contenedores de esta conexión.' : huerfanas === 0 ? 'No hay asignaciones de contenedores que ya no existan.' : `${huerfanas} asignación(es) de contenedores que ya no existen en esta conexión.`}</small>
            </div>
            <Button variant="secondary" size="sm" disabled={!listo || huerfanas === 0} onClick={() => { const n = pruneOrphans(profileId, liveNames); toast.ok(`Se quitaron ${n} asignaciones huérfanas`) }}>Limpiar huérfanas</Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="gStacks">
        <h2 className="section-title" id="gStacks">Color de los stacks</h2>
        <div className="card">
          {stacks.length === 0 ? (
            <div className="setting-row"><div className="grow"><small>No hay stacks de Compose en esta conexión.</small></div></div>
          ) : stacks.map((p) => {
            const custom = stackHue[p]
            const hue = custom ?? autoHue.get(p) ?? 175
            return (
              <div className="setting-row group-row-cfg" key={p} role="group" aria-label={`Stack ${safeText(p, { singleLine: true })}`}>
                <span className="grp-swatch grp-swatch-lg" style={hueStyle(hue)} aria-hidden="true" />
                <div className="grow" style={{ minWidth: 0, display: 'grid', gap: 6 }}>
                  <b>{safeText(p, { singleLine: true })} <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--text-xs)' }}>{custom === undefined ? '· color automático' : '· color elegido'}</span></b>
                  <HuePicker value={hue} onChange={(h) => setStackHue(p, h)} label={`Color del stack ${safeText(p, { singleLine: true })}`} />
                </div>
                {custom === undefined ? null : <Button variant="secondary" size="sm" onClick={() => setStackHue(p, null)}>Color automático</Button>}
              </div>
            )
          })}
        </div>
      </section>

      <NewGroupDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
