// Toaster PROPIO (sin sonner/next-themes). Contrato: montar <Toaster/> una vez (providers); emitir con `toast`/`policyDenied`
// de '@/lib/toastStore' (re-exportados aquí). Pausa el temporizador con hover/foco; solo `err` usa role="alert"; el resto role="status".
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getToasts, subscribeToasts, toast, type ToastItem } from '@/lib/toastStore'
import { Icon } from './Icon'

export { toast, policyDenied } from '@/lib/toastStore'

function OverflowView({ t }: { t: ToastItem }) {
  return (
    <div className="toast warn" role="status">
      <span className="t-ico"><Icon name="warn" /></span>
      <div className="t-body">
        <b>{t.msg}</b>
        <small>Avisos anteriores sin mostrar.</small>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => toast.expandAll()}>Ver todas</button>
          <button className="btn btn-ghost btn-sm" onClick={() => toast.dismissHidden()}>Descartar</button>
        </div>
      </div>
    </div>
  )
}

function ToastView({ t }: { t: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stop = () => clearTimeout(timer.current)
  const start = () => {
    stop()
    if (!t.sticky) timer.current = setTimeout(() => toast.dismiss(t.id), t.kind === 'err' ? 8000 : 4500)
  }
  useEffect(() => {
    start()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id, t.count])
  return (
    <div className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'} onMouseEnter={stop} onFocus={stop} onMouseLeave={start} onBlur={start}>
      <span className="t-ico"><Icon name={t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'xcircle' : 'warn'} /></span>
      <div className="t-body">
        <b>{t.msg}{t.count > 1 ? ` ×${t.count}` : ''}</b>
        {t.sub ? <small>{t.sub}</small> : null}
      </div>
      <button className="close" aria-label="Cerrar aviso" onClick={() => toast.dismiss(t.id)}><Icon name="x" size="sm" /></button>
    </div>
  )
}

export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (t.overflow ? <OverflowView key={t.id} t={t} /> : <ToastView key={t.id} t={t} />))}
    </div>
  )
}
