// PageHeader: patrón único de encabezado (título + contador | secundarias | primaria; «volver» opcional encima).
// Contrato: <PageHeader title count? back={{href,label}}? secondary? primary? simulated? />
//   El <h1 id="viewTitle" tabIndex=-1> recibe el foco al cambiar de ruta (AppShell). Clases: .view-head .view-title .view-actions.
import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { SimulatedTag } from './StateViews'

export interface PageHeaderProps {
  title: string
  count?: string | number | null
  back?: { href: string; label: string }
  secondary?: ReactNode
  primary?: ReactNode
  /** Muestra <SimulatedTag/> «No conectado aún» junto al título. */
  simulated?: boolean
}

export function PageHeader({ title, count, back, secondary, primary, simulated }: PageHeaderProps) {
  return (
    <header className="view-head">
      {back ? (
        <div style={{ width: '100%' }}>
          <a className="crumb" href={back.href}>
            <Icon name="back" size="sm" />
            {back.label}
          </a>
        </div>
      ) : null}
      <div className="view-title">
        <h1 tabIndex={-1} id="viewTitle">{title}</h1>
        {count != null ? <span className="count">{count}</span> : null}
        {simulated ? <SimulatedTag /> : null}
      </div>
      <div className="view-actions">
        {secondary}
        {primary}
      </div>
    </header>
  )
}
