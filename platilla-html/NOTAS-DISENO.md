# DockInng — notas de diseño

Plantilla HTML navegable (sin build, sin CDNs). Abrir `index.html` (app) y `brand.html` (libro de marca) directamente en el navegador.

## Estructura

```
brand.html            libro de marca (contrastes WCAG calculados en vivo, 60 pares)
index.html            app con vistas conmutables
css/tokens.css        solo tokens (:root/.light y .dark) + fallback hex generado
css/app.css           layout y componentes (solo usa tokens)
css/fonts.css         @font-face: Geist Variable y JetBrains Mono (OFL), empaquetadas en fonts/
js/data.js            datos de ejemplo (nada es real)
js/app.js             vistas, diálogos, toasts, paleta Ctrl+K, formularios, flujos
assets/               logo-mark, logo-wordmark (texto a trazos), logo-mono, favicon (SVG)
```

## Parámetros de URL (plantilla)

Los de vista también pueden ir tras el hash: `#create?image=postgres:16.4`.

| Parámetro | Valores | Efecto |
|---|---|---|
| `#hash` | `containers` `detail` `create` `images` `pull` `volumes` `networks` `stacks` `stack-edit` `settings` `conn-new` | vista |
| `?theme=` | `light` `dark` | tema (si no, localStorage; por defecto oscuro) |
| `?sidebar=` | `collapsed` `expanded` | riel de iconos o sidebar completo. Bajo 1000 px de ancho arranca en riel si no hay preferencia guardada |
| `?state=` | `empty` `loading` | estado de datos de la vista actual |
| `?state=` | `error` `daemon` `ssh` | error de conexión: permiso del socket / daemon apagado / SSH |
| `?state=lost` | | desconectado durante el uso: se conservan los datos, las acciones se bloquean |
| `?compose=missing` | | Docker Compose no instalado (Stacks y editor) |
| `?ctx=` | `local` `prod` `staging` | conexión activa (`staging` falla a propósito) |
| `?tab=` `?c=` | `logs` `terminal` `stats` `inspect` · nombre | pestaña y contenedor del detalle |
| `?group=1` `?sel=3` | | agrupar por stack; preseleccionar filas |
| `?dialog=` | `delete` `delete-running` `delete-multi` `volume` `prune-volumes` `stack-down` `blocked` `palette` | abre el diálogo |
| `?menu=1` `?toast=1` `?policy=denied` | | selector de conexión abierto; toasts; rechazo inesperado del backend |
| `#create?image=…&remote=1` | | formulario prellenado; `remote=1` activa el aviso de rutas relativas |
| `#pull?pull=` | `running` `done` `canceled` `error` | pull con progreso por capa |
| `#stack-edit?stack=…&yaml=broken&run=up\|done&file=env` | | editor con errores de validación, progreso de `up`, pestaña `.env` |
| `#conn-new?test=` | `testing` `ok` `fail` | formulario de conexión con resultado de la prueba |

Estados globales frente a locales: el **error de conexión** (`error/daemon/ssh/lost`) es global y persiste al cambiar de vista hasta reconectar; `empty` y `loading` son vistas previas por vista. Todas las vistas de datos, el detalle y los flujos muestran el diagnóstico; **Configuración** siempre funciona (con un aviso) porque es donde se arregla la conexión.

## Seguridad de la plantilla (XSS)

`js/app.js` no concatena HTML con valores crudos: toda plantilla usa la etiqueta `h\`...\``, que **escapa cada valor interpolado**, también dentro de atributos (`data-name`, `aria-label`, `title`…). Solo el HTML ya construido con `h`/`raw()` pasa sin escapar. El JSON de Inspeccionar se escapa antes de colorearse. Se probó con un nombre `x"><img src=x onerror=…>` en contenedores, imágenes, volúmenes, redes y en el diálogo de eliminar: no se ejecuta nada.

**En React:** interpolar siempre con `{valor}` (React escapa) y **nunca** usar `dangerouslySetInnerHTML` con datos de Docker (nombres, etiquetas, variables de entorno y logs son texto no confiable). Los logs y la terminal se pintan con `textContent`/nodos de texto; el color por nivel se aplica con clases, no con HTML del contenedor.

## Mapa de tokens a shadcn / Tailwind v4

Los nombres de `css/tokens.css` son los de shadcn. Para portarlos a `frontend/src/index.css`:

1. Copiar los bloques `:root` y `.dark` de la sección 1 (shadcn) y la 2 (propios). `.light` y la sección 3 son solo de la plantilla.
2. **Radios: una sola fuente.** `index.css` ya define `--radius-sm…4xl` en `@theme inline` a partir de `--radius`; `tokens.css` los repite (con las mismas fórmulas) solo para que el HTML funcione. **No portarlos.** Lo que sí se porta es `--radius: 0.625rem`. El sidebar flotante usa `--radius-2xl` (18 px); `Badge` de shadcn usa `rounded-4xl`, que ya existe.
3. Añadir a `@theme inline` solo los alias nuevos (sin autorreferencias):

```css
@theme inline {
  --color-destructive-foreground: var(--destructive-foreground);
  --color-status-running: var(--status-running);
  --color-status-running-bg: var(--status-running-bg);
  /* ...igual para paused, restarting, exited, dead y created */
  --color-console-bg: var(--console-bg);
  --color-console-fg: var(--console-fg);
  --color-brand-tile: var(--brand-tile);
  --shadow-float: var(--sh-float);     /* las sombras viven en :root como --sh-*; */
  --shadow-dialog: var(--sh-dialog);   /* --shadow-* (Tailwind) apunta a ellas: sin bucle */
  --font-mono: "JetBrains Mono", ui-monospace, monospace;   /* solo aquí; no en :root */
}
```

4. Tipografía: `--font-sans` ya está en `index.css`; `--font-mono` se define **solo** en `@theme inline` (arriba). En `tokens.css` existen `--font-sans/--font-mono` y `--text-*` únicamente para el HTML. La escala de texto de la plantilla (12/13/14/16/20/22 px) difiere de la de Tailwind (base 16); si se quiere portar, sobrescribirla en `@theme` (no inline) con `--text-xs: 0.75rem; --text-sm: 0.8125rem; --text-base: 0.875rem`.
5. `--space-*` se eliminó (no existe en shadcn y no se usaba).
6. `--ring` es **opaco** en ambos temas: los componentes shadcn lo componen con `ring-ring/50` y `outline-ring/50`; un alfa previo dejaba el foco casi invisible. Aun así, a `/50` el anillo baja de 3:1: para los controles principales usar `focus-visible:ring-ring` (sin `/50`).
7. `--input` sube a `oklch(0.62 0.02 165)` (claro) y `oklch(0.52 0.02 165)` (oscuro): 3.4-3.6:1 contra fondo y tarjeta (WCAG 1.4.11). shadcn lo usa como borde, pista del switch y casilla sin marcar.
8. Fallback para motores sin `oklch()` (WebKitGTK antiguo): bloque `@supports not (color: oklch(0 0 0))` al final de `tokens.css`, generado con un script a partir de los mismos valores. No cubre `color-mix()` (hover de botones y filas): en esos motores el hover se pierde, no el contenido.
9. El sidebar es opaco (`--sidebar` sin alfa): se quitó `backdrop-filter` porque no había nada detrás que difuminar y complicaba el `position: fixed` de los menús.

### Componentes shadcn: realidad del proyecto

El proyecto usa `style: "base-nova"` y **`@base-ui/react`** (no Radix). Hoy solo están instalados `badge`, `button` y `table`. Consecuencias al portar:

- Composición con la prop **`render={...}`** (no `asChild`): p. ej. `<Button render={<a href="#create" />}>`.
- `Tooltip` necesita `TooltipProvider` (o `Tooltip.Provider` de Base UI) en la raíz.
- `AlertDialog`: fijar `initialFocus` en el botón **Cancelar** (la política de foco de la plantilla) y, en los diálogos con confirmación escrita, el botón de acción va deshabilitado hasta que coincida el texto.
- **No está verificado** que el registro de shadcn incluya un `Sidebar` con variante flotante y `collapsible="icon"` para `base-nova`; comprobarlo con `pnpm dlx shadcn@latest add sidebar` antes de asumirlo. Si no, el sidebar es un componente propio (la plantilla ya es CSS puro).
- El botón `destructive` de `base-nova` es **tintado** (`bg-destructive/10 text-destructive`), no relleno como el de la plantilla (`.btn-destructive`, `.btn-outline-destructive`). Hace falta una variante propia para el relleno sólido del botón de confirmación.
- `Badge` y `Button` aplican `bg-primary/80` al hover: diluye el contraste del texto sobre el verde de marca (5.27:1 en claro). Evitar `/80` en primary o comprobar el ratio.
- Los estados de contenedor son una variante propia de `Badge` (`running|paused|restarting|exited|dead|created`) con icono obligatorio.

| Vista | Componentes |
|---|---|
| Shell | Sidebar (ver arriba), `Tooltip` para el riel, `DropdownMenu` (selector de conexión), `Button` icon |
| Contenedores | `Table`, `Checkbox`, `Input`, `ToggleGroup`, `Toggle`, `Badge` (variante de estado), `Button`, `AlertDialog`, `Skeleton`, `Sonner`, `Alert` |
| Detalle | `Tabs`, `ScrollArea`, `Input`, `Switch`, `Card`, xterm.js (terminal real), gráficas propias o Recharts |
| Nuevo contenedor / conexión | `Card`, `Input`, `Select`, `ToggleGroup`, `Button`, `Alert` |
| Pull y `up` de stack | `Progress` (una barra por capa/servicio), `Button`, `Alert` |
| Editor de stack | `Textarea` (después CodeMirror/Monaco), `ToggleGroup`, lista de validación |
| Imágenes / Volúmenes / Redes / Stacks | `Table`, `Badge`, `Button`, `AlertDialog`, `Empty`, `Skeleton`, `Card`, `Alert` |
| Global | `Command` (Ctrl+K), `Sonner` |

## Encabezado de vista (patrón único)

Cada vista: **título + contador** a la izquierda; **acciones secundarias**, luego la **primaria** (relleno de marca) a la derecha; debajo, una **barra de herramientas** (búsqueda, filtros) en las vistas de lista. Aplicado a Contenedores, Imágenes, Volúmenes, Redes, Stacks y Configuración (contador «3 conexiones»); las vistas de flujo (crear, pull, editor, nueva conexión) añaden un enlace «volver» encima del título. Las acciones destructivas van separadas de las demás por un separador vertical y con puntos suspensivos («Eliminar…») cuando abren un diálogo.

**Ventana mínima real: 900×600.** Bajo 1000 px el **riel de iconos es el modo por defecto**. Datos secundarios (imagen, puertos, actividad) pasan a una segunda línea bajo el nombre con *container queries* en vez de desaparecer.

## Política de confirmación en la interfaz (`ConfirmationPolicy`)

| Resultado | En la GUI |
|---|---|
| Allow | Sin diálogo: iniciar, detener, reiniciar, ver logs |
| Confirm | Diálogo con lo afectado. Eliminar contenedor avisa de `--force` si está en ejecución, lista los volúmenes montados (no se borran: no se envía `v=true`) y, en lote, enumera los nombres. Eliminar volumen, volúmenes sin usar y bajar stack piden **escribir el nombre o ELIMINAR** y listan tamaños; el prune de volúmenes exige persona incluso con «omitir confirmaciones» |
| Deny · Forbidden | Diálogo bloqueado (solo «Entendido»): «Limpiar todo el sistema» |
| Deny · NeedsConfirmationNonInteractive | **No aplica en la GUI** (es del modo CLI sin terminal); en la GUI siempre se puede pedir confirmación |
| Denegación inesperada del backend | Toast de error persistente con el motivo (`?policy=denied`); indica que es un fallo de la app, no del usuario |

«Limpiar todo el sistema» se deja como **demostración bloqueada** en Configuración con texto que explica por qué no existe (borra contenedores, redes, imágenes y caché sin poder revisar qué se pierde). Si el producto prefiere no mostrar acciones imposibles, basta con quitar esa fila y la entrada de la paleta.

## Estados y flujos cubiertos

Vacío, esqueleto de carga, error de conexión en tres variantes (sin permiso al socket, daemon apagado, SSH), desconectado durante el uso, Compose no instalado, spinner y error **por fila** (`mailpit-pruebas` falla al iniciar la primera vez), toasts (correcto, aviso, error persistente), formulario de nuevo contenedor con validación y aviso de ruta relativa en contexto remoto, «Ejecutar» desde una imagen, pull con progreso por capa y cancelación, editor de stack con `.env`, validación en vivo y progreso de `up`, alta de conexión SSH/TLS con «Probar conexión».

## Decisiones y porqué

- **Sin barra superior.** Título, búsqueda y acciones viven en el contenido; se gana altura útil (clave a 600 px).
- **Sidebar flotante** con margen de 12 px, radio 18 px, borde y sombra. Colapsa a riel de 64 px; el tooltip del riel es un único elemento fijo (ningún `overflow` lo recorta) y el menú de conexiones también es `position: fixed`.
- **Verde de marca frente a verde de estado.** Marca: matiz 160 (teal), solo acciones, selección, foco y logo. `running`: matiz 128 (lima) con icono ● y texto, en píldora tintada; ▶ queda solo para la acción «Iniciar» (sin colisión de iconos). Seis estados, seis formas: se leen en escala de grises. La razón de luminancia entre ambos verdes es baja (1.39-1.46:1), así que la distinción descansa en matiz (≈ 30°), forma y texto, no en el brillo.
- **Dark-first** con neutros teñidos de verde (matiz 165, croma 0.014-0.02).
- **Logotipo A** (D con contenedor): legible a 16 px, monocromo sin pérdida. Wordmark convertido a trazos (Geist 700 + 400).
- **Consola siempre oscura** también en tema claro; nivel de log en texto además de color.
- **Datos en vivo ≠ animación.** `prefers-reduced-motion` elimina transiciones y giros, pero logs y estadísticas siguen actualizándose. Los logs añaden un nodo por línea (no reemplazan el `role="log"`).
- **Foco:** al reconstruir una vista se restaura el foco en el elemento equivalente (por `data-fk` o firma); las acciones en curso usan `aria-disabled` en vez de `disabled` para no perderlo. Diálogos con trampa de Tab real, `aria-modal` y foco inicial en Cancelar.
- **Actualización de datos:** por eventos del motor; el sondeo cada 5 s queda como respaldo opcional y apagado.

## Cuestiones abiertas

1. **Sidebar flotante en shadcn `base-nova`:** sin verificar que exista en el registro (ver arriba).
2. **Botón destructivo:** definir la variante propia sólida frente a la tintada de `base-nova`.
3. **Contraste de los dos verdes:** distinguibles por matiz, forma y texto, no por luminancia; validar con personas con deficiencia de visión cromática.
4. **Anillo de foco en claro:** 3.77:1 (justo sobre el mínimo). Con `ring-ring/50` de shadcn no llega a 3:1.
5. **Editor de YAML:** el `textarea` es una maqueta; el producto real necesita un editor con resaltado (CodeMirror) y validación con `docker compose config`.
6. **Tesela del logotipo** (`#00935d` con blanco) llega a 3.78:1: válida como gráfico, no para texto sobre ella.
7. **Ctrl+K:** falta buscar contenedores por nombre y ejecutar acciones sobre ellos.
8. **Sin verificar** en WebKitGTK/Tauri reales ni con lector de pantalla; solo Chromium headless y pruebas de comportamiento por script.
