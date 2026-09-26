// Diálogo con formulario (patrón de «Nuevo grupo»): AlertDialog de Base UI con <form>, foco inicial en el primer campo,
// Enter envía, Esc/Cancelar cierran, clic fuera NO cierra. Ocupado: campos y botón deshabilitados + aria-busy.
// Contrato: <FormDialog open onClose title description? icon? submitLabel submitIcon? busy? formError? onSubmit initialFocus>{campos}</FormDialog>
import type { FormEvent, ReactNode, RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/dialog'
import { Icon } from './Icon'
import type { IconName } from './iconNames'

export function FormDialog({ open, onClose, title, description, icon = 'plus', submitLabel, submitIcon = 'plus', busy, formError, onSubmit, initialFocus, children }: {
  open: boolean
  onClose(): void
  title: string
  description?: ReactNode
  icon?: IconName
  submitLabel: string
  submitIcon?: IconName
  busy?: boolean
  /** Error del backend: se muestra dentro del diálogo y NO lo cierra. */
  formError?: string | null
  onSubmit(): void
  initialFocus: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <AlertDialogContent initialFocus={initialFocus}>
        <form noValidate aria-busy={busy || undefined} onSubmit={(e: FormEvent) => { e.preventDefault(); if (!busy) onSubmit() }}>
          <div className="dlg-body">
            <span className="dlg-ico"><Icon name={icon} size="lg" /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription render={<div />}>{description}</AlertDialogDescription>
              <fieldset disabled={busy} className="dlg-fields">{children}</fieldset>
              {formError ? <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}><Icon name="alert" /><div><p>{formError}</p></div></div> : null}
            </div>
          </div>
          <div className="dlg-foot">
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={busy}><Icon name={busy ? 'loader' : submitIcon} spin={busy} />{submitLabel}</Button>
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
