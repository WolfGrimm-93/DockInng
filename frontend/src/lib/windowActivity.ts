// Actividad de la ventana (foco/visibilidad) para bajar el gasto cuando nadie mira la app.
//   - Pone/quita la clase `window-blurred` en <html> (el CSS pausa las animaciones infinitas con ella).
//   - Expone `isIdle()` (sin foco durante más de `BLUR_GRACE_MS` o pestaña oculta) y `onWake(cb)` (vuelve el foco/visibilidad: refrescar ya).
// El estado inicial es «con foco»: `document.hasFocus()` no es fiable al arrancar en algunos webviews; los eventos lo corrigen.
export const BLUR_GRACE_MS = 10_000

type Listener = () => void
let installed = false
let blurredAt: number | null = null
const wake = new Set<Listener>()

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'
const setClass = (on: boolean): void => {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('window-blurred', on)
}

function onBlur(): void {
  if (blurredAt === null) blurredAt = Date.now()
  setClass(true)
}
function onFocus(): void {
  const wasIdle = blurredAt !== null && Date.now() - blurredAt >= BLUR_GRACE_MS
  blurredAt = null
  setClass(false)
  if (wasIdle) for (const cb of [...wake]) cb()
}
function onVisibility(): void {
  if (hidden()) onBlur()
  else onFocus()
}

/** Instala los listeners (idempotente). Se llama al crear el store y al montar la app. */
export function installWindowActivity(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)
}

/** Sin foco (o pestaña oculta) desde hace más que la gracia: el muestreo pasa a ritmo lento. */
export function isIdle(now: number = Date.now()): boolean {
  if (hidden()) return true
  return blurredAt !== null && now - blurredAt >= BLUR_GRACE_MS
}

/** Avisa al recuperar foco/visibilidad tras un periodo de inactividad. Devuelve la baja. */
export function onWake(cb: Listener): () => void {
  installWindowActivity()
  wake.add(cb)
  return () => { wake.delete(cb) }
}

/** Solo tests: restablece el estado interno. */
export function resetWindowActivity(): void {
  blurredAt = null
  setClass(false)
  wake.clear()
}
