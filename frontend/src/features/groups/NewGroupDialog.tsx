// Diálogo «Nuevo grupo»: nombre (validado) + color. Se cierra con Cancelar/Esc; Enter en el nombre crea el grupo.
import { useRef, useState } from 'react'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/dialog'
import { HuePicker } from './HuePicker'
import { MAX_GROUP_NAME, nextFreeHue, useGroupsStore, validateGroupName } from './groupsStore'

export function NewGroupDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated?(id: string): void }) {
  const groups = useGroupsStore((s) => s.groups)
  const create = useGroupsStore((s) => s.createGroup)
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [hue, setHue] = useState<number | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const effectiveHue = hue ?? nextFreeHue(groups.map((g) => g.hue))
  const error = validateGroupName(name, groups)
  const shown = touched ? error : null

  const close = () => { setName(''); setTouched(false); setHue(null); onClose() }
  const submit = () => {
    setTouched(true)
    if (error) return
    const id = create(name, effectiveHue)
    if (id) { onCreated?.(id); close() }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <AlertDialogContent initialFocus={nameRef}>
        <form onSubmit={(e) => { e.preventDefault(); submit() }}>
          <div className="dlg-body">
            <span className="dlg-ico"><Icon name="folder-plus" size="lg" /></span>
            <div>
              <AlertDialogTitle>Nuevo grupo</AlertDialogTitle>
              <AlertDialogDescription render={<div />}>
                <p>Los grupos son solo de esta app: no cambian nada en Docker ni en tus contenedores.</p>
              </AlertDialogDescription>
              <div className="typed" style={{ marginTop: 12 }}>
                <label htmlFor="ngName">Nombre</label>
                <input
                  ref={nameRef}
                  id="ngName"
                  className="input"
                  value={name}
                  maxLength={MAX_GROUP_NAME + 10}
                  autoComplete="off"
                  aria-invalid={shown ? true : undefined}
                  aria-describedby="ngErr"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched(true)}
                />
                <small id="ngErr" role="status" aria-live="polite" className={shown ? 'field-error' : 'muted'}>{shown ?? `Hasta ${MAX_GROUP_NAME} caracteres.`}</small>
              </div>
              <div style={{ marginTop: 12 }}>
                <b style={{ fontSize: 'var(--text-sm)' }}>Color</b>
                <HuePicker value={effectiveHue} onChange={setHue} label="Color del grupo nuevo" />
              </div>
            </div>
          </div>
          <div className="dlg-foot">
            <Button type="button" variant="secondary" onClick={close}>Cancelar</Button>
            <Button type="submit" variant="primary"><Icon name="plus" />Crear grupo</Button>
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
