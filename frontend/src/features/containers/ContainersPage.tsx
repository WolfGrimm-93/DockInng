// Vista «Contenedores»: tabla virtualizada (filas de altura fija) con búsqueda, filtro por estado, agrupación por stack,
// selección múltiple + barra masiva, acciones por fila con estado en curso/error y eliminación por el flujo de política.
// Datos REALES (Docker vía la capa de datos): lista, iniciar/detener/reiniciar, eventos en vivo, CPU/memoria.
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { devFlagsEnabled, getDevFlags, usePreviewState } from '@/app/devFlags'
import { useHashRoute } from '@/app/useHashRoute'
import { describePlan } from '@/components/shared/planDescribe'
import { formatBytes } from '@/lib/format'
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
import { useConnection, useContainers, useEngineApi, useEngineStoreApi, useNetworks, useStatsConsumer, useVolumes } from '@/data/store/hooks'
import type { Container } from '@/data/types'
import { toast } from '@/lib/toastStore'
import { isOn, isStoppedState, matchesContainer, type StateFilter } from '../common/containerUtils'
import { useStartupOnce } from '../common/devOnce'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { readRowHeight, useVirtualTable } from '../common/useVirtualTable'
import { ContainerRow } from './ContainerRow'
import { NameResizer } from './NameResizer'
import { useNameColumnWidth } from './useNameColumnWidth'
import { AssignGroupMenu } from '../groups/AssignGroupMenu'
import { DragTray } from '../groups/DragTray'
import { useRowDrag } from '../groups/useRowDrag'
import { ContainerGroupRow } from './ContainerGroupRow'
import { ContainerInfoDialog, type InfoTarget } from './ContainerInfoDialog'
import { GroupNetworksDialog } from './GroupNetworksDialog'
import { ResourceStrip } from './ResourceStrip'
import { useContainerItems } from './useContainerItems'

const COLS = 8
// Los que no están en ningún grupo van fuera de los grupos, sin cabecera (como Docker Desktop).

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
  // Cabeceras de grupo y filas (agrupación por stack o grupo propio); ver useContainerItems.
  const { items, groupKeyOf, metaOf, groupMembers } = useContainerItems({ list, networks, filtered, group, collapsed, profileId })
  const toggleGroup = useCallback((key: string) => setCollapsed((s) => ({ ...s, [key]: !s[key] })), [])

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
        <span className="muted self-center" role="status" aria-live="polite">
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
    <tr key={k} aria-hidden="true" className="pointer-events-none bg-transparent">
      <td colSpan={COLS + 1} className="border-0 p-0" style={{ height: h }} />
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
                    <span className="row-grip invisible" aria-hidden="true" />
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
                  <td colSpan={COLS + 1} className="h-auto">
                    <div className="state px-6 py-9">
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
                      return (
                        <ContainerGroupRow
                          key={`g-${it.key}`}
                          item={it}
                          index={v.index}
                          measure={virt.measure}
                          open={!collapsed[it.key]}
                          settingsHref={route.href('settings', { tab: 'groups' })}
                          members={groupMembers.get(it.key)}
                          volumes={volumes}
                          onToggle={toggleGroup}
                          onShowNets={setNetsOfKey}
                        />
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
