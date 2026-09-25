// Diálogos (Base UI). Dos familias con el aspecto del <dialog> de la plantilla (.dlg-pop, borde 3xl, sombra dialog):
//   - AlertDialog*: confirmaciones (no se cierran con clic fuera; Esc sí). `initialFocus` = botón Cancelar/Entendido.
//   - Dialog*: paleta Ctrl+K (cierra con clic fuera y Esc).
import { AlertDialog as AlertPrimitive } from "@base-ui/react/alert-dialog"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useEffect, type KeyboardEvent, type RefObject } from "react"
import { cn } from "@/lib/utils"

/**
 * MODALIDAD REAL: (1) aria-modal="true"; (2) `inert` en #root mientras haya un diálogo montado (la página de fondo no recibe
 * foco, clics ni lector de pantalla); (3) trampa estricta de Tab / Shift+Tab dentro del popup. Base UI devuelve el foco al
 * elemento previo al cerrar (la inercia se quita en el efecto de limpieza, antes de esa devolución no hay foco que perder).
 */
const TABBABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
let openCount = 0

function ModalGuard() {
  useEffect(() => {
    const root = document.getElementById('root')
    openCount++
    if (root) root.inert = true
    return () => {
      openCount--
      if (root && openCount === 0) root.inert = false
    }
  }, [])
  return null
}

function trapTab(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return
  const box = e.currentTarget
  const items = Array.from(box.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.getClientRects().length > 0 || el === document.activeElement)
  if (!items.length) {
    e.preventDefault()
    box.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!box.contains(active) || (e.shiftKey && (active === first || active === box)) ) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

const AlertDialog = AlertPrimitive.Root
const AlertDialogTitle = AlertPrimitive.Title
const AlertDialogDescription = AlertPrimitive.Description

function AlertDialogContent({ className, initialFocus, ...props }: AlertPrimitive.Popup.Props & { initialFocus?: RefObject<HTMLElement | null> }) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Backdrop className="dlg-backdrop" />
      <AlertPrimitive.Popup className={cn("dlg-pop", className)} initialFocus={initialFocus} aria-modal="true" tabIndex={-1} onKeyDown={trapTab} {...props}>
        <ModalGuard />
        {props.children}
      </AlertPrimitive.Popup>
    </AlertPrimitive.Portal>
  )
}

const Dialog = DialogPrimitive.Root
const DialogTitle = DialogPrimitive.Title
const DialogDescription = DialogPrimitive.Description
function DialogContent({ className, initialFocus, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="dlg-backdrop" />
      <DialogPrimitive.Popup className={cn("dlg-pop", className)} initialFocus={initialFocus} aria-modal="true" tabIndex={-1} onKeyDown={trapTab} {...props}>
        <ModalGuard />
        {props.children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

export { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, Dialog, DialogContent, DialogTitle, DialogDescription }
