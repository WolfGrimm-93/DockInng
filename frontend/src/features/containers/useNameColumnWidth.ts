// Ancho ajustable de la columna «Nombre» de la tabla de contenedores. Sin valor guardado = automático (comportamiento de siempre:
// el Nombre absorbe el sobrante). Con valor: `--name-w` en px (200–640) sobre `.table-wrap.name-fixed` y una columna de relleno absorbe el resto.
// Se guarda en `safeStorage` (no en las prefs del backend: su lista blanca obligaría a tocar Rust). Cualquier valor corrupto = automático.
import { useCallback, useState, type RefObject } from 'react'
import { safeStorage } from '@/lib/safeStorage'

export const NAME_W_KEY = 'dockinng.containers.nameW.v1'
export const NAME_W_MIN = 200
export const NAME_W_MAX = 640

export const clampNameWidth = (w: number): number => Math.min(NAME_W_MAX, Math.max(NAME_W_MIN, Math.round(w)))

/** Valida lo guardado: número finito dentro del rango; cualquier otra cosa = `null` (automático). */
export function parseNameWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= NAME_W_MIN && n <= NAME_W_MAX ? Math.round(n) : null
}

export interface NameColumnWidth {
  /** Ancho fijado por el usuario en px; `null` = automático. */
  width: number | null
  /** Aplica el ancho SOLO al DOM (arrastre en curso). */
  preview(w: number | null): void
  /** Fija el ancho (estado + guardado). `null` restablece el automático. */
  commit(w: number | null): void
}

/** `wrapRef` = el `.table-wrap`: permite aplicar el ancho solo al DOM (sin re-renderizar la tabla) mientras se arrastra. */
export function useNameColumnWidth(wrapRef: RefObject<HTMLDivElement | null>): NameColumnWidth {
  const [width, setWidth] = useState<number | null>(() => parseNameWidth(safeStorage().getItem(NAME_W_KEY)))
  const preview = useCallback((w: number | null) => {
    const el = wrapRef.current
    if (!el) return
    el.classList.toggle('name-fixed', w !== null)
    if (w === null) el.style.removeProperty('--name-w')
    else el.style.setProperty('--name-w', `${clampNameWidth(w)}px`)
  }, [wrapRef])
  const commit = useCallback((w: number | null) => {
    const v = w === null ? null : clampNameWidth(w)
    setWidth(v)
    try { if (v === null) safeStorage().removeItem(NAME_W_KEY); else safeStorage().setItem(NAME_W_KEY, String(v)) } catch { /* sin almacenamiento */ }
  }, [])
  return { width, preview, commit }
}
