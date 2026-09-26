// Validación en vivo del editor: capa LOCAL instantánea (lib/yamlCheck) + `docker compose config` del backend con debounce de 600 ms.
// Una respuesta tardía de un texto anterior se ignora (bandera `stale` por ejecución del efecto). Se cancela al desmontar.
// Contrato: useStackValidation({name, yaml, env, enabled}) -> { diags, status: 'validating'|'ready'|'unavailable', unavailableReason, services, risks, hasErrors, summary }
import { useEffect, useMemo, useState } from 'react'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi } from '@/data/store/hooks'
import type { StackRisk, ValidationIssue } from '@/data/types'
import { mergeDiagnostics, summarizeDiagnostics, type Diag } from '@/lib/composeDiag'
import { validateCompose } from '@/lib/yamlCheck'

export const VALIDATE_DEBOUNCE_MS = 600

interface Remote { key: string; status: 'ready' | 'unavailable'; issues: ValidationIssue[] | null; services: string[] | null; risks: StackRisk[]; reason: string | null }

export function useStackValidation({ name, yaml, env, enabled, disabledReason }: { name: string | null; yaml: string; env: string; enabled: boolean; /** Por qué no se valida con Compose (por defecto: Compose ausente). */ disabledReason?: string }) {
  const api = useEngineApi()
  const local = useMemo(() => validateCompose(yaml, env), [yaml, env])
  const [remote, setRemote] = useState<Remote | null>(null)
  const key = `${name ?? ''}\u0000${yaml}\u0000${env}`

  useEffect(() => {
    if (!enabled) return
    // Cada ejecución del efecto es «la petición más reciente»: al cambiar el texto o desmontar, `stale` invalida la respuesta tardía.
    let stale = false
    const t = setTimeout(() => {
      api.stacks.validate(name, yaml, env).then(
        (v) => { if (!stale) setRemote({ key, status: 'ready', issues: v.issues, services: v.services, risks: v.risks, reason: null }) },
        (e) => {
          if (stale) return
          const m = apiErrorMessage(e)
          setRemote({ key, status: 'unavailable', issues: null, services: null, risks: [], reason: m.detail || m.title })
        },
      )
    }, VALIDATE_DEBOUNCE_MS)
    return () => { stale = true; clearTimeout(t) }
  }, [api, name, yaml, env, enabled, key])

  // Estado derivado: solo cuenta la respuesta que corresponde al texto actual; mientras tanto, «validando».
  const current = remote && remote.key === key ? remote : null
  const status: 'validating' | 'ready' | 'unavailable' = !enabled ? 'unavailable' : current ? current.status : 'validating'
  const reason = !enabled ? (disabledReason ?? 'Docker Compose no está instalado') : current?.reason ?? null
  const ready = current?.status === 'ready' ? current : null
  const diags: Diag[] = useMemo(() => mergeDiagnostics(local, ready ? ready.issues : null), [local, ready])
  const localServices = Number((/: (\d+) servicios/.exec(local.list[0]?.msg ?? '') ?? [])[1] ?? NaN)
  const services = ready ? (ready.services?.length ?? 0) : Number.isFinite(localServices) ? localServices : null
  return {
    diags,
    status,
    unavailableReason: reason,
    services,
    risks: ready?.risks ?? [],
    hasErrors: diags.some((d) => d.level === 'error'),
    summary: summarizeDiagnostics(diags, services),
  }
}
