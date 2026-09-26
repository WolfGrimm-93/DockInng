// Guarda de cambios sin guardar del editor.
//  - Navegación por hash (sidebar, enlaces, location.hash, Atrás): bloqueador registrado en app/navGuard, que actúa ANTES del router;
//    ofrece «Guardar y salir» / «Descartar cambios» / «Seguir editando». El editor sigue montado con su texto mientras se decide.
//  - beforeunload: cerrar o recargar la ventana pide confirmación (también protege el texto sin guardar).
import { useEffect, useRef } from 'react'
import { registerNavBlocker } from '@/app/navGuard'
import { useConfirm } from '@/components/shared/ConfirmDialog'

export function useUnsavedGuard(dirty: boolean, opts: { onSave?: () => Promise<boolean>; title?: string; description?: string } = {}): void {
  const confirm = useConfirm()
  const dirtyRef = useRef(dirty)
  const o = useRef(opts)
  useEffect(() => { dirtyRef.current = dirty; o.current = opts })

  useEffect(() => {
    if (!dirty) return
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBefore)
    const off = registerNavBlocker(async () => {
      if (!dirtyRef.current) return true
      const r = await confirm({
        level: 'confirm',
        title: o.current.title ?? 'Hay cambios sin guardar',
        description: o.current.description ?? 'Si sales ahora, se perderán los cambios de compose.yaml y .env.',
        levelNote: <>Puedes guardar antes de salir o seguir editando.</>,
        okLabel: 'Descartar cambios', okIcon: 'x', cancelLabel: 'Seguir editando',
        alt: { label: 'Guardar y salir', icon: 'check' },
      })
      if (r === 'alt') return (await o.current.onSave?.()) ?? false // sin onSave, «Guardar y salir» no sale
      return r === 'ok'
    })
    return () => { window.removeEventListener('beforeunload', onBefore); off() }
  }, [dirty, confirm])
}
