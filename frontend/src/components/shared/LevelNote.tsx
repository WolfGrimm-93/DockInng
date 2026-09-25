// Nota del nivel de política al pie de un diálogo (.level-note). Contrato: <LevelNote icon?>{children}</LevelNote>
import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './iconNames'

export function LevelNote({ icon = 'info', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="level-note">
      <Icon name={icon} size="sm" />
      <span>{children}</span>
    </div>
  )
}
