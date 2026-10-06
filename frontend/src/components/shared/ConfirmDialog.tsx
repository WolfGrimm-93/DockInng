// CONFIRMACIONES: un solo diálogo montado en providers, API por promesa. Contratos:
//   useConfirm(): (req: ConfirmRequest) => Promise<boolean>
//     ConfirmRequest { level:'confirm'|'confirm_typed'; title; description: ReactNode; extra?; levelNote?; okLabel; okIcon?; typed? }
//     - foco inicial = «Cancelar»; trampa de Tab (Base UI); Esc = false; clic fuera NO cierra.
//     - level 'confirm_typed': `typed` obligatorio (nombre o ELIMINAR); el botón queda disabled hasta que coincida (trim, sensible a mayúsculas).
//   useBlockedDialog(): (req?: { title?; description?; bullets? }) => Promise<void>   nivel Bloqueado: solo «Entendido»
//   useGuardedAction(): (request: ActionRequest, describe?) => Promise<GuardedResult>   plan → (diálogo) → execute (ver ./useGuardedAction.tsx)
//     GuardedResult = {status:'done', plan, outcome} | {status:'allowed', plan} | {status:'cancelled'} | {status:'blocked'} | {status:'error', error}
//     `describe(plan)` puede devolver textos propios; por defecto `describePlan` (paridad con askDelete* de la plantilla).
//   ConfirmProvider: montar dentro de EngineProvider y ToastProvider. Los hooks y tipos viven en ./confirmApi.ts y ./useGuardedAction.tsx.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/dialog'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'
import { Icon } from './Icon'
import { LevelNote } from './LevelNote'
import { SafeName } from './SafeName'
import { Ctx, typedMatches, type BlockedRequest, type ConfirmApi, type ConfirmFn, type ConfirmRequest } from './confirmApi'

type Pending =
  | { kind: 'confirm'; req: ConfirmRequest; resolve(v: boolean | 'alt'): void }
  | { kind: 'blocked'; req: BlockedRequest; resolve(): void }

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
                          <Button type="button" variant="ghost" size="sm" className="justify-self-start" aria-label="Copiar el texto de confirmación" onClick={() => void copiarTexto(expected)}>
                            <Icon name="copy" size="sm" />Copiar
                          </Button>
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
                  <AlertDialogTitle>{pending.req.title ?? 'Acción bloqueada'}</AlertDialogTitle>
                  <AlertDialogDescription render={<div />}>
                    {pending.req.description ?? <p>DockInng no ejecuta esta acción: el motor de seguridad la rechaza.</p>}
                  </AlertDialogDescription>
                  {pending.req.bullets?.length ? (
                    <ul>{pending.req.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
                  ) : null}
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

/** Copia al portapapeles y avisa del resultado (antes un fallo se tragaba en silencio). */
async function copiarTexto(texto: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('El portapapeles no está disponible en este entorno.')
    await navigator.clipboard.writeText(texto)
    toast.ok('Texto copiado')
  } catch (e) {
    toast.err('No se pudo copiar el texto', { sub: e instanceof Error ? e.message : undefined })
  }
}

/** Aviso de que la acción se ejecutará en un equipo REMOTO (no en el local). */
export function RemoteNote({ name, target }: { name: string; target: string }) {
  return (
    <div className="dlg-warn dlg-remote" role="note">
      <Icon name="server" size="sm" />
      <span>Conexión remota: <b><SafeName>{name}</SafeName></b> <span className="muted">({safeText(target, { singleLine: true })})</span>. Esta acción se ejecuta en ese equipo, no en el tuyo.</span>
    </div>
  )
}
