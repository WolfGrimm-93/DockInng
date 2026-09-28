// Copiar al portapapeles con respaldo. 1) `navigator.clipboard.writeText` si existe (contexto seguro); 2) respaldo: <textarea readonly> fuera
// de pantalla + `document.execCommand('copy')` (WebKitGTK bajo `tauri://` puede no exponer la API moderna); 3) `false` => la UI avisa y
// muestra el texto para que se copie a mano. Nunca lanza.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* se prueba el respaldo */ }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.readOnly = true
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
    prev?.focus({ preventScroll: true })
  }
}
