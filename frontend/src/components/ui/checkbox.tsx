// Checkbox y Switch NATIVOS con las clases de la plantilla (.check-box / .switch): accesibles de serie,
// `indeterminate` real (checkbox de «seleccionar todo») y foco visible. Deviación consciente de base-nova
// (Base UI Checkbox/Switch): la plantilla aprobada usa inputs nativos y así se garantiza el mismo píxel.
import { useEffect, useRef, type ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Checkbox({ className, indeterminate, ...props }: Omit<ComponentProps<"input">, "type"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" data-slot="checkbox" className={cn("check-box", className)} {...props} />
}

function Switch({ className, ...props }: Omit<ComponentProps<"input">, "type" | "role">) {
  return <input type="checkbox" role="switch" data-slot="switch" className={cn("switch", className)} {...props} />
}

export { Checkbox, Switch }
