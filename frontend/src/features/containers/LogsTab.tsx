// Pestaña «Logs»: flujo en vivo (buffer circular de 5 000 líneas) con visor virtualizado. Datos REALES.
// El nivel (INFO/WARN/ERROR/DEBUG) NO lo entrega Docker: se deduce en el frontend del texto de cada línea (lib/logLevel).
import { safeText } from '@/lib/safeText'
import { useMemo, useState } from 'react'
import { Icon } from '@/components/shared/Icon'
import { LogViewer } from '@/components/shared/LogViewer'
import { SearchField } from '@/components/shared/SearchField'
import { Segmented } from '@/components/shared/Segmented'
import { useLogStream } from '@/components/shared/useLogStream'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/checkbox'
import type { Container } from '@/data/types'
import { containerName } from '@/data/store/engineStore'
import { parseLogLine, type LogLevel } from '@/lib/logLevel'
import type { LogLine } from '@/data/types'
import { toast } from '@/lib/toastStore'

// Caché por objeto de línea: cada línea nueva se parsea una sola vez aunque el filtro cambie o lleguen ráfagas.
const parsedCache = new WeakMap<LogLine, ReturnType<typeof parseLogLine>>()
function parsed(l: LogLine) {
  let p = parsedCache.get(l)
  if (!p) { p = parseLogLine(l); parsedCache.set(l, p) }
  return p
}

type Lvl = 'all' | LogLevel
const LEVELS: Lvl[] = ['all', 'INFO', 'WARN', 'ERROR', 'DEBUG']
const ENDED: Record<string, string> = { eof: 'Fin del registro.', container_stopped: 'El contenedor está detenido: no llegan líneas nuevas.', cancelled: 'Flujo cancelado.', error: 'El flujo de logs se interrumpió.' }

export function LogsTab({ c }: { c: Container }) {
  const name = safeText(containerName(c), { singleLine: true })
  const { lines, dropped, ended } = useLogStream(c.id, { tail: 300, follow: true })
  const [q, setQ] = useState('')
  const [lvl, setLvl] = useState<Lvl>('all')
  const [follow, setFollow] = useState(true)

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase()
    return lines
      .map(parsed)
      .filter((l) => (lvl === 'all' || l.level === lvl) && (!n || l.body.toLowerCase().includes(n)))
  }, [lines, lvl, q])

  const copy = async () => {
    const text = visible.map((l) => `${l.ts} ${l.level} ${l.body}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.ok('Copiado al portapapeles', { sub: `${visible.length} líneas` })
    } catch {
      toast.warn('No se pudo copiar', { sub: 'El navegador no permitió el acceso al portapapeles.' })
    }
  }

  return (
    <>
      <div className="toolbar">
        <SearchField id="lq" placeholder="Filtrar líneas de log" value={q} onChange={setQ} />
        <Segmented<Lvl> ariaLabel="Nivel" value={lvl} onChange={setLvl} options={LEVELS.map((l) => ({ value: l, label: l === 'all' ? 'Todos' : l }))} />
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          <Switch checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Seguir en vivo
        </label>
        <Button variant="secondary" size="icon" aria-label="Copiar logs" onClick={() => void copy()}><Icon name="copy" /></Button>
      </div>
      <LogViewer lines={lines} follow={follow} level={lvl} query={q} label={`Logs de ${name}`} />
      <div role="status" aria-live="polite">
        {lines.length > 0 && visible.length === 0 ? <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>Ninguna línea coincide con el filtro.</p> : null}
        {dropped > 0 ? <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>{dropped} líneas omitidas por límite de caudal.</p> : null}
        {ended ? <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>{ENDED[ended] ?? 'Fin del flujo.'}</p> : null}
      </div>
    </>
  )
}
