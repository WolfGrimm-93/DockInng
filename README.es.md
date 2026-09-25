[English](README.md) | [Español](README.es.md)

# DockInng

Aplicación de escritorio nativa para Linux que administra Docker desde una interfaz gráfica, al estilo de Docker Desktop. Habla directo con la Docker Engine API. Una CLI complementaria (`dockinng`) comparte el mismo núcleo.

> Estado: en desarrollo. La interfaz completa está implementada. **Datos reales de Docker:** contenedores (listar, iniciar, detener, reiniciar, eliminar, eventos en vivo, logs, stats, inspect) e imágenes, volúmenes y redes (listar, eliminar). **Simulado y marcado como "No conectado aún" en la UI:** terminal embebida, pull de imágenes, crear contenedor, stacks de Compose y conexiones SSH/TLS. Detalle en [PENDIENTES.md](PENDIENTES.md).

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Rust, tokio, [bollard](https://crates.io/crates/bollard), workspace de Cargo |
| Shell de escritorio | Tauri 2 |
| Frontend | React, TypeScript, Vite, shadcn/ui, Tailwind CSS (`pnpm`) |

## Estructura

```
backend/
  crates/engine-core     modelos de dominio, trait EngineClient, ConfirmationPolicy
  crates/engine-docker   adaptador de EngineClient sobre bollard
  crates/dockinng-cli    binario `dockinng` (clap)
  app/                   shell Tauri (comandos IPC)
frontend/                UI con React + Vite (shadcn/ui + Tailwind)
platilla-html/           referencia de diseño aprobada (libro de marca + plantilla HTML)
```

La GUI y la CLI son adaptadores del mismo núcleo; el frontend nunca habla con Docker directamente.

## Requisitos

Rust (stable), Node.js, `pnpm`, Docker y las dependencias de Tauri para Linux (WebKitGTK 4.1, GTK 3, librsvg). Tu usuario debe poder acceder al socket de Docker (grupo `docker`).

## Desarrollo

```bash
# Dependencias del frontend
pnpm --dir frontend install

# App de escritorio (levanta Vite y el shell Tauri)
pnpm --dir frontend tauri dev

# CLI
cd backend && cargo run -p dockinng-cli -- doctor
cd backend && cargo run -p dockinng-cli -- ps -a

# Tests
cd backend && cargo test
cd frontend && pnpm test && pnpm build && pnpm lint
```

## Apariencia

Configuración > Apariencia permite elegir modo claro, oscuro o sistema, un color de acento (presets o matiz personalizado), un tinte de superficies independiente y combinaciones con nombre. Los tokens se calculan en OKLCH y se validan con contraste WCAG AA en todos los matices. Los colores de estado y el logo no cambian con el acento.

## Grupos

Los contenedores se agrupan automáticamente por stack de Compose (cada stack tiene su color y en la cabecera del grupo se muestran las redes que usa). También puedes crear tus propios grupos (menú de cada fila o barra masiva), elegir cualquier color para un grupo o un stack y gestionarlos en Configuración > Grupos. Los grupos propios se guardan solo en la app, por conexión, y no cambian nada en Docker.

La Configuración está dividida en pestañas: Conexiones, Apariencia, Grupos, Seguridad y Datos.

## Seguridad

Las acciones destructivas pasan por una `ConfirmationPolicy` en el núcleo: las reversibles se ejecutan directo, las destructivas piden confirmación, y hay un piso de acciones catastróficas que ni `--yes` puede saltar. Sin TTY, todo lo que requiera confirmación se deniega. En la app de escritorio, las acciones destructivas siguen un flujo plan → ticket de un solo uso → confirmación escrita que hace cumplir el backend (las de un único objetivo exigen el nombre exacto; los prunes exigen la palabra `ELIMINAR`). Riesgo aceptado y conocido: un webview comprometido aún podría llamar a los comandos de plan/ejecución, así que la CSP estricta y la ausencia de contenido remoto son la barrera real.
