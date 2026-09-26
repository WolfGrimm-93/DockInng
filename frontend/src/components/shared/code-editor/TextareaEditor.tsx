// Plan B del editor (y marco de carga): textarea simple con el mismo contrato que CodeMirror.
import { useImperativeHandle, useRef } from 'react'
import { Textarea } from '@/components/ui/input'
import type { CodeEditorProps } from './types'

export function TextareaEditor({ value, onChange, readOnly, ariaLabel, onSave, handleRef, diagnostics }: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(handleRef, () => ({
    focus: () => ref.current?.focus(),
    focusLine(line) {
      const el = ref.current
      if (!el) return
      const lines = el.value.split('\n')
      const n = Math.min(Math.max(line, 1), lines.length)
      const pos = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0)
      el.focus()
      el.setSelectionRange(pos, pos + (lines[n - 1]?.length ?? 0))
    },
  }), [])
  return (
    <Textarea
      ref={ref} spellCheck={false} wrap="off" rows={18} aria-label={ariaLabel} readOnly={readOnly} value={value}
      aria-invalid={diagnostics.some((d) => d.level === 'error') || undefined}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.() } }}
      className="code-fallback"
    />
  )
}
