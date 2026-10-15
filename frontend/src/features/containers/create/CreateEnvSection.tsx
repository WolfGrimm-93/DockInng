// Sección «Variables de entorno» del formulario de creación.
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { EnvRow } from '@/lib/createForm'
import { FieldError } from './FieldError'

export interface CreateEnvSectionProps {
  env: EnvRow[]
  patchEnv(id: string, patch: Partial<EnvRow>): void
  removeEnv(id: string): void
  addEnv(): void
  fieldError(k: string): string | undefined
  touch(k: string): void
}

export function CreateEnvSection({ env, patchEnv, removeEnv, addEnv, fieldError: fe, touch }: CreateEnvSectionProps) {
  return (
    <section className="card form-section">
      <h2>Variables de entorno</h2>
      <div className="form-body">
        {env.map((v, i) => (
          <div className="rep two" key={v.id}>
            <div><label className="sr-only" htmlFor={`eK${i}`}>Variable {i + 1}</label><Input className="mono" id={`eK${i}`} value={v.key} placeholder="CLAVE" aria-invalid={!!fe(`env.${v.id}.key`)} aria-describedby={fe(`env.${v.id}.key`) ? `eEK${i}` : undefined} onBlur={() => touch(`env.${v.id}.key`)} onChange={(e) => patchEnv(v.id, { key: e.target.value })} /></div>
            <div><label className="sr-only" htmlFor={`eV${i}`}>Valor {i + 1}</label><Input className="mono" id={`eV${i}`} value={v.value} placeholder="valor" onChange={(e) => patchEnv(v.id, { value: e.target.value })} /></div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Quitar variable ${i + 1}`} onClick={() => removeEnv(v.id)}><Icon name="x" /></Button>
            <FieldError id={`eEK${i}`} message={fe(`env.${v.id}.key`)} className="col-[1/-1]" />
          </div>
        ))}
        <div><Button type="button" variant="secondary" size="sm" onClick={addEnv}><Icon name="plus" size="sm" />Añadir variable</Button></div>
      </div>
    </section>
  )
}
