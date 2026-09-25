// Menú «Mover a un grupo»: lista los grupos propios, permite quitar del grupo y crear uno nuevo (y asignarlo). Sirve para una fila
// (`names` = 1 contenedor, icono) y para la selección masiva (`names` = varios, botón con texto).
import { useState, type ReactNode } from 'react'
import { Icon } from '@/components/shared/Icon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useConnection } from '@/data/store/hooks'
import { safeText } from '@/lib/safeText'
import { assignKey, useGroupsStore } from './groupsStore'
import { hueStyle } from './hueStyle'
import { NewGroupDialog } from './NewGroupDialog'

export function AssignGroupMenu({ names, triggerClass, ariaLabel, children }: { names: readonly string[]; triggerClass?: string; ariaLabel: string; children: ReactNode }) {
  const profileId = useConnection().profile.id
  const groups = useGroupsStore((s) => s.groups)
  const assignedTo = useGroupsStore((s) => s.assign)
  const moveContainers = useGroupsStore((s) => s.moveContainers)
  const [creating, setCreating] = useState(false)

  // Grupo actual (solo si TODOS los contenedores comparten el mismo).
  const currents = new Set(names.map((n) => assignedTo[assignKey(profileId, n)]))
  const current = currents.size === 1 ? [...currents][0] : undefined
  const anyAssigned = names.some((n) => assignedTo[assignKey(profileId, n)] !== undefined)
  const move = (gid: string | null) => moveContainers(profileId, names, gid)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={triggerClass} aria-label={ariaLabel}>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Mover a un grupo</DropdownMenuLabel>
          {groups.length === 0 ? <div className="menu-label" style={{ fontWeight: 400 }}>Todavía no tienes grupos.</div> : null}
          {groups.map((g) => (
            <DropdownMenuItem key={g.id} onClick={() => move(g.id)}>
              <span className="grp-swatch" style={hueStyle(g.hue)} aria-hidden="true" />
              <span className="grow">{safeText(g.name, { singleLine: true })}</span>
              {current === g.id ? <Icon name="check" size="sm" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {anyAssigned ? <DropdownMenuItem onClick={() => move(null)}><Icon name="x" size="sm" />Quitar de su grupo</DropdownMenuItem> : null}
          <DropdownMenuItem onClick={() => setCreating(true)}><Icon name="folder-plus" size="sm" />Nuevo grupo…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewGroupDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => move(id)} />
    </>
  )
}
