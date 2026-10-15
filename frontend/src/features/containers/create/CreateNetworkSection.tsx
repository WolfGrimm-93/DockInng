// Sección «Red y reinicio» del formulario de creación: red (de las existentes o la guardada) y política de reinicio.
import { safeText } from '@/lib/safeText'
import { Segmented } from '@/components/shared/Segmented'
import { Select } from '@/components/ui/input'
import type { Network, Restart } from '@/data/types'
import { FieldError } from './FieldError'

const RESTARTS: Restart[] = ['no', 'always', 'unless-stopped', 'on-failure']

export interface CreateNetworkSectionProps {
  networks: Network[]
  net: string
  setNet(v: string): void
  restart: Restart
  setRestart(v: Restart): void
  fieldError(k: string): string | undefined
}

export function CreateNetworkSection({ networks, net, setNet, restart, setRestart, fieldError: fe }: CreateNetworkSectionProps) {
  return (
    <section className="card form-section">
      <h2>Red y reinicio</h2>
      <div className="form-body">
        <div className="f-cols">
          <div className="f-row">
            <label htmlFor="fNet">Red</label>
            <Select id="fNet" value={net} aria-invalid={!!fe('network')} onChange={(e) => setNet(e.target.value)}>
              {networks.map((n) => <option key={n.id} value={n.name}>{safeText(n.name, { singleLine: true })}</option>)}
              {networks.some((n) => n.name === net) ? null : <option value={net}>{net}</option>}
            </Select>
            <FieldError id="eNet" message={fe('network')} />
          </div>
          <div className="f-row">
            <span className="f-label" id="lRestart">Política de reinicio</span>
            <Segmented<Restart> labelledBy="lRestart" className="justify-self-start" value={restart} onChange={setRestart} options={RESTARTS.map((r) => ({ value: r, label: r }))} />
          </div>
        </div>
      </div>
    </section>
  )
}
