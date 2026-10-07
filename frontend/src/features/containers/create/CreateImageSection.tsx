// Sección «Imagen y nombre» del formulario de creación: imagen (con aviso de descarga), nombre y comando.
import { safeText } from '@/lib/safeText'
import { hasExplicitTag, normalizeImageRef } from '@/lib/imageRef'
import { imageIsLocal } from '@/lib/createForm'
import { Input } from '@/components/ui/input'
import type { Image } from '@/data/types'
import { FieldError } from './FieldError'

export interface CreateImageSectionProps {
  image: string
  setImage(v: string): void
  name: string
  setName(v: string): void
  command: string
  setCommand(v: string): void
  images: Image[]
  fieldError(k: string): string | undefined
  touch(k: string): void
  clearBackendErrors(): void
}

export function CreateImageSection({ image, setImage, name, setName, command, setCommand, images, fieldError: fe, touch, clearBackendErrors }: CreateImageSectionProps) {
  return (
    <section className="card form-section">
      <h2>Imagen y nombre</h2>
      <div className="form-body">
        <div className="f-cols">
          <div className="f-row">
            <label htmlFor="fImage">Imagen</label>
            <Input id="fImage" value={image} onChange={(e) => { setImage(e.target.value); clearBackendErrors() }} onBlur={() => touch('image')} placeholder="postgres:16.4" list="imgs" aria-invalid={!!fe('image')} aria-describedby={fe('image') ? 'eImage' : 'hImage'} />
            <datalist id="imgs">{images.filter((i) => !i.dangling).map((i) => <option key={i.reference} value={safeText(i.reference, { singleLine: true })} />)}</datalist>
            {fe('image') ? <FieldError id="eImage" message={fe('image')} /> : (
              <span className="f-hint" id="hImage">
                {image.trim() && !hasExplicitTag(image) ? `Sin etiqueta: se usará :latest. ` : ''}
                {image.trim() && !imageIsLocal(images, image) ? `«${safeText(normalizeImageRef(image), { singleLine: true })}» no está en este equipo: se descargará antes de crear el contenedor.` : 'Elige una imagen local o escribe otra: si no está en el equipo, se descarga primero.'}
              </span>
            )}
          </div>
          <div className="f-row">
            <label htmlFor="fName">Nombre <span className="muted">(opcional)</span></label>
            <Input id="fName" value={name} onChange={(e) => { setName(e.target.value); clearBackendErrors() }} onBlur={() => touch('name')} placeholder="base-datos-pruebas" aria-invalid={!!fe('name')} aria-describedby={fe('name') ? 'eName' : 'hName'} />
            {fe('name') ? <FieldError id="eName" message={fe('name')} /> : <span className="f-hint" id="hName">Letras, números, punto, guion y guion bajo. Vacío: Docker elige uno.</span>}
          </div>
        </div>
        <div className="f-row">
          <label htmlFor="fCmd">Comando <span className="muted">(opcional)</span></label>
          <Input id="fCmd" className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sleep infinity" aria-describedby="hCmd" />
          <span className="f-hint" id="hCmd">Sustituye el comando de la imagen. No se ejecuta en una shell: no hay pipes ni variables.</span>
        </div>
      </div>
    </section>
  )
}
