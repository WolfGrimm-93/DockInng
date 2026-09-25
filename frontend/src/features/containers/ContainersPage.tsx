// Vista «Contenedores»: tabla virtualizada (filas de altura fija) con búsqueda, filtro por estado, agrupación por stack,
// selección múltiple + barra masiva, acciones por fila con estado en curso/error y eliminación por el flujo de política.
// Datos REALES (Docker vía la capa de datos): lista, iniciar/detener/reiniciar, eventos en vivo, CPU/memoria.
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { devFlagsEnabled, getDevFlags, usePreviewState } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { describePlan } from '@/components/shared/planDescribe'
import { formatBytes, formatBytesPrecise, formatBytesSI } from '@/lib/format'
import { BulkBar } from '@/components/shared/BulkBar'
import { useGuardedAction } from '@/components/shared/ConfirmDialog'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { SearchField } from '@/components/shared/SearchField'
import { Segmented } from '@/components/shared/Segmented'
import { AlertBox, EmptyState, SkeletonTable } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { apiErrorMessage } from '@/data/errors'
import { containerName } from '@/data/store/engineStore'
import { useAllStats, useConnection, useContainers, useEngineApi, useEngineStoreApi, useNetworks, useSystemUsage, useVolumes } from '@/data/store/hooks'
import type { Container } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'
import { isOn, isStoppedState, matchesContainer, type StateFilter } from '../common/containerUtils'
import { assignGroupHues } from '../common/groupColor'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { readRowHeight, useVirtualTable } from '../common/useVirtualTable'
import { ContainerRow } from './ContainerRow'
import { AssignGroupMenu } from '../groups/AssignGroupMenu'
import { assignKey, useGroupsStore } from '../groups/groupsStore'
import { ResourceStrip } from './ResourceStrip'
import { groupDiskBytes, sumConsumption } from './usage'

const COLS = 7
// Cabecera de grupo = un stack de Compose (automático) o un grupo propio del usuario (`g:<id>` / `s:<proyecto>`), con las redes propias
// que usan sus contenedores. Un contenedor en un grupo propio deja de mostrarse en su stack. Los que no están en ninguno van fuera de
// los grupos, sin cabecera (como Docker Desktop).
type Item =
  | { type: 'group'; key: string; kind: 'stack' | 'custom'; label: string; count: number; running: number; nets: string[]; hue: number }
  | { type: 'row'; c: Container; hue?: number }

export default function ContainersPage() {
  const { list, status, counts, error } = useContainers()
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const route = useHashRoute()
  const guard = useGuardedAction()
  const gate = useViewGate(COLS, 8)
  const { list: volumes } = useVolumes()
  const { list: networks } = useNetworks()
  const allStats = useAllStats()
  const profileId = useConnection().profile.id
  const customGroups = useGroupsStore((s) => s.groups)
  const assigned = useGroupsStore((s) => s.assign)
  const stackHueOverride = useGroupsStore((s) => s.stackHue)
  const system = useSystemUsage()
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
  const [bulkBusy, setBulkBusy] = useState<{ op: 'start' | 'stop'; total: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const rowH = useMemo(() => readRowHeight(), [])

  const loading = preview === 'loading' || status === 'idle' || status === 'loading'
  const empty = preview === 'empty' || (status === 'ready' && list.length === 0)

  const filtered = useMemo(() => list.filter((c) => matchesContainer(c, filter, q)), [list, filter, q])
  const stopped = useMemo(() => list.filter((c) => isStoppedState(c.state)).length, [list])
  // Red(es) propia(s) de cada contenedor (nombre del contenedor → redes). Se omiten las de sistema (bridge, host, none).
  const netsByContainer = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const n of networks) {
      if (n.system) continue
      for (const cn of n.connected) m.set(cn, [...(m.get(cn) ?? []), n.name])
    }
    return m
  }, [networks])
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
  // Consumo de cada grupo (sobre TODOS sus contenedores, no solo los filtrados): CPU/RAM de los en marcha y disco aproximado.
  const groupUse = useMemo(() => {
    const by = new Map<string, Container[]>()
    for (const c of list) { const k = groupKeyOf(c); if (k) by.set(k, [...(by.get(k) ?? []), c]) }
    return new Map([...by].map(([k, cs]) => [k, { sum: sumConsumption(cs, allStats), disk: groupDiskBytes(cs, volumes, system?.container_disk ?? [], !!system?.disk_known) }]))
  }, [list, groupKeyOf, allStats, volumes, system])
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
      <td colSpan={COLS} style={{ height: h, padding: 0, border: 0 }} />
    </tr>
  )

  return (
    <>
      {head}
      <ResourceStrip />
      {toolbar}
      <div className="view-body" ref={scrollRef}>
        {gate.lostBanner}
        <div className="table-wrap">
          <table ref={tableRef} aria-rowcount={items.length + 1}>
            <caption className="sr-only">Lista de contenedores</caption>
            <thead>
              <tr aria-rowindex={1}>
                <th className="col-check">
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
                </th>
                <th scope="col" className="cell-name">Nombre</th>
                <th scope="col">Estado</th>
                <th scope="col" className="col-ports">Puertos</th>
                <th scope="col" className="num col-cpu">CPU</th>
                <th scope="col" className="num col-mem">Memoria</th>
                <th scope="col" className="col-actions"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {!filtered.length ? (
                <tr>
                  <td colSpan={COLS} style={{ height: 'auto' }}>
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
                        <tr key={`g-${it.key}`} ref={virt.measure} data-index={v.index} aria-rowindex={v.index + 2} className="group-row" style={{ '--grp-h': it.hue } as CSSProperties}>
                          <td colSpan={COLS}>
                            <div className="group-head">
                              <button type="button" aria-expanded={open} onClick={() => setCollapsed((s) => ({ ...s, [it.key]: !s[it.key] }))}>
                                <Icon name="chev-down" size="sm" className="chev" />
                                <span className="grp-dot" aria-hidden="true" />
                                {it.kind === 'custom' ? <Icon name="folder" size="sm" /> : null}
                                {it.kind === 'custom' ? 'Grupo' : 'Stack'} {safeText(it.label)} <span className="muted" style={{ fontWeight: 400 }}>· {it.count}{it.running ? ` · ${it.running} en ejecución` : ''}</span>
                              </button>
                              {it.nets.map((n) => (
                                <span key={n} className="net-chip mono" title={`Red: ${safeText(n)}`}><Icon name="network" size="sm" />{safeText(n)}</span>
                              ))}
                              <a className="group-edit" href={route.href('settings', { tab: 'groups' })} aria-label={`Editar el color o el nombre de ${it.kind === 'custom' ? 'el grupo' : 'el stack'} ${safeText(it.label)}`} title="Editar en Configuración > Grupos"><Icon name="palette" size="sm" /></a>
                              {(() => {
                                const u = groupUse.get(it.key)
                                if (!u) return null
                                return (
                                  <span className="group-usage">
                                    {u.sum.sampled > 0 ? <span className="usage-chip mono" title="CPU de los contenedores en marcha de este stack (100 % = 1 núcleo)">CPU {u.sum.cpu.toFixed(1)} %</span> : null}
                                    {u.sum.sampled > 0 ? <span className="usage-chip mono" title="Memoria de los contenedores en marcha de este stack">RAM {formatBytesPrecise(u.sum.memBytes)}</span> : null}
                                    {u.disk != null ? <span className="usage-chip usage-disk mono" title="Disco aproximado: capas de escritura + volúmenes de sus contenedores (no incluye las imágenes)">Disco ≈ {formatBytesSI(u.disk)}</span> : null}
                                  </span>
                                )
                              })()}
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
    </>
  )
}
