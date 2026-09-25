// Acceso SEGURO a localStorage (modo privado, almacenamiento bloqueado, SecurityError incluso al leer `window.localStorage`).
// Contrato: safeStorage() -> { getItem, setItem, removeItem } que NUNCA lanza; si el storage real no está disponible usa una
// memoria por sesión (los ajustes funcionan mientras la app está abierta y no se persisten).
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const mem = new Map<string, string>()
const memory: KV = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
}

/** Solo memoria (tests). */
export const memoryStorage = (): KV => memory
export const clearMemoryStorage = (): void => mem.clear()

export function safeStorage(): KV {
  return {
    getItem(k) {
      try { return window.localStorage.getItem(k) } catch { return memory.getItem(k) }
    },
    setItem(k, v) {
      try { window.localStorage.setItem(k, v) } catch { memory.setItem(k, v) }
    },
    removeItem(k) {
      try { window.localStorage.removeItem(k) } catch { memory.removeItem(k) }
    },
  }
}
