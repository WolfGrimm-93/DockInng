// Selector de conexión (DropdownMenu de Base UI, `menuitemradio`). Contrato: <ConnectionSwitcher/>
//   Abierto por uiStore.ctxMenuOpen (así «Cambiar de conexión» de los paneles de error lo abre).
//   Ola 2: conexiones reales; muestra «Conectando…» (spinner) mientras el backend levanta el túnel/TLS y evita cambios concurrentes.
//   Un fallo al cambiar deja la conexión anterior (toast con la causa clasificada); lo resuelve store.selectProfile.
import { useHashRoute } from '@/app/useHashRoute'
import { useUiStore } from '@/app/uiStore'
import { Icon } from '@/components/shared/Icon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SafeName } from '@/components/shared/SafeName'
import { safeText } from '@/lib/safeText'
import { useConnection, useEngineStore } from '@/data/store/hooks'

export function ConnectionSwitcher() {
  const open = useUiStore((s) => s.ctxMenuOpen)
  const setOpen = useUiStore((s) => s.openCtxMenu)
  const route = useHashRoute()
  const c = useConnection()
  const switching = useEngineStore((s) => s.switchingProfileId)
  const target = switching ? c.profiles.find((p) => p.id === switching) : null
  return (
    <div className="ctx">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger className="ctx-btn" aria-busy={target ? true : undefined} aria-label={target ? `Conectando con ${safeText(target.name, { singleLine: true })}…` : `Cambiar de conexión. Actual: ${safeText(c.profile.name, { singleLine: true })}`}>
          <Icon name={target ? 'loader' : c.profile.icon} size="lg" spin={!!target} />
          <span className="ctx-text">
            <strong><SafeName ellipsis>{target ? `Conectando con ${target.name}…` : c.profile.name}</SafeName></strong>
            <small><SafeName ellipsis>{target ? target.target : c.profile.target}</SafeName></small>
          </span>
          <Icon name="chev-down" size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Conexiones</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={c.profile.id}
            onValueChange={(id) => {
              setOpen(false)
              if (id !== c.profile.id && !switching) {
                c.select(id as string)
                if (route.id !== 'containers' && route.id !== 'settings') route.go('containers')
              }
            }}
          >
            {c.profiles.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id} disabled={!!switching}>
                <Icon name={p.icon} />
                <span>
                  <b><SafeName ellipsis>{p.name}</SafeName>{p.remote ? <em className="ctx-tag">{p.kind.toUpperCase()}</em> : null}{p.simulated ? <em className="ctx-tag" title="Conexión de ejemplo (modo simulado)">simulada</em> : null}</b>
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
