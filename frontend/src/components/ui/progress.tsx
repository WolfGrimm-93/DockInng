// Progress = `.progress` de la plantilla (6 px; `is-done` = --status-running). Con role=progressbar y valores ARIA.
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Progress({ value, label, className, indeterminate, ...props }: Omit<ComponentProps<"div">, "children"> & { value: number; label: string; /** Sin porcentaje conocido: barra animada y sin aria-valuenow. */ indeterminate?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : v}
      className={cn("progress", !indeterminate && v >= 100 && "is-done", indeterminate && "is-indeterminate", className)}
      {...props}
    >
      <i style={indeterminate ? undefined : { width: `${v}%` }} />
    </div>
  )
}

export { Progress }
