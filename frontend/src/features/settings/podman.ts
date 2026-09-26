// Una conexión local cuyo socket es de Podman (detección por el destino; no se ejecuta `podman`).
import type { ConnectionProfile } from '@/data/types'

export const isPodmanTarget = (p: ConnectionProfile): boolean => p.kind === 'local' && /podman/i.test(p.target)
