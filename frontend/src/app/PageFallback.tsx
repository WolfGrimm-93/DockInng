// Esqueleto mientras carga el chunk de una vista (misma silueta que el encabezado + tabla de la plantilla).
import { SkeletonTable } from '@/components/shared/StateViews'

export function PageFallback() {
  return (
    <div aria-busy="true">
      <header className="view-head">
        <div className="view-title"><span className="skeleton w-40 h-5"  /></div>
      </header>
      <div className="view-body"><SkeletonTable cols={7} rows={8} /></div>
    </div>
  )
}
