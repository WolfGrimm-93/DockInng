// API de confirmaciones (tipos, contexto y hooks) separada de ConfirmDialog.tsx: un archivo de componentes solo exporta componentes.
// Contratos completos en ConfirmDialog.tsx (cabecera). `ConfirmProvider` (ConfirmDialog.tsx) es quien provee `Ctx`.
import { createContext, useContext, type ReactNode } from 'react'
import type { IconName } from './iconNames'

export interface ConfirmRequest {
  level: 'confirm' | 'confirm_typed'
  title: string
  description: ReactNode
  extra?: ReactNode
  levelNote?: ReactNode
  okLabel: string
  okIcon?: IconName
  /** Texto del botón de cancelar (por defecto «Cancelar»). */
  cancelLabel?: string
  /** Tercera opción (p. ej. «Guardar y salir»): con ella `confirm` devuelve 'ok' | 'alt' | 'cancel'. */
  alt?: { label: string; icon?: IconName }
  /** Obligatorio si level = 'confirm_typed': texto que hay que escribir (nombre o 'ELIMINAR'). */
  typed?: string
}
export interface BlockedRequest { title?: string; description?: ReactNode; bullets?: string[] }

export type ConfirmFn = {
  (req: ConfirmRequest & { alt: NonNullable<ConfirmRequest['alt']> }): Promise<'ok' | 'alt' | 'cancel'>
  (req: ConfirmRequest): Promise<boolean>
}
export interface ConfirmApi { confirm: ConfirmFn; blocked(req?: BlockedRequest): Promise<void> }
export const Ctx = createContext<ConfirmApi | null>(null)

/**
 * Confirmación escrita: exacta, sensible a mayúsculas y con trim de espacios del INPUT (criterio del backend: `typed.trim() == expected`).
 * Un `expected` vacío NUNCA habilita el botón. El texto esperado es el `expected` del PlanDecision (no se asume «ELIMINAR»).
 */
export const typedMatches = (input: string, expected: string): boolean => expected.length > 0 && input.trim() === expected

export function useCtx(): ConfirmApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('ConfirmProvider ausente.')
  return c
}
export const useConfirm = (): ConfirmApi['confirm'] => useCtx().confirm
export const useBlockedDialog = (): ConfirmApi['blocked'] => useCtx().blocked

