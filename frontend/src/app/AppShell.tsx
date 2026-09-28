// AppShell: sidebar flotante + <main> (sin barra superior; cada vista trae su PageHeader). Responsabilidades:
//   - enrutado (PAGES[route.id]) y foco al <h1 id="viewTitle"> en cada cambio de ruta (no en el primer render);
//   - document.title = `${TITLES[ruta]} · DockInng`; skip link; quitar `no-anim` tras dos rAF (sin animar el primer pintado);
//   - vista previa por vista (?state=empty|loading) se limpia al cambiar de ruta;
//   - parámetros de plantilla globales en modo simulado/DEV: ?dialog=blocked|palette, ?toast=1, ?policy=denied, ?menu=1.
import { Suspense, useEffect, useRef, useState } from 'react'
import { FloatingSidebar } from '@/components/shell/FloatingSidebar'
import { WindowChrome } from '@/components/shell/WindowChrome'
import { useBlockedDialog } from '@/components/shared/confirmApi'
import { policyDenied, toast } from '@/lib/toastStore'
import { startNotifications } from '@/data/notifications'
import { useShellPrefs } from '@/data/shellPrefs'
import { useEngineApi, useEngineStoreApi, useNavCounts } from '@/data/store/hooks'
import { getDevFlags, devFlagsEnabled, setPreviewState } from './devFlags'
import { PageFallback } from './PageFallback'
import { PAGES } from './pages'
import { NAV, NAV_OF, TITLES } from './routes'
import { useUiStore } from './uiStore'
import { useQuitGuard } from './quitGuard'
import { useHashRoute } from './useHashRoute'

// StrictMode ejecuta los efectos dos veces en desarrollo: los parámetros de arranque se aplican una sola vez.
let startupApplied = false

/** Se monta DENTRO del Suspense, tras la página (que puede ser un chunk lazy): enfoca el <h1> cuando ya existe. */
function FocusTitle() {
  useEffect(() => {
    document.getElementById('viewTitle')?.focus({ preventScroll: true })
  }, [])
  return null
}

export function AppShell() {
  const route = useHashRoute()
  const api = useEngineApi()
  const engineStore = useEngineStoreApi()
  const counts = useNavCounts()
  const blocked = useBlockedDialog()
  const collapsed = useUiStore((s) => s.collapsed)
  const setCollapsed = useUiStore((s) => s.setCollapsed)
  const mainRef = useRef<HTMLElement>(null)
  // Ruta anterior (no un booleano): robusto ante el doble montaje de StrictMode. El foco al <h1> y la limpieza de la vista previa
  // ocurren SOLO al cambiar de vista, nunca en la carga inicial.
  const prevId = useRef(route.id)
  const [focusFor, setFocusFor] = useState<string | null>(null)
  const Page = PAGES[route.id]
  useQuitGuard()
  // Ola 3: preferencias de ventana/bandeja/avisos y reglas de notificación (nativas; el backend decide si mostrarlas según el foco).
  useEffect(() => { void useShellPrefs.getState().load(api) }, [api])
  useEffect(() => startNotifications(api, engineStore), [api, engineStore])

  useEffect(() => {
    document.title = `${TITLES[route.id]} · DockInng`
    if (prevId.current === route.id) return
    prevId.current = route.id
    setPreviewState(null)
    setFocusFor(route.id)
  }, [route.id])

  useEffect(() => {
    // Sin transiciones en el primer pintado (evita la animación 216→64 px).
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('no-anim')))
    if (startupApplied || !devFlagsEnabled(api)) return
    startupApplied = true
    const f = getDevFlags()
    if (f.menu) useUiStore.getState().openCtxMenu(true)
    if (f.dialog === 'blocked') void blocked()
    if (f.dialog === 'palette') useUiStore.getState().openPalette(true)
    if (f.toast) {
      toast.ok('tienda-api-1 reiniciado')
      toast.err('No se pudo eliminar la red', { sub: 'La red «tienda_default» tiene contenedores conectados.' })
    }
    if (f.policy === 'denied') policyDenied('Eliminar contenedor', 'La política del motor exigió una confirmación que la interfaz no pidió. Es un fallo de la aplicación, no tuyo.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
    <WindowChrome />
    <div className="shell" id="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus() }}>Saltar al contenido</a>
      <FloatingSidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(!collapsed)}
        nav={NAV}
        counts={counts}
        current={NAV_OF[route.id]}
        onOpenPalette={() => useUiStore.getState().openPalette(true)}
      />
      <main className="main" id="main" tabIndex={-1} ref={mainRef}>
        <div className="view" key={route.id}>
          <Suspense fallback={<PageFallback />}>
            <Page />
            {focusFor === route.id ? <FocusTitle /> : null}
          </Suspense>
        </div>
      </main>
    </div>
    </>
  )
}
