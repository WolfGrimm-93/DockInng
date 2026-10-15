// Diálogo «Nueva red» (create_network): nombre (duplicado contra el store), driver bridge, red interna, subred CIDR y puerta de enlace
// opcionales (validador puro lib/cidr, solapamiento con las subredes existentes). Errores del backend dentro del diálogo.
import { useRef, useState } from 'react'
import { FormDialog } from '@/components/shared/FormDialog'
import { Icon } from '@/components/shared/Icon'
import { Input, Select } from '@/components/ui/input'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { Network } from '@/data/types'
import { parseFieldErrors, validateGateway, validateNetworkName, validateSubnet } from '@/lib/resourceNames'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'

export function NewNetworkDialog({ open, existing, onClose, onCreated }: { open: boolean; existing: readonly Pick<Network, 'name' | 'subnets'>[]; onClose(): void; onCreated(n: Network): void }) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const [name, setName] = useState('')
  const [internal, setInternal] = useState(false)
  const [subnet, setSubnet] = useState('')
  const [gateway, setGateway] = useState('')
  const [touched, setTouched] = useState<Record<string, true>>({})
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [srv, setSrv] = useState<Record<string, string>>({})
  const ref = useRef<HTMLInputElement>(null)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setName(''); setInternal(false); setSubnet(''); setGateway(''); setTouched({}); setSubmitted(false); setErr(null); setSrv({}) }
  }

  const e = { name: validateNetworkName(name, existing.map((n) => n.name)), subnet: validateSubnet(subnet, existing), gateway: validateGateway(gateway, subnet) }
  const shown = (k: keyof typeof e) => srv[k] ?? (submitted || touched[k] ? e[k] : null)
  const t = (k: string) => setTouched((p) => ({ ...p, [k]: true }))
  const submit = async () => {
    setSubmitted(true)
    if (e.name || e.subnet || e.gateway) {
      const first = e.name ? '#nnName' : e.subnet ? '#nnSubnet' : '#nnGw'
      document.querySelector<HTMLElement>(first)?.focus()
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const n = await api.networks.create({ name, internal, subnet: subnet.trim() || null, gateway: gateway.trim() || null, labels: {} })
      await store.getState().refresh('networks')
      toast.ok(`Red ${safeText(n.name, { singleLine: true })} creada`)
      onCreated(n)
    } catch (x) {
      const m = apiErrorMessage(x)
      const p2 = parseFieldErrors(m.detail || m.title, ['name', 'subnet', 'gateway'])
      setSrv(p2.fields)
      setErr(p2.rest || (Object.keys(p2.fields).length ? null : m.title))
      const f = p2.fields.name ? '#nnName' : p2.fields.subnet ? '#nnSubnet' : p2.fields.gateway ? '#nnGw' : null
      if (f) document.querySelector<HTMLElement>(f)?.focus()
    } finally { setBusy(false) }
  }
  const field = (k: keyof typeof e, id: string, hint: string) => (shown(k) ? <span className="f-error" id={id}><Icon name="alert" size="sm" />{shown(k)}</span> : <span className="f-hint" id={id}>{hint}</span>)
  return (
    <FormDialog open={open} onClose={onClose} title="Nueva red" icon="network" submitLabel="Crear red" busy={busy} formError={err} initialFocus={ref} onSubmit={() => void submit()}
      description={<p>Los contenedores de una misma red se encuentran por nombre.</p>}>
      <div className="f-row">
        <label htmlFor="nnName">Nombre</label>
        <Input ref={ref} id="nnName" className="mono" value={name} autoComplete="off" spellCheck={false} aria-invalid={shown('name') ? true : undefined} aria-describedby="nnNameErr" onChange={(x) => { setName(x.target.value); setSrv({}) }} onBlur={() => t('name')} />
        {field('name', 'nnNameErr', 'Letras, números, «_», «.» y «-».')}
      </div>
      <div className="f-row">
        <label htmlFor="nnDriver">Driver</label>
        <Select id="nnDriver" value="bridge" disabled><option value="bridge">bridge</option></Select>
      </div>
      <label className="ro-check whitespace-normal" >
        <input type="checkbox" role="switch" checked={internal} onChange={(x) => setInternal(x.target.checked)} />
        <span>Red interna (sin salida a internet)</span>
      </label>
      <div className="f-row">
        <label htmlFor="nnSubnet">Subred (CIDR) <span className="muted">(opcional)</span></label>
        <Input id="nnSubnet" className="mono" value={subnet} autoComplete="off" spellCheck={false} placeholder="172.30.0.0/16" aria-invalid={shown('subnet') ? true : undefined} aria-describedby="nnSubnetErr" onChange={(x) => { setSubnet(x.target.value); setSrv({}) }} onBlur={() => t('subnet')} />
        {field('subnet', 'nnSubnetErr', 'Si lo dejas vacío, Docker elige una.')}
      </div>
      <div className="f-row">
        <label htmlFor="nnGw">Puerta de enlace <span className="muted">(opcional)</span></label>
        <Input id="nnGw" className="mono" value={gateway} autoComplete="off" spellCheck={false} placeholder="172.30.0.1" disabled={!subnet.trim()} aria-invalid={shown('gateway') ? true : undefined} aria-describedby="nnGwErr" onChange={(x) => { setGateway(x.target.value); setSrv({}) }} onBlur={() => t('gateway')} />
        {field('gateway', 'nnGwErr', subnet.trim() ? 'Debe estar dentro de la subred.' : 'Disponible al indicar una subred.')}
      </div>
    </FormDialog>
  )
}
