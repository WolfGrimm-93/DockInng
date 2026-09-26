// Pestaña Terminal del detalle de contenedor: shell REAL dentro del contenedor (exec con TTY) sobre xterm.js (chunk perezoso).
// - Solo con el contenedor `running`: detenido/creado/pausado/reiniciando => explicación (no abre sesión, la pestaña sigue accesible).
// - El padre monta esta pestaña con `key={contenedor}`: al cambiar de contenedor se parte de cero.
// - Al desmontar (cambiar de pestaña/vista) la sesión se cierra; no se conserva transcripción: al volver hay sesión nueva.
// - Banner rojo si el contenedor da acceso amplio al equipo (--privileged, docker.sock, pid/red del host).
// - Accesibilidad: Ctrl+Shift+M alterna «Tab mueve el foco»; «Modo lector de pantalla» (opt-in, recordado) activa el árbol aria-live de xterm.
import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { Icon } from '@/components/shared/Icon'
import { AlertBox, EmptyState } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/data/errors'
import { useConnection, useEngineApi, useEngineStoreApi } from '@/data/store/hooks'
import type { Container, ExecExit, ExecInfo } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { safeStorage } from '@/lib/safeStorage'
import { stateLabelEs } from '@/lib/format'
import type { SessionState, TerminalControl } from './XtermTerminal'

// Chunk perezoso: xterm + CSS solo se descargan al abrir la pestaña.
const XtermTerminal = lazy(() => import('./XtermTerminal'))

const SR_KEY = 'dockinng.term.sr'

const EXIT_TEXT: Record<ExecExit['reason'], (e: ExecExit) => string> = {
  process_exited: (e) => `Sesión terminada (código ${e.exit_code ?? '?'})`,
  container_stopped: () => 'Sesión terminada: el contenedor se detuvo',
  closed: () => 'Sesión cerrada',
  no_shell: () => 'No se pudo abrir la terminal: el contenedor no tiene una shell (/bin/sh)',
  error: () => 'Error de sesión',
  internal: () => 'Error de sesión',
}

function riskLines(r: ExecInfo['risk']): string[] {
  const out: string[] = []
  if (r.privileged) out.push('está en modo privilegiado (--privileged)')
  if (r.docker_socket) out.push('tiene montado docker.sock (control total de Docker)')
  if (r.host_pid) out.push('comparte los procesos del equipo (pid=host)')
  if (r.host_network) out.push('usa la red del equipo (network=host)')
  return out
}

function disabledText(state: Container['state']): string {
  switch (state) {
    case 'paused': return 'Está en pausa: reanúdalo para abrir una terminal.'
    case 'restarting': return 'Se está reiniciando: espera a que termine para abrir una terminal.'
    case 'stopping': case 'removing': return 'Se está deteniendo: no se puede abrir una terminal.'
    case 'dead': return `Está en estado «${stateLabelEs('dead')}»: no se puede abrir una terminal.`
    case 'created': return `Está en estado «${stateLabelEs('created')}»: inícialo para abrir una terminal.`
    default: return 'Está detenido: inícialo para abrir una terminal.'
  }
}

function readSr(): boolean {
  try { return safeStorage().getItem(SR_KEY) === '1' } catch { return false }
}

export function TerminalTab({ c, name }: { c: Container; name: string }) {
  const api = useEngineApi()
  const store = useEngineStoreApi()
  const conn = useConnection()
  const running = c.state === 'running'
  const [sess, setSess] = useState<SessionState>({ kind: 'connecting' })
  const [nonce, setNonce] = useState(0)
  const [hadSession, setHadSession] = useState(false)
  const [tabFocus, setTabFocus] = useState(false)
  const [sr, setSr] = useState(readSr)
  const [note, setNote] = useState('')
  const ctl = useRef<TerminalControl>(null)
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const [lastInfo, setLastInfo] = useState<ExecInfo | null>(null)
  const onState = useCallback((s: SessionState) => {
    setSess(s)
    if (s.kind === 'open') { setHadSession(true); setLastInfo(s.info) }
  }, [])
  const open = useCallback((o: { cols: number; rows: number }) => api.exec.open(c.id, o), [api, c.id])
  const toggleTab = useCallback(() => setTabFocus((v) => { setNote(!v ? 'Modo Tab: el foco sale de la terminal' : 'La tecla Tab vuelve a la terminal'); return !v }), [])
  const announced = useRef(false)
  const announceOnce = useCallback(() => {
    if (announced.current) return
    announced.current = true
    setNote('Terminal activa. Ctrl+Shift+M hace que Tab mueva el foco fuera de la terminal.')
  }, [])
  const toggleSr = (v: boolean) => { setSr(v); try { safeStorage().setItem(SR_KEY, v ? '1' : '0') } catch { /* sin storage */ } }

  const risks = lastInfo ? riskLines(lastInfo.risk) : []

  const showEmpty = !running && !hadSession
  const ended = sess.kind === 'ended' || sess.kind === 'error'
  const status =
    sess.kind === 'connecting' ? 'Conectando…' :
    sess.kind === 'open' ? `Conectado · ${sess.info.shell.split('/').pop()}` :
    sess.kind === 'ended' ? EXIT_TEXT[sess.exit.reason](sess.exit) :
    `No se pudo abrir la terminal: ${apiErrorMessage(sess.error).detail || apiErrorMessage(sess.error).title}`

  if (showEmpty) {
    return (
      <EmptyState icon="terminal" title="La terminal necesita el contenedor en ejecución" text={disabledText(c.state)}
        actions={c.state === 'exited' || c.state === 'created' ? (
          <Button variant="primary" locked={conn.isBlocked} onClick={() => void store.getState().runContainerOp(c.id, 'start')}><Icon name="play" fill />Iniciar contenedor</Button>
        ) : <span className="muted">Estado actual: {stateLabelEs(c.state)}</span>} />
    )
  }

  return (
    <div className="term-tab">
      <div className="toolbar term-bar" style={{ padding: 0 }}>
        <span className="term-status" role="status" aria-live="polite">
          <Icon name={sess.kind === 'connecting' ? 'loader' : sess.kind === 'open' ? 'check' : sess.kind === 'error' ? 'alert' : 'info'} size="sm" spin={sess.kind === 'connecting'} />
          {' '}{safeText(status, { singleLine: true })}
        </span>
        <span className="spacer" />
        {ended ? <Button variant="primary" size="sm" locked={!running || conn.isBlocked} aria-describedby={!running ? 'termWhy' : undefined} onClick={() => { setSess({ kind: 'connecting' }); setNonce((n) => n + 1) }}><Icon name="refresh" size="sm" />Reconectar</Button> : null}
        <Button variant="secondary" size="sm" onClick={() => void ctl.current?.copySelection().then((ok) => { if (!ok) setNote('Selecciona texto en la terminal para copiarlo') })}><Icon name="copy" size="sm" />Copiar selección</Button>
        <Button variant="secondary" size="sm" disabled={ended} onClick={() => void ctl.current?.paste()}><Icon name="download" size="sm" />Pegar</Button>
        <Button variant="secondary" size="sm" onClick={() => { ctl.current?.clear(); ctl.current?.focus() }}><Icon name="x" size="sm" />Limpiar</Button>
        <label className="term-sr"><input type="checkbox" checked={sr} onChange={(e) => toggleSr(e.target.checked)} /> Modo lector de pantalla</label>
      </div>
      {ended && !running ? <p className="f-hint" id="termWhy">Reconectar no está disponible: el contenedor no está en ejecución.</p> : null}
      <p className="muted term-help" id="termHelp">
        Ctrl+Shift+C copiar · Ctrl+Shift+V pegar · Ctrl+Shift+M: Tab mueve el foco entre controles{tabFocus ? ' (activado)' : ''}
      </p>
      <div className="sr-only" role="status" aria-live="polite">{note}</div>
      {risks.length ? (
        <AlertBox kind="error" icon="alert" title="Esta terminal tiene acceso amplio al equipo" text={`El contenedor ${risks.join('; ')}. Lo que escribas aquí puede afectar al equipo, no solo al contenedor.`} />
      ) : null}
      <Suspense fallback={<div className="console term-x term-loading" role="status">Cargando terminal…</div>}>
        <XtermTerminal key={`${c.id}:${nonce}`} containerName={name} open={open} onState={onState} onToggleTabFocus={toggleTab} onFocusTerminal={announceOnce} tabFocus={tabFocus} screenReader={sr} reducedMotion={reduced} controlRef={ctl} />
      </Suspense>
    </div>
  )
}
