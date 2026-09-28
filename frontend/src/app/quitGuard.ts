// Cierre controlado: el backend NO cierra si hay operaciones en curso (stacks, descargas, builds, terminales); emite `app://quit-requested`
// con el resumen. Aquí se muestra el ConfirmDialog: «Salir» responde `quit_app(true)`; cancelar NO llama al backend (`quit_app(false)` es una
// petición de salida y volvería a emitir el aviso: bucle).
import { createElement, useEffect, useRef } from 'react'
import { useConfirm } from '@/components/shared/confirmApi'
import { useEngineApi } from '@/data/store/hooks'
import type { BusySummary } from '@/data/types'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Líneas legibles de lo que se perdería al salir (solo las que tienen algo en curso). */
export function busyLines(b: BusySummary): string[] {
  const out: string[] = []
  if (b.stacks) out.push(`${plural(b.stacks, 'operación de stack', 'operaciones de stack')} (up, down, reinicio…)`)
  if (b.pulls) out.push(`${plural(b.pulls, 'descarga de imagen', 'descargas de imágenes')}`)
  if (b.builds) out.push(`${plural(b.builds, 'construcción de imagen', 'construcciones de imagen')}`)
  if (b.terminals) out.push(`${plural(b.terminals, 'terminal abierta', 'terminales abiertas')}`)
  return out
}

export function useQuitGuard(): void {
  const api = useEngineApi()
  const confirm = useConfirm()
  const asking = useRef(false)
  useEffect(() => {
    const off = api.window.onQuitRequested((summary) => {
      if (asking.current) return
      asking.current = true
      const lines = busyLines(summary)
      void confirm({
        level: 'confirm',
        title: '¿Salir de DockInng?',
        description: createElement('span', null, lines.length ? 'Hay operaciones en curso que se interrumpirán al salir:' : 'La aplicación se cerrará.'),
        extra: lines.length ? createElement('ul', { className: 'quit-list' }, lines.map((l) => createElement('li', { key: l }, l))) : undefined,
        okLabel: 'Salir',
        okIcon: 'x',
        cancelLabel: 'Seguir en DockInng',
      })
        .then((ok) => (ok ? api.window.quitApp(true) : undefined))
        .catch(() => {})
        .finally(() => { asking.current = false })
    })
    return off
  }, [api, confirm])
}
