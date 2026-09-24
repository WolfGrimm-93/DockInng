# Pendientes — DockInng

Ver detalle y contexto en Obsidian: `Proyectos/DockInng/DockInng - Pendientes.md`.

## Siguiente (MVP)
- [ ] Acciones en la UI: iniciar/detener/eliminar contenedor (con `ConfirmationPolicy` y diálogo de confirmación).
- [ ] Eventos en vivo de Docker (`/events`) en lugar de recarga manual.
- [ ] Logs en vivo (stream multiplexado).
- [ ] Imágenes, volúmenes y redes.
- [ ] Mover el listado de estados a `services` cuando haya más de un adaptador (GUI + CLI).

## Sin verificar
- [x] Verificado (2026-09-24): el webview de Tauri llama a `list_containers` y recibe los contenedores reales de Docker (34 en la prueba). Sigue sin haber una captura visual de la tabla renderizada.
- [ ] Esquema real de `docker compose --progress json`.
- [ ] Compose sobre contexto SSH.

## Entorno
- [ ] Falta `libayatana-appindicator` (necesario solo si se quiere tray).
- [ ] Icono actual es provisional (generado); diseñar el definitivo.
- [ ] 2 warnings de oxlint en componentes generados por shadcn (`button.tsx`, `badge.tsx`); no son de código propio.
