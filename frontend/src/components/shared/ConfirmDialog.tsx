// CONFIRMACIONES: un solo diálogo montado en providers, API por promesa. Contratos:
//   useConfirm(): (req: ConfirmRequest) => Promise<boolean>
//     ConfirmRequest { level:'confirm'|'confirm_typed'; title; description: ReactNode; extra?; levelNote?; okLabel; okIcon?; typed? }
//     - foco inicial = «Cancelar»; trampa de Tab (Base UI); Esc = false; clic fuera NO cierra.
//     - level 'confirm_typed': `typed` obligatorio (nombre o ELIMINAR); el botón queda disabled hasta que coincida (trim, sensible a mayúsculas).
//   useBlockedDialog(): (req?: { title?; description?; bullets? }) => Promise<void>   nivel Bloqueado: solo «Entendido»
//   useGuardedAction(): (request: ActionRequest, describe?) => Promise<GuardedResult>   plan → (diálogo) → execute (ver abajo)
//     GuardedResult = {status:'done', plan, outcome} | {status:'allowed', plan} | {status:'cancelled'} | {status:'blocked'} | {status:'error', error}
//     `describe(plan)` puede devolver textos propios; por defecto `describePlan` (paridad con askDelete* de la plantilla).
//   ConfirmProvider: montar dentro de EngineProvider y ToastProvider.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/dialog'
import { useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import { apiErrorMessage, toApiError } from '@/data/errors'
import type { ActionOutcome, ActionPlan, ActionRequest, ApiError, PlanDecision } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { policyDenied, toast } from '@/lib/toastStore'
import { Icon } from './Icon'
import type { IconName } from './iconNames'
import { LevelNote } from './LevelNote'
import { describePlan, type PlanDescription } from './planDescribe'

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

type Pending =
  | { kind: 'confirm'; req: ConfirmRequest; resolve(v: boolean | 'alt'): void }
  | { kind: 'blocked'; req: BlockedRequest; resolve(): void }

type ConfirmFn = {
  (req: ConfirmRequest & { alt: NonNullable<ConfirmRequest['alt']> }): Promise<'ok' | 'alt' | 'cancel'>
  (req: ConfirmRequest): Promise<boolean>
}
interface ConfirmApi { confirm: ConfirmFn; blocked(req?: BlockedRequest): Promise<void> }
const Ctx = createContext<ConfirmApi | null>(null)

/**
 * Confirmación escrita: exacta, sensible a mayúsculas y con trim de espacios del INPUT (criterio del backend: `typed.trim() == expected`).
 * Un `expected` vacío NUNCA habilita el botón. El texto esperado es el `expected` del PlanDecision (no se asume «ELIMINAR»).
 */
export const typedMatches = (input: string, expected: string): boolean => expected.length > 0 && input.trim() === expected

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [typedValue, setTypedValue] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef<Pending | null>(null)

  const open = useCallback((p: Pending | null) => {
    // Si ya había uno abierto, se cancela (nunca quedan promesas colgadas).
    const prev = pendingRef.current
    if (prev?.kind === 'confirm') prev.resolve(false)
    else if (prev) prev.resolve()
    pendingRef.current = p
    setTypedValue('')
    setPending(p)
  }, [])

  const api = useMemo<ConfirmApi>(
    () => ({
      // Con `alt` el resultado es 'ok' | 'alt' | 'cancel'; sin `alt`, boolean.
      confirm: ((req: ConfirmRequest) => new Promise<boolean | 'ok' | 'alt' | 'cancel'>((resolve) => open({ kind: 'confirm', req, resolve: (v) => resolve(req.alt ? (v === 'alt' ? 'alt' : v ? 'ok' : 'cancel') : v === true) }))) as ConfirmFn,
      blocked: (req = {}) => new Promise<void>((resolve) => open({ kind: 'blocked', req, resolve })),
    }),
    [open],
  )

  const close = (result?: boolean | 'alt') => {
    const p = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (!p) return
    if (p.kind === 'confirm') p.resolve(result === 'alt' ? 'alt' : !!result)
    else p.resolve()
  }

  const req = pending?.kind === 'confirm' ? pending.req : null
  const expected = req?.level === 'confirm_typed' ? (req.typed ?? '') : null
  const okDisabled = expected !== null && !typedMatches(typedValue, expected)

  return (
    <Ctx.Provider value={api}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o) close(false) }}>
        <AlertDialogContent initialFocus={cancelRef}>
          {pending?.kind === 'confirm' && req ? (
            <>
              <div className="dlg-body">
                <span className="dlg-ico danger"><Icon name="trash" size="lg" /></span>
                <div>
                  <AlertDialogTitle>{safeText(req.title, { singleLine: true })}</AlertDialogTitle>
                  <AlertDialogDescription render={<div id="dcDesc" />}>{req.description}</AlertDialogDescription>
                  {req.extra}
                  {expected !== null ? (
                    <div className="typed">
                      <label htmlFor="dcTyped">
                        Para confirmar, escribe <b className="mono typed-exp" title={expected}>{safeText(expected, { singleLine: true })}</b>
                      </label>
                      {expected.length > 24 ? (
                          <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} aria-label="Copiar el texto de confirmación" onClick={() => void navigator.clipboard?.writeText(expected).catch(() => undefined)}>
                            <Icon name="copy" size="sm" />Copiar
                          </button>
                        ) : null}
                      <input
                        className="input"
                        id="dcTyped"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="dcDesc"
                        value={typedValue}
                        onChange={(e) => setTypedValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !okDisabled) { e.preventDefault(); close(true) } }}
                      />
                    </div>
                  ) : null}
                  <LevelNote>
                    {req.levelNote ?? (req.level === 'confirm_typed'
                      ? <><b>Nivel Confirmar con nombre.</b> Escribe el texto indicado para continuar.</>
                      : <><b>Nivel Confirmar.</b> Esta acción no se puede deshacer.</>)}
                  </LevelNote>
                </div>
              </div>
              <div className="dlg-foot">
                <Button ref={cancelRef} variant="secondary" onClick={() => close(false)}>{req.cancelLabel ?? 'Cancelar'}</Button>
                {req.alt ? <Button variant="primary" onClick={() => close('alt')}><Icon name={req.alt.icon ?? 'check'} /><span>{req.alt.label}</span></Button> : null}
                <Button variant="destructive" disabled={okDisabled} onClick={() => close(true)}>
                  <Icon name={req.okIcon ?? 'trash'} />
                  <span>{req.okLabel}</span>
                </Button>
              </div>
            </>
          ) : pending?.kind === 'blocked' ? (
            <>
              <div className="dlg-body">
                <span className="dlg-ico blocked"><Icon name="ban" size="lg" /></span>
                <div>
                  <AlertDialogTitle>{pending.req.title ?? 'Limpiar todo el sistema está bloqueado'}</AlertDialogTitle>
                  <AlertDialogDescription render={<div />}>
                    {pending.req.description ?? (
                      <p>DockInng no ejecuta esta acción, ni siquiera con confirmación. Borraría contenedores detenidos, redes, imágenes sin usar y caché de compilación de una sola vez.</p>
                    )}
                  </AlertDialogDescription>
                  <ul>
                    {(pending.req.bullets ?? [
                      'Para limpiar por partes: elimina imágenes o volúmenes sin usar desde sus vistas, con confirmación.',
                      'Si de verdad lo necesitas, ejecútalo tú mismo en una terminal.',
                    ]).map((b) => <li key={b}>{b}</li>)}
                  </ul>
                  <LevelNote icon="lock"><b>Nivel Bloqueado.</b> El motor de seguridad rechaza la acción antes de enviarla a Docker.</LevelNote>
                </div>
              </div>
              <div className="dlg-foot">
                <Button ref={cancelRef} variant="secondary" onClick={() => close()}>Entendido</Button>
              </div>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  )
}

function useCtx(): ConfirmApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('ConfirmProvider ausente.')
  return c
}
export const useConfirm = (): ConfirmApi['confirm'] => useCtx().confirm
export const useBlockedDialog = (): ConfirmApi['blocked'] => useCtx().blocked

export type GuardedResult =
  | { status: 'done'; plan: ActionPlan; outcome: ActionOutcome }
  | { status: 'allowed'; plan: ActionPlan }
  | { status: 'cancelled' }
  | { status: 'blocked' }
  | { status: 'error'; error: ApiError }

export type GuardedDescribe = (plan: ActionPlan) => PlanDescription

const LABEL: Record<ActionRequest['type'], string> = {
  remove_containers: 'Eliminar contenedores', remove_image: 'Eliminar imagen', prune_images: 'Eliminar imágenes sin usar', remove_volume: 'Eliminar volumen',
  prune_volumes: 'Eliminar volúmenes sin usar', remove_network: 'Eliminar red', stack_down: 'Bajar stack', stack_delete: 'Eliminar stack', prune_system: 'Limpiar todo el sistema',
}

/**
 * Flujo destructivo completo (el frontend NUNCA calcula la decisión: la da el backend en el plan).
 * plan_action → allow: 'allowed' | confirm/confirm_typed: diálogo → execute_action(ticket, typed) | deny forbidden: BlockedDialog |
 * deny needs_confirmation_non_interactive: toast persistente (fallo de la app). Cancelar libera el ticket.
 */
export function useGuardedAction(): (request: ActionRequest, describe?: GuardedDescribe) => Promise<GuardedResult> {
  const api = useEngineApi()
  const storeApi = useEngineStoreApi()
  const { confirm, blocked } = useCtx()
  return useCallback(
    async (request, describe) => {
      if (storeApi.getState().connection.status !== 'connected') return { status: 'cancelled' }
      let plan: ActionPlan
      try {
        plan = await api.actions.plan(request)
      } catch (e) {
        const err = toApiError(e)
        const m = apiErrorMessage(err)
        toast.err(m.title, { sub: m.detail })
        return { status: 'error', error: err }
      }
      const decision: PlanDecision = plan.decision
      if (decision.type === 'deny') {
        if (decision.reason === 'forbidden') {
          await blocked(request.type === 'prune_system' ? {} : { title: `${LABEL[request.type]} está bloqueado`, bullets: [] })
        } else {
          policyDenied(LABEL[request.type], 'La política exigió una confirmación que la aplicación no puede pedir. Es un fallo de la aplicación, no tuyo.')
        }
        return { status: 'blocked' }
      }
      if (decision.type === 'allow' || !plan.ticket) return { status: 'allowed', plan }
      const d = (describe ?? ((p: ActionPlan) => describePlan(p, request)))(plan)
      const ok = await confirm({
        level: decision.type === 'confirm_typed' ? 'confirm_typed' : 'confirm',
        title: d.title, description: d.description, extra: d.extra, levelNote: d.levelNote, okLabel: d.okLabel, okIcon: d.okIcon,
        typed: decision.type === 'confirm_typed' ? decision.expected : undefined,
      })
      if (!ok) {
        void api.actions.cancel(plan.ticket).catch(() => undefined)
        return { status: 'cancelled' }
      }
      try {
        const outcome = await api.actions.execute(plan.ticket, decision.type === 'confirm_typed' ? decision.expected : null)
        if (outcome.succeeded.length) {
          const s = d.success?.(outcome) ?? { msg: `${outcome.succeeded.length} elemento(s) eliminado(s)` }
          toast.ok(s.msg, { sub: s.sub })
        }
        for (const f of outcome.failed.slice(0, 3)) {
          toast.err(`No se pudo eliminar ${f.item.name ?? f.item.id.slice(0, 12)}`, { sub: f.error.message })
        }
        return { status: 'done', plan, outcome }
      } catch (e) {
        const err = toApiError(e)
        if (err.code === 'policy_denied') policyDenied(LABEL[request.type], err.message)
        else {
          const m = apiErrorMessage(err)
          toast.err(m.title, { sub: m.detail })
        }
        return { status: 'error', error: err }
      }
    },
    [api, storeApi, confirm, blocked],
  )
}
