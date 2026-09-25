// Progress = `.progress` de la plantilla (6 px; `is-done` = --status-running). Con role=progressbar y valores ARIA.
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Progress({ value, label, className, ...props }: Omit<ComponentProps<"div">, "children"> & { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      className={cn("progress", v >= 100 && "is-done", className)}
      {...props}
    >
      <i style={{ width: `${v}%` }} />
    </div>
  )
}

export { Progress }
