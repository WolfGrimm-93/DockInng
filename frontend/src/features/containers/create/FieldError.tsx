// Mensaje de error de un campo del formulario de creación (mismo marcado que el resto de formularios).
import { Icon } from '@/components/shared/Icon'

export function FieldError({ id, message, className }: { id: string; message: string | undefined; className?: string }) {
  if (!message) return null
  return <span className={className ? `f-error ${className}` : 'f-error'} id={id}><Icon name="alert" size="sm" />{message}</span>
}
