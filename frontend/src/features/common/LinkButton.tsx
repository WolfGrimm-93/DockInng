// Enlace con aspecto de botón (<a class="btn …">). Con `locked` (conexión perdida) queda aria-disabled y no navega.
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { buttonVariants } from '@/components/ui/buttonVariants'
import { cn } from '@/lib/utils'

export function LinkButton({ variant = 'secondary', size, locked, className, onClick, ...props }: ComponentProps<'a'> & VariantProps<typeof buttonVariants> & { locked?: boolean }) {
  return (
    <a
      className={cn(buttonVariants({ variant, size }), locked && 'is-locked', className)}
      aria-disabled={locked ? true : undefined}
      onClick={locked ? (e) => e.preventDefault() : onClick}
      {...props}
    />
  )
}
