// TEXTO NO CONFIABLE (nombres de Docker, etiquetas, logs). Contrato:
//   safeText(s, {singleLine?}) -> string   elimina controles bidi (U+202A–202E, U+2066–2069, U+200E/F, U+061C: «‮gpj.exe» ya no se ve como «exe.jpg»)
//                                          y controles C0/C1 no imprimibles (conserva \t \n \r salvo singleLine, que los vuelve espacio). Nunca lanza.
//   <SafeName> (components/shared/SafeName) lo aplica y aísla el texto con <bdi>.
// El VALOR original nunca se altera para comparar/enviar: solo se sanea lo que se PINTA. Los ids/valores exactos siguen accesibles por title.
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

export function safeText(s: unknown, o: { singleLine?: boolean } = {}): string {
  if (s === null || s === undefined) return ''
  let t = String(s).replace(BIDI, '').replace(CONTROLS, '')
  if (o.singleLine) t = t.replace(/[\t\n\r]+/g, ' ')
  return t
}
