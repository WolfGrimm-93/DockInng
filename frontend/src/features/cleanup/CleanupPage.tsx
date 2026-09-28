// Vista «Limpieza» (#cleanup): limpieza GUIADA. `cleanup_report` (solo lectura) lista lo recuperable por categorías; tú eliges elemento a elemento y se
// ejecuta con el flujo de política normal (`{type:'cleanup', selection}` → confirmación → ejecución POR ELEMENTO, nunca `prune`). Reglas de la UI:
//   - Estimaciones honestas: «exacta» / «aprox. (cota superior; las capas compartidas no liberan todo)» / «desconocida». Nunca se inventa un tamaño.
//   - Los volúmenes NUNCA vienen marcados (pueden tener datos); si hay alguno en la selección, la confirmación es escrita (ELIMINAR).
//   - La caché de build es solo informativa (la API no permite borrarla por elemento).
import { useEffect, useMemo, useState } from 'react'
import { useGuardedAction } from '@/components/shared/useGuardedAction'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { SafeName } from '@/components/shared/SafeName'
import { AlertBox, EmptyState, SkeletonTable } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { apiErrorMessage } from '@/data/errors'
import { useCapability, useEngineApi, useEngineStore, useEngineStoreApi } from '@/data/store/hooks'
import type { CleanupCategory, CleanupCategoryId, CleanupItem, CleanupReport } from '@/data/types'
import { formatBytes } from '@/lib/format'
import { useViewGate } from '../common/gate'
import { keyOf, sizeText, summarize, toSelection } from './cleanupModel'
import { describeCleanup } from './describeCleanup'

const LABEL: Record<CleanupCategoryId, { title: string; hint: string }> = {
  stopped_containers: { title: 'Contenedores detenidos', hint: 'Contenedores que ya no se ejecutan. Sus volúmenes no se tocan.' },
  dangling_images: { title: 'Imágenes colgadas', hint: 'Capas sin nombre que dejó una reconstrucción o una descarga nueva.' },
  unused_images: { title: 'Imágenes sin usar', hint: 'Imágenes con nombre que ningún contenedor usa. Podrás volver a descargarlas.' },
  unused_volumes: { title: 'Volúmenes sin usar', hint: 'Pueden contener datos. Nunca se marcan por sí solos y borrarlos exige confirmación escrita.' },
  unused_networks: { title: 'Redes sin usar', hint: 'Redes propias sin contenedores conectados (las del sistema no se listan).' },
  build_cache: { title: 'Caché de construcción', hint: 'Solo informativo: la API de Docker no permite borrarla elemento a elemento sin un prune ciego.' },
}
const AGES = [{ v: 0, label: 'Cualquier antigüedad' }, { v: 7, label: 'Más de 7 días' }, { v: 30, label: 'Más de 30 días' }, { v: 90, label: 'Más de 90 días' }]
const RISK = { low: 'Riesgo bajo', medium: 'Riesgo medio', high: 'Riesgo alto: datos' } as const

function CategoryCard({ cat, picked, open, onToggleOpen, onToggleItem, onToggleAll }: {
  cat: CleanupCategory; picked: ReadonlySet<string>; open: boolean; onToggleOpen(): void; onToggleItem(i: CleanupItem): void; onToggleAll(on: boolean): void
}) {
  const meta = LABEL[cat.id]
  const sel = cat.items.filter((i) => picked.has(keyOf(i))).length
  const all = cat.items.length > 0 && sel === cat.items.length
  const bodyId = `cat-${cat.id}`
  const hasUnknown = cat.items.some((i) => i.size_bytes === null || i.estimate === 'unknown')
  return (
    <section className={`card cleanup-cat${cat.id === 'unused_volumes' ? ' is-risky' : ''}`} aria-labelledby={`${bodyId}-t`}>
      <header className="cleanup-head">
        {cat.executable && cat.items.length > 0 ? (
          <Checkbox aria-label={`Seleccionar todo en ${meta.title}`} checked={all} indeterminate={sel > 0 && !all} onChange={(e) => onToggleAll(e.target.checked)} />
        ) : <span style={{ width: 16 }} aria-hidden="true" />}
        <button type="button" className="cleanup-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggleOpen}>
          <Icon name="chev-down" size="sm" className="chev" />
          <b id={`${bodyId}-t`}>{meta.title}</b>
          <span className="muted"> · {cat.executable ? `${cat.items.length} ${cat.items.length === 1 ? 'elemento' : 'elementos'}` : 'informativo'}</span>
        </button>
        <span className="cleanup-size mono">{cat.executable && cat.items.length === 0 ? '—' : cat.reclaimable_bytes === null ? 'desconocido' : `${cat.id === 'unused_images' || cat.id === 'dangling_images' ? '≤ ' : ''}${formatBytes(cat.reclaimable_bytes)}${hasUnknown ? ' + desconocido' : ''}`}</span>
      </header>
      {open ? (
        <div id={bodyId}>
          <p className="muted cleanup-hint">{meta.hint}</p>
          {cat.items.length === 0 ? <p className="cleanup-empty">{cat.executable ? 'Nada que limpiar aquí.' : cat.reclaimable_bytes !== null ? `Docker informa ${formatBytes(cat.reclaimable_bytes)} recuperables. Bórrala desde una terminal si lo necesitas (docker builder prune).` : 'Sin datos.'}</p> : (
            <ul className="cleanup-list" aria-label={meta.title}>
              {cat.items.map((i) => (
                <li key={keyOf(i)}>
                  <label className="cleanup-item">
                    <Checkbox checked={picked.has(keyOf(i))} onChange={() => onToggleItem(i)} />
                    <span className="cleanup-name"><b><SafeName mono ellipsis>{i.name}</SafeName></b><small>{i.reason}</small></span>
                    <span className={`tag risk-${i.risk}`}>{RISK[i.risk]}</span>
                    <span className="cleanup-size mono">{sizeText(i)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}

export default function CleanupPage() {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const guard = useGuardedAction()
  const gate = useViewGate(4, 6)
  const cap = useCapability('cleanup')
  const [age, setAge] = useState(30)
  const activeId = useEngineStore((s) => s.activeProfileId)
  // El informe es de UNA conexión: si se cambia de servidor se descarta al instante (nunca se limpia con la lista de otro equipo).
  const [loaded, setLoaded] = useState<{ report: CleanupReport; forId: string } | null>(null)
  const report = loaded && loaded.forId === activeId ? loaded.report : null
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [openCat, setOpenCat] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [freed, setFreed] = useState<{ count: number; bytes: number | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = () => setNonce((n) => n + 1)

  // El informe se pide al montar, al cambiar el filtro de antigüedad y en cada «Actualizar». `alive` descarta respuestas de un filtro anterior.
  useEffect(() => {
    let alive = true
    api.system.cleanupReport({ minAgeDays: age }).then((r) => {
      if (!alive) return
      setLoaded({ report: r, forId: activeId })
      setError(null)
      setPicked(new Set(r.categories.filter((c) => c.executable).flatMap((c) => c.items.filter((i) => i.selected_by_default && i.kind !== 'volume').map(keyOf))))
    }).catch((e) => {
      if (!alive) return
      const m = apiErrorMessage(e)
      setError(m.detail || m.title)
    })
    return () => { alive = false }
  }, [api, age, nonce, activeId])

  const sum = useMemo(() => (report ? summarize(report, picked) : null), [report, picked])
  // B-5: el backend admite como mucho `limit` elementos por limpieza (500).
  const limit = 500
  const over = (sum?.count ?? 0) > limit
  // B-12: el resumen visible NO es aria-live (anunciaría cada casilla); un único estado sr-only se actualiza con retardo.
  const [announce, setAnnounce] = useState('')
  const summaryText = sum ? `${sum.count} ${sum.count === 1 ? 'elemento seleccionado' : 'elementos seleccionados'}${sum.count ? `, ${sum.approx ? 'hasta ' : ''}${formatBytes(sum.bytes)}` : ''}` : ''
  useEffect(() => {
    const t = setTimeout(() => setAnnounce(summaryText), 900)
    return () => clearTimeout(t)
  }, [summaryText])
  const toggleItem = (i: CleanupItem) => setPicked((p) => { const n = new Set(p); if (n.has(keyOf(i))) n.delete(keyOf(i)); else n.add(keyOf(i)); return n })
  const toggleAll = (c: CleanupCategory, on: boolean) => setPicked((p) => { const n = new Set(p); for (const i of c.items) { if (on) n.add(keyOf(i)); else n.delete(keyOf(i)) } return n })

  const clean = async () => {
    if (!report || !sum?.count || busy || over) return
    setBusy(true)
    try {
      const r = await guard({ type: 'cleanup', selection: toSelection(report, picked) }, describeCleanup)
      if (r.status === 'done') {
        setFreed({ count: r.outcome.succeeded.length, bytes: r.outcome.freed_bytes })
        void store.getState().refresh('all')
        reload()
        document.getElementById('viewTitle')?.focus({ preventScroll: true })
      } else if (r.status === 'error' && (r.error.code === 'state_changed' || r.error.code === 'ticket_expired' || r.error.code === 'conflict')) reload()
    } finally { setBusy(false) }
  }

  const head = (
    <PageHeader
      title="Limpieza"
      count={report ? `${report.total_reclaimable_bytes === null ? 'tamaño desconocido' : `hasta ${formatBytes(report.total_reclaimable_bytes)} recuperables`}${report.unknown_count ? ` · ${report.unknown_count} sin tamaño conocido` : ''}` : null}
      secondary={<Button variant="secondary" locked={gate.locked} onClick={reload}><Icon name="refresh" />Actualizar informe</Button>}
      simulated={cap !== 'live'}
    />
  )
  if (gate.blocked) return <>{head}{gate.blocked}</>

  const total = report?.categories.reduce((a, c) => a + (c.executable ? c.items.length : 0), 0) ?? 0
  return (
    <>
      {head}
      <div className="toolbar">
        <label className="muted" htmlFor="clAge">Imágenes sin usar:</label>
        <select id="clAge" className="input" style={{ maxWidth: 220 }} value={age} onChange={(e) => setAge(Number(e.target.value))}>
          {AGES.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
        </select>
        <span className="muted">Solo lectura hasta que confirmes. Nunca se ejecuta <code>prune</code>.</span>
      </div>
      <div className="view-body cleanup-body">
        {gate.lostBanner}
        {freed ? <AlertBox kind="info" icon="check" title={`${freed.count} elementos eliminados`} text={freed.bytes ? `Se liberaron unos ${formatBytes(freed.bytes)} (aprox.: las capas compartidas pueden liberar menos).` : 'Espacio liberado no informado por el motor.'} /> : null}
        {report?.defaults_truncated ? <AlertBox kind="warn" icon="warn" title={`Hay más de ${limit} elementos recomendados`} text={`Solo los primeros ${limit} vienen marcados (tope de ${limit} por limpieza). Limpia y actualiza el informe para seguir con el resto.`} /> : null}
        {over ? <AlertBox kind="warn" icon="warn" title={`Máximo ${limit} elementos por limpieza`} text={`Tienes ${sum?.count} marcados: desmarca ${(sum?.count ?? 0) - limit} para poder continuar.`} /> : null}
        {error && !report ? <AlertBox kind="error" icon="alert" title="No se pudo generar el informe" text={error} actions={<Button variant="secondary" size="sm" onClick={reload}><Icon name="refresh" size="sm" />Reintentar</Button>} /> : null}
        {!report && !error ? <SkeletonTable cols={4} rows={6} /> : null}
        {report && total === 0 && !report.categories.some((c) => !c.executable && (c.reclaimable_bytes ?? 0) > 0) ? (
          <EmptyState icon="check" title="No hay nada que limpiar" text="No se encontraron contenedores detenidos, imágenes ni redes sin usar con este filtro." />
        ) : null}
        {report?.categories.map((c) => (
          <CategoryCard key={c.id} cat={c} picked={picked} open={openCat[c.id] ?? true} onToggleOpen={() => setOpenCat((o) => ({ ...o, [c.id]: !(o[c.id] ?? true) }))} onToggleItem={toggleItem} onToggleAll={(on) => toggleAll(c, on)} />
        ))}
      </div>
      {report ? (
        <div className="cleanup-bar" role="region" aria-label="Resumen de la selección">
          <div className="cleanup-sum">
            <span className="sr-only" role="status" aria-live="polite">{announce}</span>
            <b>{sum?.count ?? 0} {(sum?.count ?? 0) === 1 ? 'elemento seleccionado' : 'elementos seleccionados'}</b>
            <span className="muted">
              {sum && sum.count > 0 ? `${sum.approx ? 'hasta ' : ''}${formatBytes(sum.bytes)}${sum.approx ? ' (aprox.)' : ''}${sum.unknown ? ` + ${sum.unknown} de tamaño desconocido` : ''}` : 'Marca lo que quieras eliminar'}
              {sum?.volumes ? ` · incluye ${sum.volumes} volumen(es): confirmación escrita` : ''}
            </span>
          </div>
          <Button variant="destructive" locked={gate.locked || !sum?.count || busy || over} aria-haspopup="dialog" onClick={() => void clean()}><Icon name={busy ? 'loader' : 'trash'} spin={busy} />Revisar y limpiar</Button>
        </div>
      ) : null}
    </>
  )
}
