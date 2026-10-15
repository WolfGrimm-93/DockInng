// Sección «Grupo» del formulario de creación: grupo propio de la app (no cambia nada en Docker) y alta rápida de grupo.
import { safeText } from '@/lib/safeText'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'

export interface CreateGroupSectionProps {
  groups: { id: string; name: string }[]
  groupId: string
  setGroupId(id: string): void
  /** El diálogo «Nuevo grupo» se renderiza fuera del formulario (lo abre la página). */
  onNewGroup(): void
}

export function CreateGroupSection({ groups, groupId, setGroupId, onNewGroup }: CreateGroupSectionProps) {
  return (
    <section className="card form-section">
      <h2>Grupo</h2>
      <div className="form-body">
        <div className="f-row">
          <label htmlFor="fGroup">Grupo propio <span className="muted">(opcional)</span></label>
          <div className="flex flex-wrap gap-2">
            <Select id="fGroup" value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-describedby="hGroup">
              <option value="">Sin grupo (por defecto: su stack o suelto)</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{safeText(g.name, { singleLine: true })}</option>)}
            </Select>
            <Button type="button" variant="secondary" size="sm" onClick={onNewGroup}><Icon name="folder-plus" size="sm" />Nuevo grupo…</Button>
          </div>
          <span className="f-hint" id="hGroup">Los grupos son solo de esta app: no cambian nada en Docker.</span>
        </div>
      </div>
    </section>
  )
}
