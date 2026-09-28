// Flujo destructivo guardado por la política del backend (plan -> diálogo -> execute). Separado de ConfirmDialog.tsx (solo componentes allí).
import { useCallback } from 'react'
import { apiErrorMessage, toApiError } from '@/data/errors'
import { useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { ActionOutcome, ActionPlan, ActionRequest, ApiError, PlanDecision } from '@/data/types'
import { policyDenied, toast } from '@/lib/toastStore'
import { useCtx } from './confirmApi'
import { RemoteNote } from './ConfirmDialog'
import { describePlan, type PlanDescription } from './planDescribe'

export type GuardedResult =
  | { status: 'done'; plan: ActionPlan; outcome: ActionOutcome }
  | { status: 'allowed'; plan: ActionPlan }
  | { status: 'cancelled' }
  | { status: 'blocked' }
  | { status: 'error'; error: ApiError }

export type GuardedDescribe = (plan: ActionPlan) => PlanDescription

const LABEL: Record<ActionRequest['type'], string> = {
  remove_containers: 'Eliminar contenedores', remove_image: 'Eliminar imagen', prune_images: 'Eliminar imágenes sin usar', remove_volume: 'Eliminar volumen',
  prune_volumes: 'Eliminar volúmenes sin usar', remove_network: 'Eliminar red', stack_down: 'Bajar stack', stack_delete: 'Eliminar stack', prune_system: 'Limpiar todo el sistema', cleanup: 'Limpiar recursos sin usar',
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
      // Conexión remota activa: el diálogo la nombra SIEMPRE (evita borrar en el servidor equivocado creyendo que es el equipo local).
      const st = storeApi.getState()
      const active = st.profiles.find((p) => p.id === st.activeProfileId)
      // B-6: borrar los archivos de un stack propio es LOCAL (no se ejecuta en el equipo remoto): no lleva el aviso.
      const description = active?.remote && request.type !== 'stack_delete' ? <><RemoteNote name={active.name} target={active.target} />{d.description}</> : d.description
      const ok = await confirm({
        level: decision.type === 'confirm_typed' ? 'confirm_typed' : 'confirm',
        title: d.title, description, extra: d.extra, levelNote: d.levelNote, okLabel: d.okLabel, okIcon: d.okIcon,
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
