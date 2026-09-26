// Diálogo «Nuevo volumen» (create_volume): nombre validado (duplicado contra el store), driver local, etiquetas opcionales.
// Error del backend: dentro del diálogo (no se cierra). Éxito: cierra, toast, refresca y resalta la fila nueva.
import { useRef, useState } from 'react'
import { FormDialog } from '@/components/shared/FormDialog'
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { Volume } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { parseFieldErrors, validateLabelKey, validateVolumeName } from '@/lib/resourceNames'
import { toast } from '@/lib/toastStore'
import { uuidv7 } from '@/lib/uuid7'

const MAX_LABELS = 10

export function NewVolumeDialog({ open, existing, onClose, onCreated }: { open: boolean; existing: readonly string[]; onClose(): void; onCreated(v: Volume): void }) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const [name, setName] = useState('')
  const [labels, setLabels] = useState<{ id: string; key: string; value: string }[]>([])
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [srv, setSrv] = useState<Record<string, string>>({})
  const ref = useRef<HTMLInputElement>(null)
  const reset = () => { setName(''); setLabels([]); setTouched(false); setErr(null); setSrv({}) }
  // Al abrir se parte de un formulario limpio (ajuste de estado durante el render, sin efecto).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) { setWasOpen(open); if (open) reset() }

  const nameErr = validateVolumeName(name, existing)
  const labelErrs = labels.map((l, i) => (l.key ? validateLabelKey(l.key) ?? (labels.findIndex((x) => x.key === l.key) < i ? 'Clave repetida.' : null) : 'Escribe la clave.'))
  const submit = async () => {
    setTouched(true)
    if (nameErr || labelErrs.some(Boolean)) { ref.current?.focus(); return }
    setBusy(true)
    setErr(null)
    try {
      const v = await api.volumes.create({ name, labels: Object.fromEntries(labels.map((l) => [l.key, l.value])) })
      await store.getState().refresh('volumes')
      toast.ok(`Volumen ${safeText(v.name, { singleLine: true })} creado`)
      onCreated(v)
    } catch (e) {
      const m = apiErrorMessage(e)
      const p2 = parseFieldErrors(m.detail || m.title, ['name', 'labels'])
      setSrv(p2.fields)
      setErr(p2.rest || (Object.keys(p2.fields).length ? null : m.title))
      if (p2.fields.name) ref.current?.focus()
    } finally { setBusy(false) }
  }
  const shown = srv.name ?? (touched ? nameErr : null)
  return (
    <FormDialog open={open} onClose={onClose} title="Nuevo volumen" icon="database" submitLabel="Crear volumen" busy={busy} formError={err} initialFocus={ref} onSubmit={() => void submit()}
      description={<p>Un volumen guarda datos que sobreviven a los contenedores.</p>}>
      <div className="f-row">
        <label htmlFor="nvName">Nombre</label>
        <Input ref={ref} id="nvName" className="mono" value={name} autoComplete="off" spellCheck={false} aria-invalid={shown ? true : undefined} aria-describedby="nvErr" onChange={(e) => { setName(e.target.value); setSrv({}) }} onBlur={() => setTouched(true)} />
        {shown ? <span className="f-error" id="nvErr"><Icon name="alert" size="sm" />{shown}</span> : <span className="f-hint" id="nvErr">Letras, números, «_», «.» y «-».</span>}
      </div>
      <div className="f-row">
        <label htmlFor="nvDriver">Driver</label>
        <Select id="nvDriver" value="local" disabled aria-describedby="nvDrvHint"><option value="local">local</option></Select>
        <span className="f-hint" id="nvDrvHint">Otros drivers, más adelante.</span>
      </div>
      <div className="f-row">
        <span className="f-label" id="nvLabels">Etiquetas <span className="muted">(opcional)</span></span>
        {srv.labels ? <span className="f-error"><Icon name="alert" size="sm" />{srv.labels}</span> : null}
        {labels.map((l, i) => (
          <div className="rep two" key={l.id} role="group" aria-labelledby="nvLabels">
            <div><label className="sr-only" htmlFor={`nvK${i}`}>Clave de la etiqueta {i + 1}</label><Input id={`nvK${i}`} className="mono" value={l.key} placeholder="proyecto" aria-invalid={touched && labelErrs[i] ? true : undefined} aria-describedby={touched && labelErrs[i] ? `nvKE${i}` : undefined} onChange={(e) => setLabels((p) => p.map((x) => (x.id === l.id ? { ...x, key: e.target.value } : x)))} /></div>
            <div><label className="sr-only" htmlFor={`nvV${i}`}>Valor de la etiqueta {i + 1}</label><Input id={`nvV${i}`} className="mono" value={l.value} placeholder="valor" onChange={(e) => setLabels((p) => p.map((x) => (x.id === l.id ? { ...x, value: e.target.value } : x)))} /></div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Quitar etiqueta ${i + 1}`} onClick={() => setLabels((p) => p.filter((x) => x.id !== l.id))}><Icon name="x" /></Button>
            {touched && labelErrs[i] ? <span className="f-error" id={`nvKE${i}`} style={{ gridColumn: '1/-1' }}><Icon name="alert" size="sm" />{labelErrs[i]}</span> : null}
          </div>
        ))}
        {labels.length < MAX_LABELS ? <div><Button type="button" variant="secondary" size="sm" onClick={() => setLabels((p) => [...p, { id: uuidv7(), key: '', value: '' }])}><Icon name="plus" size="sm" />Añadir etiqueta</Button></div> : <span className="f-hint">Máximo {MAX_LABELS} etiquetas.</span>}
      </div>
    </FormDialog>
  )
}
