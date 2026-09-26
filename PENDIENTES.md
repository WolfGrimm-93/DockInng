# Pendientes — DockInng

Ver detalle y contexto en Obsidian: `Proyectos/DockInng/DockInng - Lista de trabajo.md` y `DockInng - Pendientes.md`.

## Simulado en la UI (marcado "No conectado aún"; no funciona contra Docker)
- [ ] Conexiones SSH/TLS y selector de contexto remoto (hoy solo el motor local es real). Ola 2.

## Ola 1: pendientes tras la auditoría (rama `feature/wave1-stacks-terminal-images`)
- [ ] **Cerrar la ventana con una operación en curso** (up/pull): `beforeunload` probablemente no se dispara con el botón de cerrar de Tauri/WebKitGTK; al destruir la ventana se hace SIGTERM a compose y el stack puede quedar a medias. Verificar con la ventana real y, si hace falta, confirmar desde el backend.
- [ ] «Abrir archivo Compose» exige escribir la ruta: falta el selector nativo (`tauri-plugin-dialog` + permiso `dialog:allow-open`).
- [ ] Riesgo aceptado: con `stack_create` + `run_stack_op(up)` con `privileged` o bind a `/` se obtiene root en el host sin ticket; la barrera real es la CSP y la ausencia de contenido remoto.
- [ ] El pre-escaneo de `include` remoto (git/oci/http/ssh) es de mejor esfuerzo por líneas: un YAML muy retorcido podría evadirlo. `include`/`extends`/`env_file` locales que salgan del directorio del stack no se restringen. Sin test del tope de 2 validaciones simultáneas.
- [ ] Un fallo de un archivo linked/descubierto inválido puede filtrar un fragmento en el mensaje de error de Compose (truncado a 2 KiB y con los valores del `.env` ocultos).
- [ ] Cerrar la terminal en un Docker REMOTO no mata el shell (el respaldo Ctrl-C + `exit` está sin probar; el `kill -HUP` por cgroup solo funciona con motor local).
- [ ] Sin verificar: xterm y CodeMirror en WebKitGTK real (portapapeles, teclado, rendimiento con salida masiva, lectores de pantalla); pull contra Docker Hub o registros con credenciales; Compose distinto de 5.5.1 y v1; estado `Warning` de `--progress json`; contenedor sin `/bin/sh`.
- [ ] El test live de pull por capas y cancelación (`live_engine.rs`, `live_pull_por_capas_y_cancelacion_contra_registro_local`) se salta solo si no hay registro en 127.0.0.1:54109 (`DOCKINNG_LIVE_REGISTRY=1`) y aparece como «ok»: pull por capas y cancelación no están probados contra un registro real (requiere una imagen `registry:2` local).
- [ ] La validación simulada de YAML (`lib/yamlCheck.ts`) es heurística (p. ej. `services: [` sin cerrar pasa); solo importa en el modo simulado, el real usa `docker compose config`.
- [ ] La CLI solo tiene `ps/start/stop/restart/rm/doctor`: faltan imágenes, volúmenes, redes y stacks (Ola 2).
- [ ] Los tests del editor y de la terminal usan CodeMirror/xterm simulados en jsdom; lo real solo se probó en Chromium con guiones fuera del repo.

## Grupos propios y consumo (rama `feature/containers-ux`)
- [ ] Los grupos propios y los colores de stack se guardan en `localStorage` (por conexión y por nombre de contenedor). Migrar al crate `store` (SQLite) cuando exista (X2); mientras tanto no se sincronizan entre equipos ni se exportan.
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
- [ ] Compose sobre SSH.
- [ ] Heurística TTY de bollard falla si la salida empieza con un byte de control ≤2 (caso raro).
- [ ] `time_nano` (i64) pierde precisión en JS por encima de 2^53; no se usa aún.

## Deuda técnica
- [ ] 11 avisos de oxlint `only-export-components` (fast refresh) en archivos de componentes compartidos.
- [ ] Licencia OFL de Geist junto a las fuentes (falta el texto oficial).
- [ ] Icono provisional (generado); diseñar el definitivo. `wordmark` convertido a trazos, revisar en producción.
- [ ] Falta `libayatana-appindicator` (solo necesario para tray).
- [ ] Mover lógica compartida a `services` cuando haya más de un adaptador (GUI + CLI).

## Hecho (esta rama)
- [x] **Ola 1:** stacks Compose reales (descubrir, up/down/restart/stop/start/pull con progreso y cancelación, editor YAML/`.env` con validación, propios/vinculados/descubiertos, bajar y eliminar con nombre), terminal exec real con xterm, pull con progreso por capa, crear contenedor real con confirmación de riesgos y elección de grupo, nuevo volumen y nueva red.
- [x] Diseño completo implementado, sidebar flotante, temas y personalización de color.
- [x] Contenedores reales: listar, iniciar, detener, reiniciar, eliminar, eventos, logs, stats, inspect.
- [x] Imágenes, volúmenes y redes reales: listar y eliminar.
- [x] `ConfirmationPolicy` ampliada con tickets, confirmación escrita y aplicación en el backend.
- [x] Diagnóstico de conexión (socket ausente, permisos, daemon apagado) y reconexión.
