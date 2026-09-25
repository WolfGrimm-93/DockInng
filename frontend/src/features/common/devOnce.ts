// Parámetros de arranque de la plantilla (?sel= ?dialog= …): se aplican UNA sola vez por sesión y solo en modo
// simulado/DEV (getDevFlags ya viene vacío en producción real). Contrato: useStartupOnce(key, ready, fn).
import { useEffect } from 'react'

const done = new Set<string>()

export function useStartupOnce(key: string, ready: boolean, fn: () => void): void {
  useEffect(() => {
    if (!ready || done.has(key)) return
    done.add(key)
    fn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key])
}

/** Solo para tests: reinicia los «una sola vez». */
export function resetStartupOnce(): void {
  done.clear()
}
