// GUARDA DE NAVEGACIÓN por hash, ANTES del router. Un listener de hashchange en fase de captura sobre `window` se ejecuta antes que el de
// useHashRoute (useSyncExternalStore): si hay un bloqueador activo, detiene el evento (el router ni se entera), restaura el hash previo y
// pregunta; si el usuario acepta, navega al destino. Cubre enlaces, sidebar, location.hash y el botón Atrás/Adelante (popstate -> hashchange).
// (Limitación: restaurar el hash deja una entrada extra en el historial.) Contrato: registerNavBlocker(fn) -> unregister; fn() -> Promise<boolean> (true = dejar salir).
type Blocker = () => Promise<boolean>

const blockers = new Set<Blocker>()
let current = typeof window !== 'undefined' ? window.location.hash : ''
let restoring = false
let asking = false
let bypass = false

/** Registra un bloqueador; devuelve la función que lo retira. */
export function registerNavBlocker(fn: Blocker): () => void {
  blockers.add(fn)
  return () => { blockers.delete(fn) }
}

function onHashChange(e: Event): void {
  const next = window.location.hash
  if (restoring) { restoring = false; current = next; return }
  if (bypass) { bypass = false; current = next; return } // el usuario ya aceptó salir
  const blocker = blockers.values().next().value as Blocker | undefined
  if (!blocker) { current = next; return }
  e.stopImmediatePropagation() // el router no ve la navegación bloqueada
  if (asking) { restoring = true; window.location.hash = current; return }
  asking = true
  restoring = true
  window.location.hash = current
  void blocker().then((leave) => {
    asking = false
    if (leave) { bypass = true; window.location.hash = next }
  }, () => { asking = false })
}

if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange, true)
