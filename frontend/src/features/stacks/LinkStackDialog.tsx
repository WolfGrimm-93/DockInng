// Diálogo «Abrir archivo Compose»: vincula un compose.yaml existente por su ruta absoluta (stack_link) y abre el editor.
import { useRef, useState } from 'react'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { FormDialog } from '@/components/shared/FormDialog'
import { Icon } from '@/components/shared/Icon'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { StackSummary } from '@/data/types'
import { toast } from '@/lib/toastStore'

export function LinkStackDialog({ open, initialPath = '', onClose, onLinked }: { open: boolean; initialPath?: string; onClose(): void; onLinked(s: StackSummary): void }) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const [path, setPath] = useState(initialPath)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) { setWasOpen(open); if (open) { setPath(initialPath); setTouched(false); setErr(null) } }

  const problem = !path.trim() ? 'Escribe la ruta del archivo.' : !/^(\/|~\/)/.test(path.trim()) ? 'Usa una ruta absoluta (empieza por «/» o «~/»).' : !/\.ya?ml$/i.test(path.trim()) ? 'El archivo debe terminar en .yml o .yaml.' : null
  const submit = async () => {
    setTouched(true)
    if (problem) { ref.current?.focus(); return }
    setBusy(true)
    setErr(null)
    try {
      const s = await api.stacks.link(path.trim())
      await store.getState().refresh('stacks')
      toast.ok(`Stack ${s.name} vinculado`, { sub: 'DockInng editará ese archivo directamente.' })
      onLinked(s)
    } catch (e) {
      const m = apiErrorMessage(e)
      setErr(m.detail || m.title)
    } finally { setBusy(false) }
  }
  const pickFile = async () => {
    setPicking(true)
    setErr(null)
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Compose', extensions: ['yml', 'yaml'] }],
      })
      if (typeof selected === 'string') {
        setPath(selected)
        setTouched(false)
      }
    } catch (e) {
      const m = apiErrorMessage(e)
      setErr(m.detail || m.title)
    } finally { setPicking(false) }
  }
  const shown = touched ? problem : null
  return (
    <FormDialog open={open} onClose={onClose} title="Abrir archivo Compose" icon="file" submitLabel="Vincular y editar" submitIcon="check" busy={busy} formError={err} initialFocus={ref} onSubmit={() => void submit()}
      description={<p>Indica la ruta de un <code>compose.yaml</code> existente. DockInng lo vincula como stack: no lo mueve ni lo copia, y al guardar escribe en ese mismo archivo.</p>}>
      <div className="f-row">
        <label htmlFor="lsPath">Ruta del archivo</label>
        <div className="f-inline">
          <Input ref={ref} id="lsPath" className="mono" value={path} autoComplete="off" spellCheck={false} placeholder="/home/usuario/proyecto/compose.yaml" aria-invalid={shown ? true : undefined} aria-describedby="lsErr"
            onChange={(e) => setPath(e.target.value)} onBlur={() => setTouched(true)} />
          <Button type="button" variant="secondary" disabled={busy || picking} onClick={() => void pickFile()}>
            {picking ? <><Icon name="loader" size="sm" spin />Abriendo…</> : <><Icon name="file" size="sm" />Examinar…</>}
          </Button>
        </div>
        {shown ? <span className="f-error" id="lsErr"><Icon name="alert" size="sm" />{shown}</span> : <span className="f-hint" id="lsErr">Selecciona un archivo Compose existente o escribe su ruta absoluta.</span>}
      </div>
    </FormDialog>
  )
}
