// Tooltip (Base UI) con el aspecto `.tip` de la plantilla. UN solo TooltipProvider en la raíz (providers.tsx).
// Contrato: <Tooltip label="Detener" side="top" disabled?>{<Button …/>}</Tooltip>  (el hijo es el disparador: se le funde el aria)
//   Riel del sidebar: side="right", delay 0; pie/acciones: side="top".
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

const TooltipProvider = TooltipPrimitive.Provider

function Tooltip({ label, side = 'top', disabled, delay = 300, children }: { label: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; disabled?: boolean; delay?: number; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root disabled={disabled}>
      <TooltipPrimitive.Trigger render={children} delay={delay} closeDelay={0} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={side === 'right' ? 10 : 6} className="tip-pos">
          <TooltipPrimitive.Popup className="tip">{label}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip, TooltipProvider }
