// Sección «Puertos» del formulario de creación: filas de publicación (interfaz, puerto del equipo, puerto del contenedor, protocolo).
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import type { PortRow } from '@/lib/createForm'
import { FieldError } from './FieldError'

export interface CreatePortsSectionProps {
  ports: PortRow[]
  patchPort(id: string, patch: Partial<PortRow>): void
  removePort(id: string): void
  addPort(): void
  fieldError(k: string): string | undefined
  touch(k: string): void
}

export function CreatePortsSection({ ports, patchPort, removePort, addPort, fieldError: fe, touch }: CreatePortsSectionProps) {
  return (
    <section className="card form-section">
      <h2>Puertos</h2>
      <div className="form-body">
        {ports.map((p, i) => (
          <div className="rep port-row" key={p.id}>
            <div>
              <label className="sr-only" htmlFor={`pI${i}`}>Interfaz del puerto {i + 1}</label>
              <Select id={`pI${i}`} value={p.hostIp} onChange={(e) => patchPort(p.id, { hostIp: e.target.value as 'local' | 'all' })}><option value="local">Solo este equipo</option><option value="all">Todas las interfaces</option></Select>
            </div>
            <div><label className="sr-only" htmlFor={`pH${i}`}>Puerto del equipo {i + 1}</label><Input id={`pH${i}`} value={p.host} placeholder="8080" inputMode="numeric" aria-invalid={!!fe(`ports.${p.id}.host`)} aria-describedby={fe(`ports.${p.id}.host`) ? `ePH${i}` : undefined} onBlur={() => touch(`ports.${p.id}.host`)} onChange={(e) => patchPort(p.id, { host: e.target.value })} /></div>
            <div><label className="sr-only" htmlFor={`pC${i}`}>Puerto del contenedor {i + 1}</label><Input id={`pC${i}`} value={p.container} placeholder="80" inputMode="numeric" aria-invalid={!!fe(`ports.${p.id}.container`)} aria-describedby={fe(`ports.${p.id}.container`) ? `ePC${i}` : undefined} onBlur={() => touch(`ports.${p.id}.container`)} onChange={(e) => patchPort(p.id, { container: e.target.value })} /></div>
            <div>
              <label className="sr-only" htmlFor={`pP${i}`}>Protocolo {i + 1}</label>
              <Select id={`pP${i}`} value={p.protocol} onChange={(e) => patchPort(p.id, { protocol: e.target.value as 'tcp' | 'udp' })}><option value="tcp">tcp</option><option value="udp">udp</option></Select>
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Quitar puerto ${i + 1}`} onClick={() => removePort(p.id)}><Icon name="x" /></Button>
            <FieldError id={`ePH${i}`} message={fe(`ports.${p.id}.host`)} className="col-[1/-1]" />
            <FieldError id={`ePC${i}`} message={fe(`ports.${p.id}.container`)} className="col-[1/-1]" />
            {p.hostIp === 'all' && p.host.trim() ? <span className="f-hint col-[1/-1]">Publicado en todas las interfaces: accesible desde tu red.</span> : null}
          </div>
        ))}
        <div><Button type="button" variant="secondary" size="sm" onClick={addPort}><Icon name="plus" size="sm" />Añadir puerto</Button></div>
      </div>
    </section>
  )
}
