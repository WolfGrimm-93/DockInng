// Diálogo «Nuevo stack»: crea un stack propio (managed) con una plantilla mínima y abre el editor.
import { useRef, useState } from 'react'
import { FormDialog } from '@/components/shared/FormDialog'
import { Icon } from '@/components/shared/Icon'
import { Input } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { StackSummary } from '@/data/types'
import { STACK_NAME_RE, stackTemplate } from '@/lib/resourceNames'
import { toast } from '@/lib/toastStore'

export function NewStackDialog({ open, existing, onClose, onCreated }: { open: boolean; existing: readonly string[]; onClose(): void; onCreated(s: StackSummary): void }) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  const problem = !name ? 'Escribe un nombre.' : !STACK_NAME_RE.test(name) ? 'Usa minúsculas, números, «-» o «_», y empieza por letra o número.' : existing.includes(name) ? 'Ya existe un stack con ese nombre.' : null
  const close = () => { setName(''); setTouched(false); setErr(null); onClose() }
  const submit = async () => {
    setTouched(true)
    if (problem) { ref.current?.focus(); return }
    setBusy(true)
    setErr(null)
    try {
      const s = await api.stacks.create(name, stackTemplate(name), '')
      await store.getState().refresh('stacks')
      toast.ok(`Stack ${name} creado`)
      setName(''); setTouched(false)
      onCreated(s)
    } catch (e) {
      const m = apiErrorMessage(e)
      setErr(m.detail || m.title)
    } finally { setBusy(false) }
  }
  const shown = touched ? problem : null
  return (
    <FormDialog open={open} onClose={close} title="Nuevo stack" icon="grid" submitLabel="Crear stack" busy={busy} formError={err} initialFocus={ref} onSubmit={() => void submit()}
      description={<p>Se crea un stack propio con un <code>compose.yaml</code> de ejemplo en <code>~/.local/share/dockinng/stacks/</code>. Luego lo editas y lo levantas.</p>}>
      <div className="f-row">
        <label htmlFor="nsName">Nombre del stack</label>
        <Input ref={ref} id="nsName" className="mono" value={name} autoComplete="off" spellCheck={false} placeholder="mi-proyecto" aria-invalid={shown ? true : undefined} aria-describedby="nsErr"
          onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} />
        {shown ? <span className="f-error" id="nsErr"><Icon name="alert" size="sm" />{shown}</span> : <span className="f-hint" id="nsErr">Es el nombre del proyecto de Compose.</span>}
      </div>
    </FormDialog>
  )
}
