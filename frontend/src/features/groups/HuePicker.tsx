// Selector de color de un grupo: 8 muestras de la paleta + deslizador de matiz (0–359) para cualquier otro color.
// Con L/C fijos por tema el contraste es ≥ 4.0:1 en claro y ≥ 6.6:1 en oscuro para TODOS los matices (medido en los 360),
// así que ningún valor elegido puede dejar el color ilegible. El color es decorativo: el nombre del grupo siempre va en texto.
import { Icon } from '@/components/shared/Icon'
import { GROUP_HUES, GROUP_HUE_NAMES } from '../common/groupColor'
import { clampHue } from './groupsStore'
import { hueStyle } from './hueStyle'

export function HuePicker({ value, onChange, label }: { value: number; onChange(h: number): void; label: string }) {
  return (
    <div className="hue-picker" role="group" aria-label={label}>
      <div className="hue-swatches">
        {GROUP_HUES.map((h) => (
          <button key={h} type="button" className="hue-swatch" style={hueStyle(h)} aria-pressed={value === h} aria-label={`Color ${GROUP_HUE_NAMES[h]}`} title={GROUP_HUE_NAMES[h]} onClick={() => onChange(h)}>
            {value === h ? <Icon name="check" size="sm" /> : null}
          </button>
        ))}
      </div>
      <label className="hue-slider">
        <span className="sr-only">{label}: matiz personalizado</span>
        <input type="range" min={0} max={359} step={1} value={clampHue(value)} onChange={(e) => onChange(clampHue(Number(e.target.value)))} />
        <span className="hue-preview" style={hueStyle(value)} aria-hidden="true" />
      </label>
    </div>
  )
}
