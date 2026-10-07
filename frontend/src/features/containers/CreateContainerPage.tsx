// Vista «Nuevo contenedor» (#create?image=&remote=1). Creación REAL: validación por campo (cliente y plan del backend), avisos de rutas
// sensibles (confirmación con ticket cuando el backend la exige), elección de grupo propio, y si la imagen no está en el equipo se
// descarga primero (pull inline con progreso y cancelación) y se reintenta. Al terminar navega al detalle del contenedor.
// La página solo compone: el estado y el flujo están en create/useCreateContainerForm.ts; cada sección en create/.
import { useEffect, useRef, useState } from 'react'
import { useHashRoute } from '@/app/useHashRoute'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/data/errors'
import { safeText } from '@/lib/safeText'
import { Icon } from '@/components/shared/Icon'
import { PageHeader } from '@/components/shared/PageHeader'
import { AlertBox } from '@/components/shared/StateViews'
import { useViewGate } from '../common/gate'
import { LinkButton } from '../common/LinkButton'
import { NewGroupDialog } from '../groups/NewGroupDialog'
import { VolumesSection } from './VolumesSection'
import { CreateEnvSection } from './create/CreateEnvSection'
import { CreateGroupSection } from './create/CreateGroupSection'
import { CreateImageSection } from './create/CreateImageSection'
import { CreateNetworkSection } from './create/CreateNetworkSection'
import { CreatePortsSection } from './create/CreatePortsSection'
import { CreatePullStatus } from './create/CreatePullStatus'
import { useCreateContainerForm } from './create/useCreateContainerForm'

export default function CreateContainerPage() {
  const route = useHashRoute()
  const gate = useViewGate(4, 6)
  const [groupDlg, setGroupDlg] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const pullCard = useRef<HTMLElement>(null)
  const vm = useCreateContainerForm(route)
  const { fieldError: fe, touch } = vm

  // La tarjeta de descarga queda al final del formulario: se lleva a la vista cuando empieza (el anuncio aria-live ya está dentro).
  useEffect(() => { if (vm.phase === 'pulling') pullCard.current?.scrollIntoView?.({ block: 'center' }) }, [vm.phase])

  // Foco al primer campo con error tras un envío fallido.
  useEffect(() => {
    if (vm.submitted > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [vm.submitted])

  const head = <PageHeader title="Nuevo contenedor" back={{ href: route.href('containers'), label: 'Contenedores' }} simulated={vm.cap !== 'live'} />
  if (gate.blocked) return <>{head}{gate.blocked}</>
  const locked = gate.locked || vm.busy

  return (
    <>
      {head}
      <div className="view-body">
        {gate.lostBanner}
        <form className="form" id="createForm" noValidate ref={formRef} aria-busy={vm.busy || undefined} onSubmit={vm.submit}>
          <CreateImageSection
            image={vm.image} setImage={vm.setImage} name={vm.name} setName={vm.setName} command={vm.command} setCommand={vm.setCommand}
            images={vm.images} fieldError={fe} touch={touch} clearBackendErrors={vm.clearBackendErrors}
          />
          <CreatePortsSection ports={vm.ports} patchPort={vm.patchPort} removePort={vm.removePort} addPort={vm.addPort} fieldError={fe} touch={touch} />
          <VolumesSection
            vols={vm.vols}
            connName={vm.connName}
            remoteBind={vm.remoteBind}
            relRemote={vm.relRemote}
            binds={vm.binds}
            fieldError={fe}
            onPatch={vm.patchVol}
            onRemove={vm.removeVol}
            onAdd={vm.addVol}
            onTouch={touch}
          />
          <CreateEnvSection env={vm.env} patchEnv={vm.patchEnv} removeEnv={vm.removeEnv} addEnv={vm.addEnv} fieldError={fe} touch={touch} />
          <CreateNetworkSection networks={vm.networks} net={vm.net} setNet={vm.setNet} restart={vm.restart} setRestart={vm.setRestart} fieldError={fe} />
          <CreateGroupSection groups={vm.groups} groupId={vm.groupId} setGroupId={vm.setGroupId} onNewGroup={() => setGroupDlg(true)} />

          <CreatePullStatus phase={vm.phase} pullRef={vm.pullRef} pullOp={vm.pullOp} cardRef={pullCard} onCancel={vm.cancelPull} />
          {vm.formError ? (() => { const m = apiErrorMessage(vm.formError); return <AlertBox kind="error" icon="alert" title={m.title} text={safeText(m.detail)} /> })() : null}

          <div className="form-actions">
            <Button type="submit" variant="primary" data-create="start" locked={locked}><Icon name={vm.busy ? 'loader' : 'play'} fill={!vm.busy} spin={vm.busy} />{vm.phase === 'pulling' ? 'Descargando…' : vm.phase === 'creating' ? 'Creando…' : 'Crear e iniciar'}</Button>
            <Button type="submit" variant="secondary" data-create="only" locked={locked}>Solo crear</Button>
            <LinkButton variant="ghost" href={route.href('containers')}>Cancelar</LinkButton>
          </div>
        </form>
      </div>
      <NewGroupDialog open={groupDlg} onClose={() => setGroupDlg(false)} onCreated={(id) => { vm.setGroupId(id); setGroupDlg(false) }} />
    </>
  )
}
