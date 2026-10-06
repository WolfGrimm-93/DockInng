// CONFIGURACIÓN > APARIENCIA. Modo (claro/oscuro/sistema), color de acento (presets + matiz personalizado), tinte de
// superficies (+ intensidad), combinaciones con nombre, vista previa en vivo, «Restablecer» y aviso NO bloqueante de choque
// con estados. Todo se aplica y persiste al instante (motor: src/theme). SettingsPage lo compone con <AppearanceSection />.
import { useId } from 'react'
import { Icon } from '@/components/shared/Icon'
import { AlertBox } from '@/components/shared/StateViews'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button } from '@/components/ui/button'
import { computeColors, resolveInput } from '@/theme/engine'
import { ACCENTS, COMBOS, STRENGTH_LABEL, STRENGTH_MULT, TINTS, accentHue, stateClash, tintHueOf } from '@/theme/presets'
import type { AccentSel, ThemeMode, ThemePrefs, TintSel, TintStrength } from '@/theme/types'
import { useTheme } from '@/theme/useTheme'
import { ChoiceGroup, type Choice } from './appearance/ChoiceGroup'
import './appearance/appearance.css'

type Mode = 'light' | 'dark'
const css = (c: { l: number; c: number; h: number }) => `oklch(${+c.l.toFixed(4)} ${+c.c.toFixed(4)} ${+c.h.toFixed(2)})`

/** Colores de muestra del acento `hue` sobre el tinte actual (los del modo efectivo). */
function accentSwatch(hue: number, tintHue: number, k: number, mode: Mode) {
  const c = computeColors({ accentHue: hue, tintHue, tintChroma: k }, mode)
  return { bg: css(c['--primary'].color), fg: css(c['--primary-foreground'].color) }
}

const wrapH = (n: number) => Math.min(360, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)))

export function AppearanceSection() {
  const t = useTheme()
  const { prefs, resolvedMode } = t
  const uid = useId()
  const input = resolveInput(prefs)
  const ah = input.accentHue
  const customAccent = 'hue' in prefs.accent
  const tintNow = prefs.tint
  const clash = stateClash(ah)
  const bronze = resolvedMode === 'light' && ah >= 40 && ah <= 100

  const modeOptions: Choice<ThemeMode>[] = [
    { value: 'light', label: 'Claro', children: <><Icon name="sun" size="sm" />Claro</> },
    { value: 'dark', label: 'Oscuro', children: <><Icon name="moon" size="sm" />Oscuro</> },
    { value: 'system', label: 'Sistema', children: <><Icon name="monitor" size="sm" />Sistema</> },
  ]

  const accentValue: string = customAccent ? 'custom' : (prefs.accent as { preset: string }).preset
  const accentOptions: Choice<string>[] = [
    ...ACCENTS.map((a) => {
      const sw = accentSwatch(a.hue, input.tintHue, input.tintChroma, resolvedMode)
      return {
        value: a.id,
        label: a.label,
        style: { ['--sw' as string]: sw.bg, ['--sw-fg' as string]: sw.fg },
        children: accentValue === a.id ? <Icon name="check" size="sm" /> : <span className="sr-only">{a.label}</span>,
      }
    }),
    { value: 'custom', label: 'Personalizado', className: 'custom', style: { ['--sw-fg' as string]: 'oklch(.2 0 0)' }, children: customAccent ? <Icon name="check" size="sm" /> : <span className="sr-only">Personalizado</span> },
  ]
  const tintValue: string = tintNow === 'follow' || tintNow === 'neutral' ? tintNow : 'preset' in tintNow ? tintNow.preset : 'custom'
  const tintDot = (h: number | null) => (
    <span className="dot" style={{ background: h === null ? 'var(--muted)' : css(computeColors({ accentHue: ah, tintHue: h, tintChroma: 1.8 }, resolvedMode)['--card'].color) }} />
  )
  const tintOptions: Choice<string>[] = [
    { value: 'follow', label: 'Seguir acento', children: <>{tintDot(ah)}Seguir acento</> },
    { value: 'neutral', label: 'Neutro', children: <>{tintDot(null)}Neutro</> },
    ...TINTS.map((x) => ({ value: x.id as string, label: x.label, children: <>{tintDot(x.hue)}{x.label}</> })),
    { value: 'custom', label: 'Personalizado', children: <>{tintDot(tintHueOf(tintNow, ah))}Personalizado</> },
  ]

  const setAccentValue = (v: string) => {
    if (v === 'custom') t.setAccent({ hue: wrapH(ah) })
    else t.setAccent({ preset: v as never })
  }
  const setTintValue = (v: string) => {
    if (v === 'follow' || v === 'neutral') t.setTint(v)
    else if (v === 'custom') t.setTint({ hue: wrapH(input.tintHue) })
    else t.setTint({ preset: v as never })
  }
  const strengths: Choice<TintStrength>[] = (['soft', 'normal', 'strong'] as const).map((s) => ({ value: s, label: STRENGTH_LABEL[s], disabled: prefs.tint === 'neutral' }))

  const same = (p: ThemePrefs, c: (typeof COMBOS)[number]) =>
    JSON.stringify([accentHue(p.accent), p.tint === 'follow' ? 'f' : p.tint === 'neutral' ? 'n' : tintHueOf(p.tint, 0), p.tint === 'neutral' ? 1 : STRENGTH_MULT[p.strength]]) ===
    JSON.stringify([accentHue(c.accent), c.tint === 'follow' ? 'f' : c.tint === 'neutral' ? 'n' : tintHueOf(c.tint, 0), c.tint === 'neutral' ? 1 : STRENGTH_MULT[c.strength]])
  const comboValue = COMBOS.find((c) => same(prefs, c))?.id ?? null
  const comboOptions: Choice<string>[] = COMBOS.map((c) => {
    const r = resolveInput({ v: 1, mode: prefs.mode, accent: c.accent, tint: c.tint, strength: c.strength })
    const cols = computeColors(r, resolvedMode)
    return {
      value: c.id,
      label: c.label,
      children: (
        <>
          <span className="combo-name">{comboValue === c.id ? <Icon name="check" size="sm" /> : null}{c.label}</span>
          <span className="combo-dots" aria-hidden="true">
            <i style={{ background: css(cols['--primary'].color) }} />
            <i style={{ background: css(cols['--background'].color) }} />
            <i style={{ background: css(cols['--card'].color) }} />
            <i style={{ background: css(cols['--accent'].color) }} />
          </span>
        </>
      ),
    }
  })

  const ratio = (pair: string) => t.report.find((r) => r.pair === pair)?.ratio ?? 0
  const rText = ratio('primary-foreground / primary')
  const rRing = Math.min(...t.report.filter((r) => r.pair.startsWith('ring /')).map((r) => r.ratio))
  const sysNow = resolvedMode === 'dark' ? 'Oscuro' : 'Claro'

  return (
    <section aria-labelledby={`${uid}-h`} className="appearance">
      <h2 className="section-title" id={`${uid}-h`}>Apariencia</h2>
      <div className="card">
        <div className="setting-row">
          <div className="grow"><b>Tema</b><small>{prefs.mode === 'system' ? `Sigue el modo de tu sistema (ahora: ${sysNow}).` : 'Se recuerda entre sesiones.'}</small></div>
          <ChoiceGroup label="Tema" variant="segmented" value={prefs.mode} options={modeOptions} onChange={t.setMode} />
        </div>

        <div className="setting-row stack">
          <div className="grow"><b>Combinaciones</b><small>Acento, tinte e intensidad en un clic. Todas cumplen contraste AA.</small></div>
          <ChoiceGroup label="Combinaciones" variant="combo" value={comboValue} options={comboOptions} onChange={t.applyCombo} />
        </div>

        <div className="setting-row stack">
          <div className="grow"><b>Color de acento</b><small>Botones, selección, foco y logotipo del menú. Los estados de contenedor no cambian.</small></div>
          <ChoiceGroup label="Color de acento" variant="swatch" value={accentValue} options={accentOptions} onChange={setAccentValue} />
          {customAccent ? (
            <div className="hue-row">
              <label htmlFor={`${uid}-hue`} className="muted">Matiz</label>
              <input id={`${uid}-hue`} type="range" min={0} max={360} value={'hue' in prefs.accent ? prefs.accent.hue : 0} onChange={(e) => t.setAccent({ hue: wrapH(+e.target.value) } as AccentSel)} aria-valuetext={`${ah} grados`} />
              <input className="input" type="number" min={0} max={360} aria-label="Matiz del acento en grados" value={'hue' in prefs.accent ? prefs.accent.hue : 0} onChange={(e) => t.setAccent({ hue: wrapH(+e.target.value) })} />
            </div>
          ) : null}
          {clash ? (
            <AlertBox kind="warn" icon="warn" title="Este color se parece al de un estado" text={`Se parece al de «${clash}». Los estados no cambian con el acento y siempre llevan icono y texto, así que no se confunden; puedes usarlo igualmente.`} />
          ) : null}
          {bronze ? <p className="muted text-[length:var(--text-xs)]" >En modo claro este color se oscurece a un tono bronce para mantener el contraste AA con el texto blanco.</p> : null}
        </div>

        <div className="setting-row stack">
          <div className="grow"><b>Tinte de las superficies</b><small>Color de fondo, tarjetas y bordes. Independiente del acento.</small></div>
          <ChoiceGroup label="Tinte de las superficies" variant="chip" value={tintValue} options={tintOptions} onChange={setTintValue} />
          {tintValue === 'custom' ? (
            <div className="hue-row">
              <label htmlFor={`${uid}-thue`} className="muted">Matiz</label>
              <input id={`${uid}-thue`} type="range" min={0} max={360} value={'hue' in (prefs.tint as object) ? (prefs.tint as { hue: number }).hue : 0} onChange={(e) => t.setTint({ hue: wrapH(+e.target.value) } as TintSel)} aria-valuetext={`${input.tintHue} grados`} />
              <input className="input" type="number" min={0} max={360} aria-label="Matiz del tinte en grados" value={'hue' in (prefs.tint as object) ? (prefs.tint as { hue: number }).hue : 0} onChange={(e) => t.setTint({ hue: wrapH(+e.target.value) })} />
            </div>
          ) : null}
          <div className="preview-row">
            <span className="muted" id={`${uid}-int`}>Intensidad</span>
            <ChoiceGroup label="Intensidad del tinte" variant="segmented" value={prefs.strength} options={strengths} onChange={t.setStrength} />
          </div>
        </div>

        <div className="preview">
          <b>Vista previa</b>
          {/* Maqueta decorativa: aria-hidden (la tabla no es un grid, así que aria-selected en <tr> no sería válido). */}
          <div className="preview-box" aria-hidden="true">
            <div className="preview-row">
              <Button variant="primary" size="sm" type="button">Botón primario</Button>
              <Button variant="secondary" size="sm" type="button">Secundario</Button>
              <span className="tag tag-brand">Etiqueta de acento</span>
              <span className="tag">Etiqueta neutra</span>
              <input className="input preview-focus w-[150px]"  aria-label="Campo de ejemplo con foco" defaultValue="Foco visible" readOnly tabIndex={-1} />
            </div>
            <div className="preview-row">
              <StatusBadge state="running" /><StatusBadge state="paused" /><StatusBadge state="restarting" /><StatusBadge state="exited" /><StatusBadge state="dead" /><StatusBadge state="created" />
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Nombre</th><th>Estado</th></tr></thead>
                <tbody>
                  <tr aria-selected="true"><td>tienda-api-1</td><td>Seleccionada</td></tr>
                  <tr><td>tienda-redis-1</td><td>Normal</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="readout" aria-live="polite">
            <span>Texto sobre botón <b>{rText.toFixed(1)}:1</b> · {rText >= 4.5 ? 'AA' : 'bajo AA'}</span>
            <span>Anillo de foco <b>{rRing.toFixed(1)}:1</b> · {rRing >= 3 ? 'AA (interfaz)' : 'bajo AA'}</span>
          </div>
        </div>

        <div className="setting-row">
          <div className="grow"><b>Restablecer colores</b><small>Vuelve a Bosque (esmeralda). El modo claro/oscuro/sistema no cambia.</small></div>
          <Button variant="secondary" type="button" onClick={t.reset} disabled={t.isDefault} aria-disabled={t.isDefault}><Icon name="rotate" />Restablecer colores</Button>
        </div>
      </div>
    </section>
  )
}

export default AppearanceSection
