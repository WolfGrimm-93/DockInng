// Vista «Contenedores»: tabla virtualizada (filas de altura fija) con búsqueda, filtro por estado, agrupación por stack,
// selección múltiple + barra masiva, acciones por fila con estado en curso/error y eliminación por el flujo de política.
// Datos REALES (Docker vía la capa de datos): lista, iniciar/detener/reiniciar, eventos en vivo, CPU/memoria.
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { devFlagsEnabled, getDevFlags, usePreviewState } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { describePlan } from '@/components/shared/planDescribe'
import { formatBytes, formatBytesPrecise, formatBytesSI } from '@/lib/format'
import { BulkBar } from '@/components/shared/BulkBar'
import { useGuardedAction } from '@/components/shared/useGuardedAction'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { SearchField } from '@/components/shared/SearchField'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox, EmptyState, SkeletonTable } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { apiErrorMessage } from '@/data/errors'
import { containerName } from '@/data/store/engineStore'
import { useAllStats, useConnection, useContainers, useEngineApi, useEngineStoreApi, useNetworks, useStatsConsumer, useSystemUsage, useVolumes } from '@/data/store/hooks'
import type { Container, Volume } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'
import { isOn, isStoppedState, matchesContainer, type StateFilter } from '../common/containerUtils'
import { assignGroupHues } from '../common/groupColor'
import { ownNetworkNames } from '../common/netinfo'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { readRowHeight, useVirtualTable } from '../common/useVirtualTable'
import { ContainerRow } from './ContainerRow'
import { NameResizer } from './NameResizer'
import { useNameColumnWidth } from './useNameColumnWidth'
import { AssignGroupMenu } from '../groups/AssignGroupMenu'
import { DragTray } from '../groups/DragTray'
import { assignKey, useGroupsStore } from '../groups/groupsStore'
import { useRowDrag } from '../groups/useRowDrag'
import { ContainerInfoDialog, type InfoTarget } from './ContainerInfoDialog'
import { GroupNetworksDialog } from './GroupNetworksDialog'
import { ResourceStrip } from './ResourceStrip'
import { groupDiskBytes, sumConsumption } from './usage'

const COLS = 8
// Cabecera de grupo = un stack de Compose (automático) o un grupo propio del usuario (`g:<id>` / `s:<proyecto>`), con las redes propias
// que usan sus contenedores. Un contenedor en un grupo propio deja de mostrarse en su stack. Los que no están en ninguno van fuera de
// los grupos, sin cabecera (como Docker Desktop).
type Item =
  | { type: 'group'; key: string; kind: 'stack' | 'custom'; label: string; count: number; running: number; nets: string[]; hue: number }
  | { type: 'row'; c: Container; hue?: number }

/** Chips de consumo de una cabecera de grupo. Memoizado: solo se repinta si cambian sus miembros/volúmenes o las muestras/el disco. */
const GroupUsage = memo(function GroupUsage({ members, volumes }: { members: Container[] | undefined; volumes: Volume[] }) {
  const stats = useAllStats()
  const system = useSystemUsage()
  const u = useMemo(() => (members ? { sum: sumConsumption(members, stats), disk: groupDiskBytes(members, volumes, system?.container_disk ?? [], !!system?.disk_known) } : null), [members, stats, volumes, system])
  if (!u) return null
  return (
    <span className="group-usage">
      {u.sum.sampled > 0 ? <span className="usage-chip mono" title="CPU de los contenedores en marcha de este stack (100 % = 1 núcleo)">CPU {u.sum.cpu.toFixed(1)} %</span> : null}
      {u.sum.sampled > 0 ? <span className="usage-chip usage-ram mono" title="Memoria de los contenedores en marcha de este grupo">RAM {formatBytesPrecise(u.sum.memBytes)}</span> : null}
      {u.disk != null ? <span className="usage-chip usage-disk mono" title="Disco aproximado: capas de escritura + volúmenes de sus contenedores (no incluye las imágenes)">Disco ≈ {formatBytesSI(u.disk)}</span> : null}
    </span>
  )
})

export default function ContainersPage() {
  const { list, status, counts, error } = useContainers()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const route = useHashRoute()
  const guard = useGuardedAction()
  const gate = useViewGate(COLS, 8)
  const { list: volumes } = useVolumes()
  const { list: networks } = useNetworks()
  useStatsConsumer()
  const profileId = useConnection().profile.id
  const customGroups = useGroupsStore((s) => s.groups)
  const assigned = useGroupsStore((s) => s.assign)
  const stackHueOverride = useGroupsStore((s) => s.stackHue)
  // Tamaño de los volúmenes montados en el diálogo de eliminar: solo si el motor lo conoce (nunca se inventa).
  const volumeSize = useCallback((n: string) => { const v = volumes.find((x) => x.name === n); return v?.size_bytes != null ? formatBytes(v.size_bytes) : undefined }, [volumes])
  const preview = usePreviewState()
  const [filter, setFilter] = useState<StateFilter>('all')
  const [q, setQ] = useState('')
  // Agrupado por stack por defecto (como Docker Desktop); el botón lo desactiva.
  const [group, setGroup] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  // Modales de toda la tabla (uno de cada): puertos e IPs de un contenedor, y redes de un grupo (por su clave).
  const [infoOf, setInfoOf] = useState<InfoTarget | null>(null)
  const showInfo = useCallback((c: Container) => setInfoOf({ c, tab: 'ports' }), [])
  const [netsOfKey, setNetsOfKey] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState<{ op: 'start' | 'stop'; total: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const rowH = useMemo(() => readRowHeight(), [])
  const nameTh = useRef<HTMLTableCellElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const nameW = useNameColumnWidth(wrapRef)

  const loading = preview === 'loading' || status === 'idle' || status === 'loading'
  const empty = preview === 'empty' || (status === 'ready' && list.length === 0)

  const filtered = useMemo(() => list.filter((c) => matchesContainer(c, filter, q)), [list, filter, q])
  const stopped = useMemo(() => list.filter((c) => isStoppedState(c.state)).length, [list])
  // Red(es) propia(s) de cada contenedor (nombre del contenedor → redes), desde sus endpoints (la misma fuente que el modal de redes). Se omiten
  // las de sistema (bridge, host, none).
  const netsByContainer = useMemo(() => {
    const system = new Set(networks.filter((n) => n.system).map((n) => n.name))
    return new Map(list.map((c) => [containerName(c), ownNetworkNames(c, system)]))
  }, [list, networks])
  // A qué grupo pertenece un contenedor: su grupo propio (si lo tiene y existe), si no su stack de Compose, si no ninguno (suelto).
  const groupKeyOf = useCallback((c: Container): string | null => {
    const gid = assigned[assignKey(profileId, containerName(c))]
    if (gid !== undefined && customGroups.some((g) => g.id === gid)) return `g:${gid}`
    return c.compose_project != null ? `s:${c.compose_project}` : null
  }, [assigned, customGroups, profileId])
  // Color automático de cada stack: se calcula sobre TODOS los stacks (no solo los filtrados) para que un stack no cambie de color al filtrar.
  const stackAuto = useMemo(() => assignGroupHues(list.flatMap((c) => (c.compose_project != null ? [c.compose_project] : []))), [list])
  const metaOf = useCallback((key: string): { kind: 'stack' | 'custom'; label: string; hue: number } => {
    if (key.startsWith('g:')) {
      const g = customGroups.find((x) => x.id === key.slice(2))
      return { kind: 'custom', label: g?.name ?? '', hue: g?.hue ?? 175 }
    }
    const project = key.slice(2)
    return { kind: 'stack', label: project, hue: stackHueOverride[project] ?? stackAuto.get(project) ?? 175 }
  }, [customGroups, stackHueOverride, stackAuto])
  // Miembros de cada grupo (sobre TODOS sus contenedores, no solo los filtrados). El consumo (CPU/RAM/disco) lo calcula <GroupUsage/> con sus
  // propias suscripciones: así las muestras nuevas no repintan la página ni la tabla virtualizada.
  const groupMembers = useMemo(() => {
    const by = new Map<string, Container[]>()
    for (const c of list) { const k = groupKeyOf(c); if (k) by.set(k, [...(by.get(k) ?? []), c]) }
    return by
  }, [list, groupKeyOf])
  // Los que están en marcha primero (orden estable: dentro de cada mitad se conserva el orden del motor).
  const ordered = useMemo(() => [...filtered].sort((a, b) => Number(!isOn(a.state)) - Number(!isOn(b.state))), [filtered])
  const items = useMemo<Item[]>(() => {
    if (!group) return ordered.map((c) => ({ type: 'row', c }))
    const groups = new Map<string, Container[]>()
    const loose: Container[] = []
    for (const c of ordered) {
      const k = groupKeyOf(c)
      if (k === null) { loose.push(c); continue }
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(c)
    }
    // Grupos con algo en marcha primero; luego los propios antes que los stacks; después por nombre.
    const keys = [...groups.keys()].sort((a, b) => {
      const ra = groups.get(a)!.some((c) => isOn(c.state)) ? 0 : 1
      const rb = groups.get(b)!.some((c) => isOn(c.state)) ? 0 : 1
      const ma = metaOf(a)
      const mb = metaOf(b)
      return ra - rb || Number(ma.kind === 'stack') - Number(mb.kind === 'stack') || ma.label.localeCompare(mb.label)
    })
    const out: Item[] = []
    for (const key of keys) {
      const cs = groups.get(key)!
      const nets = [...new Set(cs.flatMap((c) => netsByContainer.get(containerName(c)) ?? []))]
      const m = metaOf(key)
      out.push({ type: 'group', key, kind: m.kind, label: m.label, count: cs.length, running: cs.filter((c) => isOn(c.state)).length, nets, hue: m.hue })
      if (!collapsed[key]) for (const c of cs) out.push({ type: 'row', c, hue: m.hue })
    }
    for (const c of loose) out.push({ type: 'row', c })
    return out
  }, [ordered, group, collapsed, netsByContainer, groupKeyOf, metaOf])

  const virt = useVirtualTable({ count: items.length, scrollRef, tableRef, estimate: (i) => (items[i]?.type === 'group' ? 32 : rowH) })

  // Selección efectiva = seleccionados Y visibles con el filtro/búsqueda actual: la barra y los diálogos cuentan exactamente lo que se va a actuar.
  const selIds = useMemo(() => filtered.filter((c) => selected.has(c.id)).map((c) => c.id), [filtered, selected])
  const allSel = filtered.length > 0 && filtered.every((c) => selected.has(c.id))
  const someSel = filtered.some((c) => selected.has(c.id))

  // Arrastrar a un grupo: si la fila arrastrada está seleccionada se mueve TODA la selección visible; si no, solo esa fila.
  const onGripPointerDown = useRowDrag({
    profileId,
    scrollRef,
    getDragged: (c) => (selected.has(c.id) ? filtered.filter((x) => selected.has(x.id)) : [c]),
  })

  const focusTitle = () => document.getElementById('viewTitle')?.focus({ preventScroll: true })
  const onSelect = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  }, [])
  const onOp = useCallback((c: Container, op: 'start' | 'stop' | 'restart') => void store.getState().runContainerOp(c.id, op), [store])
  const deleteContainers = useCallback(
    async (ids: string[]) => {
      const req = { type: 'remove_containers' as const, ids }
      const r = await guard(req, (plan) => describePlan(plan, req, { volumeSize }))
      if (r.status === 'done') {
        setSelected((prev) => {
          const n = new Set(prev)
          for (const id of ids) n.delete(id)
          return n
        })
        void store.getState().refresh('all')
        focusTitle()
      }
    },
    [guard, store, volumeSize],
  )
  const onDelete = useCallback((c: Container) => void deleteContainers([c.id]), [deleteContainers])

  const bulk = async (op: 'start' | 'stop') => {
    const targets = filtered.filter((c) => selected.has(c.id) && (op === 'start' ? !isOn(c.state) : isOn(c.state)))
    if (!targets.length) {
      toast.warn(op === 'start' ? 'Los contenedores seleccionados ya están en ejecución' : 'Los contenedores seleccionados ya están detenidos')
      setSelected(new Set())
      return
    }
    // Concurrencia limitada, un solo refresco y un solo toast resumen los pone el store.
    setBulkBusy({ op, total: targets.length })
    try {
      await store.getState().runContainerOps(targets.map((c) => c.id), op)
    } finally {
      setBulkBusy(null)
      setSelected(new Set())
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await store.getState().refresh('all')
      toast.ok('Lista actualizada')
    } finally {
      setRefreshing(false)
    }
  }

  // Parámetros de arranque de la plantilla (solo simulado/DEV): ?sel=N y ?dialog=delete|delete-running|delete-multi
  const ready = status === 'ready' && list.length > 0 && !preview && devFlagsEnabled(api)
  useStartupOnce('containers.sel', ready, () => {
    const n = Math.min(getDevFlags().sel, Math.max(0, list.length - 1))
    if (n > 0) setSelected(new Set(list.slice(1, n + 1).map((c) => c.id)))
  })
  useStartupOnce('containers.dialog', ready, () => {
    const d = getDevFlags().dialog
    const byName = (n: string) => list.find((c) => c.names.includes(n))
    if (d === 'delete') { const c = byName('tienda-redis-1'); if (c) void deleteContainers([c.id]) }
    else if (d === 'delete-running') { const c = byName('tienda-postgres-1'); if (c) void deleteContainers([c.id]) }
    else if (d === 'delete-multi') {
      const cs = ['tienda-redis-1', 'minio-dev', 'tienda-postgres-1'].map(byName).filter(Boolean) as Container[]
      if (cs.length) void deleteContainers(cs.map((c) => c.id))
    }
  })

  const head = (
    <PageHeader
      title="Contenedores"
      count={gate.isError ? null : `${counts.total} en total · ${counts.running} en ejecución`}
      secondary={
        <Button variant="secondary" locked={gate.locked} aria-busy={refreshing || undefined} onClick={() => void refresh()}>
          <Icon name="refresh" spin={refreshing} />Actualizar
        </Button>
      }
      primary={<LinkButton variant="primary" locked={gate.locked} href={route.href('create')}><Icon name="plus" />Nuevo contenedor</LinkButton>}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>

  const toolbar = selIds.length ? (
    <div className="toolbar">
      <BulkBar
        count={selIds.length}
        locked={gate.locked || !!bulkBusy}
        onStart={() => void bulk('start')}
        onStop={() => void bulk('stop')}
        onDelete={() => void deleteContainers(selIds)}
        onClear={() => setSelected(new Set())}
        extra={
          <AssignGroupMenu names={list.filter((c) => selIds.includes(c.id)).map((c) => containerName(c))} triggerClass="btn btn-secondary btn-sm" ariaLabel="Mover la selección a un grupo">
            <Icon name="folder" size="sm" />Mover a grupo…
          </AssignGroupMenu>
        }
      />
      {bulkBusy ? (
        <span className="muted" role="status" aria-live="polite" style={{ alignSelf: 'center' }}>
          <Icon name="loader" size="sm" spin /> {bulkBusy.op === 'start' ? 'Iniciando' : 'Deteniendo'} {bulkBusy.total} contenedores…
        </span>
      ) : null}
    </div>
  ) : (
    <div className="toolbar">
      <SearchField id="q" placeholder="Buscar por nombre, imagen o ID" value={q} onChange={setQ} />
      <Segmented<StateFilter>
        ariaLabel="Filtrar por estado"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Todos', count: counts.total },
          { value: 'running', label: 'En ejecución', count: counts.running },
          { value: 'stopped', label: 'Detenidos', count: stopped },
        ]}
      />
      <Button variant="secondary" aria-pressed={group} onClick={() => setGroup((g) => !g)}><Icon name="grid" />Agrupar por stack</Button>
    </div>
  )

  if (status === 'error' && !list.length && !preview) {
    const m = error ? apiErrorMessage(error) : { title: 'No se pudo cargar la lista', detail: '' }
    return (
      <>
        {head}
        <div className="view-body">
          <AlertBox kind="error" icon="alert" title="No se pudo cargar la lista de contenedores" text={`${m.title}. ${m.detail}`}
            actions={<Button variant="secondary" size="sm" onClick={() => void store.getState().refresh('containers')}><Icon name="refresh" size="sm" />Reintentar</Button>} />
        </div>
      </>
    )
  }
  if (loading && !empty) return <>{head}{toolbar}<div className="view-body"><SkeletonTable cols={COLS} rows={8} /></div></>
  if (empty) {
    return (
      <>
        {head}
        <div className="view-body">
          <EmptyState
            icon="box"
            title="Todavía no hay contenedores"
            text="Cuando crees o ejecutes un contenedor aparecerá aquí. Puedes empezar desde una imagen ya descargada o desde un archivo Compose."
            actions={<><LinkButton variant="primary" href={route.href('create')}><Icon name="plus" />Nuevo contenedor</LinkButton><LinkButton variant="secondary" href={route.href('stacks')}>Abrir un stack</LinkButton></>}
          />
        </div>
      </>
    )
  }

  const spacer = (h: number, k: string) => (
    <tr key={k} aria-hidden="true" style={{ background: 'transparent', pointerEvents: 'none' }}>
      <td colSpan={COLS + 1} style={{ height: h, padding: 0, border: 0 }} />
    </tr>
  )

  return (
    <>
      {head}
      <ResourceStrip />
      {toolbar}
      <div className="view-body" ref={scrollRef}>
        {gate.lostBanner}
        <div className={`table-wrap${nameW.width !== null ? ' name-fixed' : ''}`} style={nameW.width !== null ? ({ '--name-w': `${nameW.width}px` } as CSSProperties) : undefined} ref={wrapRef}>
          <table ref={tableRef} aria-rowcount={items.length + 1}>
            <caption className="sr-only">Lista de contenedores</caption>
            <thead>
              <tr aria-rowindex={1}>
                <th className="col-check">
                  <div className="check-cell">
                    <span className="row-grip" aria-hidden="true" style={{ visibility: 'hidden' }} />
                    <Checkbox
                      id="selAll"
                      aria-label="Seleccionar todos"
                      checked={allSel}
                      indeterminate={someSel && !allSel}
                      onChange={(e) => setSelected((prev) => {
                        const n = new Set(prev)
                        for (const c of filtered) { if (e.target.checked) n.add(c.id); else n.delete(c.id) }
                        return n
                      })}
                    />
                  </div>
                </th>
                <th scope="col" className="cell-name" ref={nameTh}>Nombre<NameResizer th={nameTh} ctl={nameW} /></th>
                <th scope="col">Estado</th>
                <th scope="col" className="col-ports">Puertos</th>
                <th scope="col" className="col-ports-more"><span className="sr-only">Ver todos los puertos</span></th>
                <th scope="col" className="num col-cpu">CPU</th>
                <th scope="col" className="num col-mem">Memoria</th>
                <th scope="col" className="col-actions"><span className="sr-only">Acciones</span></th>
                <th className="col-fill" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {!filtered.length ? (
                <tr>
                  <td colSpan={COLS + 1} style={{ height: 'auto' }}>
                    <div className="state" style={{ padding: '36px 24px' }}>
                      <span className="state-ico"><Icon name="search" size="lg" /></span>
                      <h2>Ningún contenedor coincide</h2>
                      <p>Prueba con otro nombre o quita el filtro de estado.</p>
                      <div className="btns"><Button variant="secondary" onClick={() => { setQ(''); setFilter('all') }}>Quitar filtros</Button></div>
                    </div>
                  </td>
                </tr>
              ) : (
                <>
                  {virt.padTop > 0 ? spacer(virt.padTop, 'top') : null}
                  {virt.items.map((v) => {
                    const it = items[v.index]
                    if (!it) return null
                    if (it.type === 'group') {
                      const open = !collapsed[it.key]
                      return (
                        <tr key={`g-${it.key}`} ref={virt.measure} data-index={v.index} data-drop-key={it.key} data-group-kind={it.kind} aria-rowindex={v.index + 2} className="group-row" style={{ '--grp-h': it.hue } as CSSProperties}>
                          <td colSpan={COLS + 1}>
                            <div className="group-head">
                              <button type="button" aria-expanded={open} onClick={() => setCollapsed((s) => ({ ...s, [it.key]: !s[it.key] }))}>
                                <Icon name="chev-down" size="sm" className="chev" />
                                <span className="grp-dot" aria-hidden="true" />
                                {it.kind === 'custom' ? <Icon name="folder" size="sm" /> : null}
                                {it.kind === 'custom' ? 'Grupo' : 'Stack'} {safeText(it.label)}{it.running > 0 ? <span className="live-dot" aria-hidden="true" /> : null} <span className="muted" style={{ fontWeight: 400 }}>· {it.count}{it.running ? ` · ${it.running} en ejecución` : ''}</span>
                              </button>
                              {it.nets.length > 0 ? (
                                <button
                                  type="button"
                                  className="group-nets"
                                  aria-haspopup="dialog"
                                  aria-label={`Ver las ${it.nets.length} ${it.nets.length === 1 ? 'red' : 'redes'} de ${it.kind === 'custom' ? 'el grupo' : 'el stack'} ${safeText(it.label)}`}
                                  title="Redes del grupo, con sus IPs"
                                  onClick={() => setNetsOfKey(it.key)}
                                >
                                  <Icon name="network" size="sm" />Redes <b>{it.nets.length}</b><Icon name="eye" size="sm" />
                                </button>
                              ) : null}
                              <a className="group-edit" href={route.href('settings', { tab: 'groups' })} aria-label={`Editar el color o el nombre de ${it.kind === 'custom' ? 'el grupo' : 'el stack'} ${safeText(it.label)}`} title="Editar en Configuración > Grupos"><Icon name="palette" size="sm" /></a>
                              <GroupUsage members={groupMembers.get(it.key)} volumes={volumes} />
                            </div>
                          </td>
                        </tr>
                      )
                    }
                    return (
                      <ContainerRow
                        key={it.c.id}
                        c={it.c}
                        groupHue={it.hue}
                        onShowInfo={showInfo}
                        onGripPointerDown={onGripPointerDown}
                        index={v.index}
                        measure={virt.measure}
                        selected={selected.has(it.c.id)}
                        locked={gate.locked}
                        href={route.href('detail', { c: containerName(it.c) })}
                        onSelect={onSelect}
                        onOp={onOp}
                        onDelete={onDelete}
                      />
                    )
                  })}
                  {virt.padBottom > 0 ? spacer(virt.padBottom, 'bottom') : null}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <DragTray />
      <ContainerInfoDialog target={infoOf} onClose={() => setInfoOf(null)} />
      <GroupNetworksDialog
        group={netsOfKey ? { kind: metaOf(netsOfKey).kind, label: metaOf(netsOfKey).label, containers: list.filter((c) => groupKeyOf(c) === netsOfKey) } : null}
        onClose={() => setNetsOfKey(null)}
      />
    </>
  )
}
