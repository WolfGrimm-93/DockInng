[English](README.md) | [Español](README.es.md)

# DockInng

Aplicación de escritorio nativa para Linux que administra Docker desde una interfaz gráfica, al estilo de Docker Desktop. Habla directo con la Docker Engine API. Una CLI complementaria (`dockinng`) comparte el mismo núcleo.

> Estado: desarrollo temprano (esqueleto + primer corte vertical: listar contenedores).

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
frontend/                UI con React + Vite
docs/
```

La GUI y la CLI son adaptadores del mismo núcleo; el frontend nunca habla con Docker directamente.

## Requisitos

Rust (stable), Node.js, `pnpm`, Docker y las dependencias de Tauri para Linux (WebKitGTK 4.1, GTK 3, librsvg). Tu usuario debe poder acceder al socket de Docker (grupo `docker`).

## Desarrollo

```bash
# Dependencias del frontend
pnpm --dir frontend install

# App de escritorio (levanta Vite y el shell Tauri)
cd backend/app && ../../frontend/node_modules/.bin/tauri dev

# CLI
cd backend && cargo run -p dockinng-cli -- doctor
cd backend && cargo run -p dockinng-cli -- ps -a

# Tests
cd backend && cargo test
cd frontend && pnpm build && pnpm lint
```

## Seguridad

Las acciones destructivas pasan por una `ConfirmationPolicy` en el núcleo: las reversibles se ejecutan directo, las destructivas piden confirmación, y hay un piso de acciones catastróficas que ni `--yes` puede saltar. Sin TTY, todo lo que requiera confirmación se deniega.
