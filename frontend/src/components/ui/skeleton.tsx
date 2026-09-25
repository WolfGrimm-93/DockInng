import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/** Barra de carga con el shimmer de la plantilla. Ancho/alto por `style` o clases. */
function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden="true" data-slot="skeleton" className={cn("skeleton", className)} {...props} />
}

export { Skeleton }
