// Pestaña «Estadísticas»: CPU y memoria con sparklines (últimos 60 muestreos) + red y disco. Datos REALES (subscribe_stats).
import { useEffect, useState } from 'react'
import { Icon } from '@/components/shared/Icon'
import { Sparkline } from '@/components/shared/Sparkline'
import { AlertBox } from '@/components/shared/StateViews'
import { useEngineApi } from '@/data/store/hooks'
import type { Container, ContainerDetail, ContainerStats } from '@/data/types'
import { formatBytesPrecise, formatBytesSI } from '@/lib/format'
import { isOn } from '../common/containerUtils'

const MAX = 60
const MIB = 1024 * 1024

export function StatsTab({ c, detail }: { c: Container; detail: ContainerDetail | null }) {
  const api = useEngineApi()
  const [cpu, setCpu] = useState<number[]>([])
  const [mem, setMem] = useState<number[]>([])
  const [last, setLast] = useState<ContainerStats | null>(null)
  const on = isOn(c.state)

  useEffect(() => {
    if (!on) return
    return api.containers.streamStats(c.id, (s) => {
      setLast(s)
      setCpu((p) => [...p, s.cpu_percent].slice(-MAX))
      setMem((p) => [...p, s.mem_percent].slice(-MAX))
    })
  }, [api, c.id, on])

  const cpuLimit = detail?.cpu_limit ? `límite: ${detail.cpu_limit} CPU` : 'sin límite de CPU'
  const memLimit = detail?.memory_limit_bytes ? `límite: ${formatBytesPrecise(detail.memory_limit_bytes)}` : last ? `sin límite (equipo: ${formatBytesPrecise(last.mem_limit_bytes)})` : 'sin límite de memoria'

  return (
    <>
      {!on ? <AlertBox kind="info" icon="info" title="El contenedor no está en ejecución" text="Las estadísticas en vivo solo existen mientras el contenedor corre." /> : null}
      <div className="stats-grid">
        <div className="card stat">
          <div className="stat-head"><Icon name="cpu" /><span>CPU</span><strong id="cpuVal">{last ? `${last.cpu_percent.toFixed(1)}%` : '—'}</strong></div>
          <Sparkline values={cpu} color="var(--chart-1)" label="Uso de CPU en los últimos 60 segundos" />
          <div className="stat-foot"><span>hace 60 s</span><span>{cpuLimit}</span><span>ahora</span></div>
        </div>
        <div className="card stat">
          <div className="stat-head"><Icon name="database" /><span>Memoria</span><strong id="memVal">{last ? `${Math.round(last.mem_used_bytes / MIB)} MiB` : '—'}</strong></div>
          <Sparkline values={mem} color="var(--chart-2)" label="Uso de memoria en los últimos 60 segundos" />
          <div className="stat-foot"><span>hace 60 s</span><span>{memLimit}</span><span>ahora</span></div>
        </div>
        <div className="card stat">
          <div className="stat-head"><Icon name="network" /><span>Red (entrada / salida)</span></div>
          <dl className="kv" style={{ gridTemplateColumns: 'auto 1fr', marginBlock: '1em' }}>
            <dt>Recibido</dt><dd className="mono">{last ? `${formatBytesSI(last.net_rx_bytes)} · ${formatBytesSI(last.net_rx_bytes_per_sec)}/s` : '—'}</dd>
            <dt>Enviado</dt><dd className="mono">{last ? `${formatBytesSI(last.net_tx_bytes)} · ${formatBytesSI(last.net_tx_bytes_per_sec)}/s` : '—'}</dd>
          </dl>
        </div>
        <div className="card stat">
          <div className="stat-head"><Icon name="disk" /><span>Disco (lectura / escritura)</span></div>
          <dl className="kv" style={{ gridTemplateColumns: 'auto 1fr', marginBlock: '1em' }}>
            <dt>Leído</dt><dd className="mono">{last ? formatBytesSI(last.block_read_bytes) : '—'}</dd>
            <dt>Escrito</dt><dd className="mono">{last ? formatBytesSI(last.block_write_bytes) : '—'}</dd>
            <dt>Procesos</dt><dd className="mono">{last ? last.pids : '—'}</dd>
          </dl>
        </div>
      </div>
    </>
  )
}
