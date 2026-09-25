# Pendientes — DockInng

Ver detalle y contexto en Obsidian: `Proyectos/DockInng/DockInng - Lista de trabajo.md` y `DockInng - Pendientes.md`.

## Simulado en la UI (marcado "No conectado aún"; no funciona contra Docker)
- [ ] Terminal exec embebida (hoy DOM simulado; xterm.js + PTY en la fase 2).
- [ ] Pull de imágenes con progreso por capa.
- [ ] Crear contenedor / ejecutar desde imagen.
- [ ] Stacks Compose (listar, up/down, editor YAML, `.env`). `stack_down` devuelve `not_implemented`.
- [ ] Conexiones SSH/TLS y selector de contexto remoto (hoy solo el motor local es real).

## Grupos propios y consumo (rama `feature/containers-ux`)
- [ ] Los grupos propios y los colores de stack se guardan en `localStorage` (por conexión y por nombre de contenedor). Migrar al crate `store` (SQLite) cuando exista (X2); mientras tanto no se sincronizan entre equipos ni se exportan.
- [ ] Al crear un contenedor (hoy simulado) permitir elegir grupo desde el formulario.
- [ ] Asignar arrastrando filas a una cabecera de grupo (hoy: menú de la fila o barra masiva).
- [ ] Las asignaciones de contenedores que ya no existen no se limpian (quedan inertes en el almacenamiento).
- [ ] Consumo por grupo: solo cuentan los contenedores en marcha; el disco por grupo es aproximado (capas de escritura + volúmenes, sin imágenes) y Docker solo informa la capa de escritura de parte de los contenedores. GPU solo global (NVIDIA, motor local).

## Puertos (rama `feature/containers-ux`)
- [ ] El modal de puertos muestra rangos colapsados (≥ 3 consecutivos) y une IPv4/IPv6; no expande un rango a puertos sueltos ni permite copiar/abrir un puerto en el navegador.
- [ ] Los alias de DNS solo los da `inspect` (el listado no): la pestaña IPs los pide al abrirse (1 llamada); el modal de redes del grupo no los muestra. No hay IPs por proceso/puerto dentro del contenedor (Docker no lo informa; haría falta `exec`).
- [ ] La vista de Redes no usa puertos (no aplica); la línea de puertos de la vista Stacks (simulada) sigue mostrando el texto completo.

## Riesgos aceptados y decisiones abiertas
- [ ] Un webview comprometido puede llamar a `plan_action` + `execute_action` con el texto de confirmación (no hay diálogo nativo). La barrera real es la CSP y la ausencia de contenido remoto. Reabrir si se carga contenido externo.
- [ ] Confirmar con el usuario: combinaciones de color, tono "bronce" de ámbar/naranja en claro, verde de estado "running" (matiz 128).
- [ ] Riesgo del nombre "DockInng": colisión con otros productos sin verificar.

## Calidad y verificación
- [ ] Verificar la app real con `tauri dev` (IPC, permisos sin `core:default`, CSP) y con `tauri build` (hash del script inline de prepaint).
- [ ] Probar en WebKitGTK real: `color-mix`/`oklch`, foco e `inert`, lectores de pantalla.
- [ ] Test de contrato IPC generado desde Rust (hoy los fixtures TS son manuales y solo `tsc` detecta deriva).
- [ ] Prunes reales de imágenes/volúmenes/redes sin ejecutar contra Docker (solo mocks y plan de solo lectura).
- [ ] Reconexión con el daemon real caído (solo probada con mocks).
- [ ] Esquema real de `docker compose --progress json` y Compose sobre SSH.
- [ ] Heurística TTY de bollard falla si la salida empieza con un byte de control ≤2 (caso raro).
- [ ] `time_nano` (i64) pierde precisión en JS por encima de 2^53; no se usa aún.

## Deuda técnica
- [ ] 12 avisos de oxlint `only-export-components` (fast refresh) en archivos de componentes compartidos.
- [ ] Licencia OFL de Geist junto a las fuentes (falta el texto oficial).
- [ ] Icono provisional (generado); diseñar el definitivo. `wordmark` convertido a trazos, revisar en producción.
- [ ] Falta `libayatana-appindicator` (solo necesario para tray).
- [ ] Mover lógica compartida a `services` cuando haya más de un adaptador (GUI + CLI).

## Hecho (esta rama)
- [x] Diseño completo implementado, sidebar flotante, temas y personalización de color.
- [x] Contenedores reales: listar, iniciar, detener, reiniciar, eliminar, eventos, logs, stats, inspect.
- [x] Imágenes, volúmenes y redes reales: listar y eliminar.
- [x] `ConfirmationPolicy` ampliada con tickets, confirmación escrita y aplicación en el backend.
- [x] Diagnóstico de conexión (socket ausente, permisos, daemon apagado) y reconexión.
