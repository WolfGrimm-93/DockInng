// Variantes de <Button> (cva). Separado de button.tsx: un archivo de componentes solo exporta componentes.
import { cva } from "class-variance-authority"

export const buttonVariants = cva("btn", {
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
