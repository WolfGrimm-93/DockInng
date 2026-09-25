// Menú desplegable (Base UI Menu) con las clases `.menu/.menu-item/.menu-label` de la plantilla.
// El Positioner de Base UI (floating-ui) reemplaza al position:fixed manual: no se recorta con overflow.
// Contrato: <DropdownMenu open? onOpenChange?><DropdownMenuTrigger render={<button/>}/><DropdownMenuContent>
//   <DropdownMenuLabel/><DropdownMenuRadioGroup value onValueChange><DropdownMenuRadioItem value/></…><DropdownMenuSeparator/><DropdownMenuItem/></DropdownMenuContent>
import { Menu } from "@base-ui/react/menu"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

const DropdownMenu = Menu.Root
const DropdownMenuTrigger = Menu.Trigger
const DropdownMenuRadioGroup = Menu.RadioGroup

function DropdownMenuContent({ className, children, align = "start", side = "bottom" }: { className?: string; children: ReactNode; align?: "start" | "center" | "end"; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={6} collisionPadding={12} className="menu-pos">
        <Menu.Popup className={cn("menu", className)}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}
function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>
}
function DropdownMenuItem({ className, ...props }: Menu.Item.Props) {
  return <Menu.Item className={cn("menu-item", className)} {...props} />
}
function DropdownMenuRadioItem({ className, ...props }: Menu.RadioItem.Props) {
  return <Menu.RadioItem className={cn("menu-item", className)} {...props} />
}
function DropdownMenuSeparator() {
  return <Menu.Separator render={<hr />} />
}

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
}
