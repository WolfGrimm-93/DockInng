// Campos de formulario = clases .input / .select / .textarea / .f-row de la plantilla (altura 32 px = --h-md).
// Foco: outline 2px --ring (opaco) + borde primary (regla `.input:focus-visible` de app.css); nunca ring/50.
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn("input", className)} {...props} />
}
function Select({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="select" className={cn("select", className)} {...props} />
}
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn("textarea", className)} {...props} />
}
function Label({ className, ...props }: ComponentProps<"label">) {
  return <label data-slot="label" className={className} {...props} />
}

export { Input, Select, Textarea, Label }
