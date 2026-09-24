[English](README.md) | [Español](README.es.md)

# DockInng

A native Linux desktop app to manage Docker from a graphical interface, in the spirit of Docker Desktop. It talks directly to the Docker Engine API. A companion CLI (`dockinng`) shares the same core.

> Status: early development (skeleton + first vertical slice: list containers).

## Stack

| Layer | Technology |
|---|---|
| Backend | Rust, tokio, [bollard](https://crates.io/crates/bollard), Cargo workspace |
| Desktop shell | Tauri 2 |
| Frontend | React, TypeScript, Vite, shadcn/ui, Tailwind CSS (`pnpm`) |

## Layout

```
backend/
  crates/engine-core     domain models, EngineClient trait, ConfirmationPolicy
  crates/engine-docker   EngineClient adapter on top of bollard
  crates/dockinng-cli    `dockinng` binary (clap)
  app/                   Tauri shell (IPC commands)
frontend/                React + Vite UI
docs/
```

The GUI and the CLI are adapters over the same core; the frontend never talks to Docker directly.

## Requirements

Rust (stable), Node.js, `pnpm`, Docker, and the Tauri Linux dependencies (WebKitGTK 4.1, GTK 3, librsvg). Your user must be able to access the Docker socket (group `docker`).

## Development

```bash
# Frontend deps
pnpm --dir frontend install

# Desktop app (starts Vite and the Tauri shell)
pnpm --dir frontend tauri dev

# CLI
cd backend && cargo run -p dockinng-cli -- doctor
cd backend && cargo run -p dockinng-cli -- ps -a

# Tests
cd backend && cargo test
cd frontend && pnpm build && pnpm lint
```

## Safety

Destructive actions go through a `ConfirmationPolicy` in the core: reversible actions run directly, destructive ones ask for confirmation, and there is a floor of catastrophic actions that not even `--yes` can bypass. Without a TTY, anything that needs confirmation is denied.
