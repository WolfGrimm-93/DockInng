// Button: base-nova (Base UI) parcheado para reproducir EXACTAMENTE los .btn de la plantilla.
// Contrato: <Button variant="default|primary|secondary|ghost|destructive|outline-destructive|blocked" size="default|sm|lg|icon|icon-sm" locked?>
//   - `default` = primary (relleno de marca; hover con color-mix, no /80).
//   - `destructive` = SÓLIDO (bg-destructive + texto destructive-foreground); `outline-destructive` = contorno.
//   - `locked` (conexión perdida): aria-disabled + .is-locked y se ignora el clic (no `disabled`: conserva el foco).
//   - Enlaces con aspecto de botón: <a className={buttonVariants({variant:'primary'})} href="#create">.
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva("btn", {
  variants: {
    variant: {
      default: "btn-primary",
      primary: "btn-primary",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      destructive: "btn-destructive",
      "outline-destructive": "btn-outline-destructive",
      blocked: "btn-secondary btn-blocked",
    },
    size: {
      default: "",
      sm: "btn-sm",
      lg: "h-[var(--h-lg)]",
      icon: "btn-icon",
      "icon-sm": "btn-icon btn-sm",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
})

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { locked?: boolean }

function Button({ className, variant, size, locked, onClick, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), locked && "is-locked", className)}
      aria-disabled={locked ? true : undefined}
      onClick={locked ? (e) => e.preventDefault() : onClick}
      {...props}
    />
  )
}

export { Button, buttonVariants }
