// Diálogo de HUELLA DE HOST (TOFU explícito). Contrato:
//   <HostKeyDialog probe host port onTrust onClose busy? simulated? />   (`probe` = null → cerrado)
//   - state 'unknown': muestra tipo + huella SHA256 y «Confiar y continuar»; el foco inicial es «Cancelar» (nunca se confía por accidente).
//   - state 'changed': BLOQUEO rojo. NO hay botón de aceptar: solo «Cerrar». Se enseñan la huella conocida y la nueva.
//   - state 'trusted': no debería abrirse (el llamador sigue directo); si se abre, solo informa.
// La huella y el host vienen del servidor remoto: se pintan SIEMPRE como texto (nunca HTML).
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/dialog'
import type { HostKeyProbe } from '@/data/types'
import { safeText } from '@/lib/safeText'
import { toast } from '@/lib/toastStore'
import { Icon } from './Icon'
import { LevelNote } from './LevelNote'

async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); toast.ok('Huella copiada') } catch { toast.warn('No se pudo copiar', { sub: t }) }
}

export function HostKeyDialog({ probe, host, port, busy, simulated, onTrust, onClose }: {
  probe: HostKeyProbe | null
  host: string
  port: number
  busy?: boolean
  /** Mundo simulado (navegador): la huella es de ejemplo. */
  simulated?: boolean
  onTrust(): void
  onClose(): void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const changed = probe?.state === 'changed'
  const where = `${safeText(host, { singleLine: true })}${port === 22 ? '' : `:${port}`}`
  return (
    <AlertDialog open={probe !== null} onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <AlertDialogContent initialFocus={cancelRef}>
        {probe ? (
          <>
            <div className="dlg-body">
              <span className={`dlg-ico${changed ? ' blocked' : ''}`}><Icon name={changed ? 'ban' : 'lock'} size="lg" /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <AlertDialogTitle>{changed ? 'La clave del host cambió' : probe.state === 'trusted' ? 'Huella ya confiable' : 'Confirmar la huella del host'}</AlertDialogTitle>
                <AlertDialogDescription render={<div />}>
                  {changed ? (
                    <p>La clave de <b>{where}</b> es distinta de la que aceptaste antes. Puede ser una <b>suplantación (ataque de intermediario)</b> o que el servidor se reinstaló. DockInng no continúa.</p>
                  ) : (
                    <p>Es la primera vez que te conectas a <b>{where}</b>. Comprueba que esta huella coincide con la del servidor <b>antes</b> de confiar (en el servidor: <code>ssh-keygen -lf /etc/ssh/ssh_host_{probe.key_type.replace(/^ssh-/, '')}_key.pub</code>).</p>
                  )}
                </AlertDialogDescription>
                <dl className="hostkey">
                  <dt>Tipo de clave</dt>
                  <dd className="mono">{safeText(probe.key_type, { singleLine: true })}</dd>
                  <dt>{changed ? 'Huella NUEVA (la que presenta el servidor ahora)' : 'Huella SHA256'}</dt>
                  <dd className="mono fp" data-testid="fingerprint">{safeText(probe.fingerprint_sha256, { singleLine: true })}</dd>
                  {changed && probe.known_fingerprint_sha256 ? (
                    <>
                      <dt>Huella CONOCIDA (la que confiaste antes)</dt>
                      <dd className="mono fp">{safeText(probe.known_fingerprint_sha256, { singleLine: true })}</dd>
                    </>
                  ) : null}
                </dl>
                {simulated ? <p className="f-hint" style={{ marginTop: 8 }}><Icon name="flask" size="sm" /> Huella de ejemplo (modo simulado).</p> : null}
                {changed ? (
                  <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
                    <Icon name="alert" />
                    <div>
                      <b>Conexión bloqueada.</b>
                      <p>Confirma la huella nueva con quien administra el servidor. Aquí no se puede aceptar. Si el cambio es legítimo, quita a mano la entrada de ese host del archivo <code>known_hosts</code> de DockInng (en su carpeta de datos, no el de ~/.ssh) y vuelve a verificar.</p>
                    </div>
                  </div>
                ) : (
                  <LevelNote icon="lock"><b>Confianza en el primer contacto.</b> Se guarda solo esta huella; si algún día cambia, se bloqueará la conexión.</LevelNote>
                )}
              </div>
            </div>
            <div className="dlg-foot">
              <Button type="button" variant="ghost" size="sm" onClick={() => void copyText(probe.fingerprint_sha256)}><Icon name="copy" size="sm" />Copiar huella</Button>
              <Button ref={cancelRef} type="button" variant="secondary" disabled={busy} onClick={onClose}>{changed ? 'Cerrar' : 'Cancelar'}</Button>
              {changed ? null : (
                <Button type="button" variant="primary" disabled={busy || probe.state === 'trusted'} onClick={onTrust}>
                  <Icon name={busy ? 'loader' : 'check'} spin={busy} />Confiar y continuar
                </Button>
              )}
            </div>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}
