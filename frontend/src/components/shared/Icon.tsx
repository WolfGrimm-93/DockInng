// Icon: mapa `name -> lucide` con los nombres de la plantilla. Contrato:
//   <Icon name="box" size="sm|md|lg" fill? spin? className? />   aria-hidden siempre (el texto va al lado o en aria-label del botón)
//   size: sm=14 · md=16 (defecto) · lg=20 px (clases .i .sm .lg de app.css); `fill` para play/square/pause (relleno + trazo 1.25).
//   `dot` = SVG propio (círculo r9.5 + punto r4.2), el icono de «En ejecución» (▶ queda solo para la acción Iniciar).
import {
  Activity, ArrowLeft, Bell, GripVertical, Maximize, Minimize, Minus, Ban, Box, Braces, Check, ChevronDown, ChevronRight, CircleAlert, CircleDashed, CircleX, Command, Copy, Cpu,
  Database, Download, Ellipsis, Eye, FileText, FlaskConical, Folder, FolderPlus, Globe, HardDrive, Info, Layers, LayoutGrid, LoaderCircle, Lock, Monitor, Moon, Network,
  Palette, PanelLeft, Pause, Pencil, Play, Plus, RefreshCw, RotateCw, Search, Server, SlidersHorizontal, Square, Sun, Terminal, Trash2, TriangleAlert,
  Upload, X, Zap, type LucideIcon,
} from 'lucide-react'
import type { SVGProps } from 'react'
import { cn } from '@/lib/utils'
import type { IconName } from './iconNames'

function DotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      {/* Halo: invisible salvo en `.status.is-live` (detalle), donde se expande y desvanece como un radar. */}
      <circle className="dot-halo" cx="12" cy="12" r="9.5" fill="none" />
      <circle cx="12" cy="12" r="9.5" />
      <circle className="dot-core" cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

const MAP: Record<IconName, LucideIcon | typeof DotIcon> = {
  box: Box, layers: Layers, database: Database, network: Network, grid: LayoutGrid, sliders: SlidersHorizontal, play: Play, square: Square,
  pause: Pause, rotate: RotateCw, trash: Trash2, search: Search, x: X, xcircle: CircleX, 'chev-down': ChevronDown, 'chev-right': ChevronRight,
  terminal: Terminal, activity: Activity, file: FileText, braces: Braces, sun: Sun, moon: Moon, panel: PanelLeft, plus: Plus, refresh: RefreshCw,
  server: Server, monitor: Monitor, alert: CircleAlert, warn: TriangleAlert, check: Check, ban: Ban, copy: Copy, dots: Ellipsis, dashed: CircleDashed,
  download: Download, command: Command, back: ArrowLeft, info: Info, disk: HardDrive, lock: Lock, globe: Globe, cpu: Cpu, zap: Zap, dot: DotIcon,
  loader: LoaderCircle, edit: Pencil, upload: Upload, flask: FlaskConical, folder: Folder, 'folder-plus': FolderPlus, palette: Palette, eye: Eye, grip: GripVertical, minus: Minus, maximize: Maximize, restore: Minimize, bell: Bell,
}

export interface IconProps { name: IconName; size?: 'sm' | 'md' | 'lg'; fill?: boolean; spin?: boolean; className?: string }

export function Icon({ name, size = 'md', fill, spin, className }: IconProps) {
  const Cmp = MAP[name] as LucideIcon
  return <Cmp aria-hidden="true" focusable="false" strokeWidth={1.75} className={cn('i', size !== 'md' && size, fill && 'fill', spin && 'spin', className)} />
}
