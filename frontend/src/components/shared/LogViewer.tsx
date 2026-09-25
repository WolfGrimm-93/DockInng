// VISOR DE LOGS VIRTUALIZADO (@tanstack/react-virtual; líneas de altura variable con measureElement). Contrato:
//   <LogViewer lines={LogLine[]} follow level?='all'|'INFO'|… query? label />
//   - role="log" aria-live="off" (virtualización + polite saturaría al lector); los ERROR nuevos se anuncian en una región sr-only aparte.
//   - Texto SIEMPRE como nodos de texto (nunca HTML); el nivel se aplica con clases (lvl-*, is-error/is-warn).
//   - `follow` = pegado al final; al desactivarlo se conserva la posición. Nivel deducido por heurística (lib/logLevel).
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '@/data/types'
import { logLevelClass, parseLogLine, type LogLevel } from '@/lib/logLevel'

export function LogViewer({ lines, follow, level = 'all', query = '', label }: { lines: LogLine[]; follow: boolean; level?: 'all' | LogLevel; query?: string; label: string }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const parsed = useMemo(() => lines.map((l) => parseLogLine(l)), [lines])
  const q = query.trim().toLowerCase()
  const rows = useMemo(() => parsed.filter((l) => (level === 'all' || l.level === level) && (!q || l.body.toLowerCase().includes(q))), [parsed, level, q])

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
    initialRect: { width: 800, height: 400 },
  })

  useEffect(() => {
    if (follow && rows.length) virt.scrollToIndex(rows.length - 1, { align: 'end' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, rows.length])

  // Anuncio accesible del último ERROR (una sola región polite; no se anuncian INFO/DEBUG).
  const lastError = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].level === 'ERROR') return `Error en los logs: ${rows[i].body}`
    return ''
  }, [rows])
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setAnnounce(lastError), 500)
    return () => clearTimeout(t)
  }, [lastError])

  return (
    <div className="logs-wrap">
      <div className="console" ref={parentRef} tabIndex={0} role="log" aria-live="off" aria-label={label}>
        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virt.getVirtualItems().map((v) => {
            const l = rows[v.index]
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virt.measureElement}
                className={`log-line ${l.level === 'ERROR' ? 'is-error' : l.level === 'WARN' ? 'is-warn' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
              >
                <span className="log-ts">{l.ts}</span>
                <span className={`log-lvl ${logLevelClass(l.level)}`}>{l.level}</span>
                <span>{l.body}</span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    </div>
  )
}
