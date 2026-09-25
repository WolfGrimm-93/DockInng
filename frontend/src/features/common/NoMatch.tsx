// Estado «sin coincidencias» dentro de una tabla filtrada (mismo aspecto que el de Contenedores).
import { Icon } from '@/components/shared/Icon'
import { Button } from '@/components/ui/button'

export function NoMatch({ what, onClear }: { what: string; onClear(): void }) {
  return (
    <div className="state" style={{ padding: '36px 24px' }}>
      <span className="state-ico"><Icon name="search" size="lg" /></span>
      <h2>{what}</h2>
      <p>Prueba con otro texto de búsqueda.</p>
      <div className="btns"><Button variant="secondary" onClick={onClear}>Quitar filtros</Button></div>
    </div>
  )
}
