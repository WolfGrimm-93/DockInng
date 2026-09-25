// Gráfica de línea SVG propia (sin Recharts). Contrato: <Sparkline values={number[]} color label max?=100 />
//   viewBox 300×96, polyline + polygon de área, trazo constante (vector-effect). `values` = últimos N puntos (60 típico).
import { useId } from 'react'

const W = 300
const H = 96

export function Sparkline({ values, color, label, max = 100 }: { values: number[]; color: string; label: string; max?: number }) {
  const id = useId()
  const n = values.length
  const pts =
    n < 2
      ? `0,${H - 4} ${W},${H - 4}`
      : values.map((v, i) => `${((i * W) / (n - 1)).toFixed(1)},${(H - 4 - (Math.max(0, Math.min(max, v)) / max) * (H - 8)).toFixed(1)}`).join(' ')
  return (
    <svg className="chart" id={id} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {[24, 48, 72].map((y) => (
        <line key={y} className="grid" x1={0} x2={W} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
      ))}
      <polygon className="area" fill={color} points={`0,${H} ${pts} ${W},${H}`} />
      <polyline className="line" stroke={color} points={pts} />
    </svg>
  )
}
