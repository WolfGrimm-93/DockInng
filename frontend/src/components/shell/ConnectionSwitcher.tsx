// Selector de conexión (DropdownMenu de Base UI, `menuitemradio`). Contrato: <ConnectionSwitcher/>
//   Abierto por uiStore.ctxMenuOpen (así «Cambiar de conexión» de los paneles de error lo abre).
//   «Conectar» a una conexión simulada solo muestra un toast (D6): lo resuelve store.selectProfile.
import { useHashRoute } from '@/app/useHashRoute'
import { useUiStore } from '@/app/uiStore'
import { Icon } from '@/components/shared/Icon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SafeName } from '@/components/shared/SafeName'
import { safeText } from '@/lib/safeText'
import { useConnection } from '@/data/store/hooks'

export function ConnectionSwitcher() {
  const open = useUiStore((s) => s.ctxMenuOpen)
  const setOpen = useUiStore((s) => s.openCtxMenu)
  const route = useHashRoute()
  const c = useConnection()
  return (
    <div className="ctx">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger className="ctx-btn" aria-label={`Cambiar de conexión. Actual: ${safeText(c.profile.name, { singleLine: true })}`}>
          <Icon name={c.profile.icon} size="lg" />
          <span className="ctx-text">
            <strong><SafeName ellipsis>{c.profile.name}</SafeName></strong>
            <small><SafeName ellipsis>{c.profile.target}</SafeName></small>
          </span>
          <Icon name="chev-down" size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Conexiones</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={c.profile.id}
            onValueChange={(id) => {
              setOpen(false)
              if (id !== c.profile.id) {
                c.select(id as string)
                if (route.id !== 'containers' && route.id !== 'settings') route.go('containers')
              }
            }}
          >
            {c.profiles.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id}>
                <Icon name={p.icon} />
                <span>
                  <b><SafeName ellipsis>{p.name}</SafeName></b>
                  <small><SafeName ellipsis>{p.target}</SafeName></small>
                </span>
                {p.id === c.profile.id ? <Icon name="check" size="sm" className="check" /> : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => route.go('settings')}>
            <Icon name="sliders" />
            Administrar conexiones…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
