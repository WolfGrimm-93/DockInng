# Entrega Wave 4 — corrección auditada (seguridad y responsive)

Rama: `feature/wave4-security` · Fecha de cierre de documentación: 2026-10-04 · Estado: **pendiente de commit y de revisión humana** (no se ha hecho commit, push ni merge).

Este documento empaqueta los 7 cambios ya presentes en el worktree, sin añadir código. Separa tres tipos de evidencia: lo verificado en esta sesión, lo heredado del handoff (con su log cuando existe) y lo que **no** se ejecutó.

## 1. Changelog

### Unreleased — Wave 4

**Seguridad**
- `backend/crates/compose/src/runner.rs`: antes de invocar Compose, se rechazan referencias locales que salgan del directorio del proyecto en `include`, `extends.file` y `env_file` (rutas relativas con `..`, rutas absolutas y rutas que resuelven fuera tras `canonicalize`). Devuelve `ComposeError::Invalid` con la línea ofensora. Se añade el test `rutas_compose_locales_no_escapan_del_proyecto`.

**Corrección de flujo de conexión**
- `frontend/src/data/store/engineStore.ts`: al fallar `connection_select` en modo Tauri (conexión distinta de `local`) se elimina la llamada a `resumePrevious(status.quiesced)`; ahora solo se muestra el toast y se retorna.
- `frontend/src/data/types.ts`: se quita `quiesced?` de la variante `failed` de `ConnectionStatus`. El indicador vive en `ApiError` de `connection_select`, según la nota actualizada en `PENDIENTES.md`.

**Accesibilidad**
- `frontend/src/components/shared/StateViews.tsx`: el tag «No conectado aún» (`SimulatedTag`) expone `role="status"` y `aria-label` con el mismo texto que el `title`.
- `frontend/src/components/shared/StatusBadge.test.tsx`: aserción de ese rol y nombre accesible.

**Responsive (ventanas embebidas o redimensionadas por debajo de 900 px)**
- `frontend/src/styles/app.css`: bloque `@media (max-width: 640px)` que reflujan las cabeceras de vista, acciones, filtros y tablas (`.table-wrap` con scroll propio) para evitar desborde horizontal de la aplicación.

**Documentación**
- `PENDIENTES.md`: actualizados el estado del desborde a 420 px, el test de contrato IPC (marcado como hecho) y la nota sobre `quiesced`. Sección nueva de pendientes de validación de esta entrega.
- `docs/ENTREGA-WAVE4.md`: este documento.

## 2. Matriz de hallazgos

| ID | Hallazgo / cambio | Archivo | Estado | Evidencia | Residual |
|----|-------------------|---------|--------|-----------|----------|
| W4-01 | `include`/`extends`/`env_file` locales podían leer ficheros fuera del proyecto | `backend/crates/compose/src/runner.rs` | Corregido | Test `runner::tests_remote::rutas_compose_locales_no_escapan_del_proyecto ... ok` en `/tmp/w4_cargo_test.log:75` | El escaneo es por líneas y heurístico; los valores con `${...}` se omiten (ver R-02) |
| W4-02 | Reanudar operaciones previas tras fallar la conexión en Tauri | `frontend/src/data/store/engineStore.ts` | Corregido (cambio de comportamiento) | Heredada: suite frontend y contrato. No hay test específico identificado en los logs | Revisar si alguna operación previa debía reanudarse (R-03) |
| W4-03 | Campo `quiesced` declarado en TS pero nunca enviado en `ConnectionStatus` | `frontend/src/data/types.ts` | Corregido | Heredada: `contract:check` y `contract_fixtures` (`los_errores_cubren_los_veinte_codigos_y_la_forma_de_cause_y_quiesced ... ok`) | Ninguno conocido |
| W4-04 | Tag «No conectado aún» sin nombre accesible para lectores de pantalla | `StateViews.tsx`, `StatusBadge.test.tsx` | Corregido | Heredada: suite frontend (61 archivos, 727 tests). Verificación AT-SPI **no ejecutada** | Sin prueba en WebKitGTK/AT-SPI (ver sección 5) |
| W4-05 | Desborde horizontal a 420 px en páginas nuevas | `frontend/src/styles/app.css` | Corregido parcialmente | Chromium headless 420 px: capturas de **containers** y **stacks** (`/tmp/w4_420_containers.png`, `/tmp/w4_420_stacks.png`) | Solo esas dos vistas; el resto de páginas nuevas no tiene captura (R-04) |
| W4-06 | Contrato IPC TS derivado a mano | `backend/app` + `frontend/scripts/contract-gen.mjs` | Verificado | `contract_fixtures` 6 passed (`/tmp/w4_contract.log`) | Ninguno conocido |

## 3. Instrucciones reproducibles de validación

Requisitos: Rust estable, Node.js, `pnpm`, dependencias de Tauri Linux (WebKitGTK 4.1, GTK 3, librsvg) para compilar el backend de la app. Gestor de paquetes: **solo `pnpm`** en frontend; **solo `cargo`** en backend.

Ejecutar desde la raíz del worktree. Cada comando es independiente del directorio actual: el backend se indica con `cargo --manifest-path backend/Cargo.toml` y el frontend con `pnpm --dir frontend`, así que no hace falta hacer `cd` entre líneas ni depender de un `cd` anterior.

```bash
# Dependencias
pnpm --dir frontend install
cargo --manifest-path backend/Cargo.toml fetch

# Backend (workspace completo)
cargo --manifest-path backend/Cargo.toml check
cargo --manifest-path backend/Cargo.toml test
cargo --manifest-path backend/Cargo.toml build

# Frontend
pnpm --dir frontend typecheck
pnpm --dir frontend test
pnpm --dir frontend lint
pnpm --dir frontend build

# Contrato IPC Rust ↔ TypeScript (ejecuta cargo test -p dockinng-app contract_fixtures y --check)
pnpm --dir frontend contract:check

# Higiene del diff (desde la raíz del worktree)
git diff --check
git status --short --branch
```

Criterios de aceptación:
- `cargo test`: 0 fallos. Referencia del handoff: 552 pasan, 0 fallan, 37 ignorados (los ignorados requieren `DOCKINNG_LIVE_*`, ver sección 5).
- `pnpm test`: 0 fallos. Referencia: 61 archivos, 727 tests.
- `pnpm lint`: exit 0. Se acepta **1 warning preexistente** en `frontend/src/features/settings/ConnNewPage.tsx:73` (`react(set-state-in-effect)`), que aparece también en la línea base.
- `git diff --check`: sin salida y exit 0.

Comprobación Docker (opcional, solo lectura): los recursos de desarrollo de este proyecto son `dockinng-dev-web` (puerto 54100) y `dockinng-dev-redis` (54101), definidos en `docker-compose.yml`. El bloque reservado es 54100-54110.

```bash
docker ps -a --filter "name=dockinng-dev-" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Este comando solo inspecciona. No crea, arranca, detiene ni elimina nada. Si aparecen recursos `dockinng-dev-*` activos, no se consideran parte de la validación de esta entrega.

## 4. Evidencia de pruebas

### 4.1 Ejecutado y verificado en esta sesión

| Comando | Resultado |
|---------|-----------|
| Lectura de `/tmp/w4_cargo_check.log`, `w4_cargo_build.log`, `w4_cargo_test.log` | Contienen `EXIT_CHECK=0`, `EXIT_BUILD=0`, `EXIT_TEST=0` |
| Suma de líneas `test result:` de `/tmp/w4_cargo_test.log` | 552 passed, 0 failed, 37 ignored (28 bloques de resultado) |
| Búsqueda de `rutas_compose_locales_no_escapan_del_proyecto` en el log | `... ok` |
| Búsqueda de `EXIT` en todos los logs `/tmp/*.log` | Solo los tres `EXIT_*` de cargo; no hay líneas EXIT para frontend |
| Búsqueda del error del wrapper glob en los logs | **No encontrado** (ver R-05) |
| `git status --short --branch` y `git diff --stat` | Ver sección 6 |

### 4.2 Heredado del handoff (no re-ejecutado en esta sesión)

| Validación | Evidencia | Observación |
|------------|-----------|-------------|
| `cargo check` | `EXIT_CHECK=0`, 0 avisos `^warning` | Log en este worktree |
| `cargo test` | `EXIT_TEST=0`, 552/0/37 | Log en este worktree |
| `cargo build` | `EXIT_BUILD=0` | Log en este worktree |
| `pnpm typecheck` (`tsc -b`) | `/tmp/w4_typecheck.log` sin errores | **Sin línea EXIT** en el log |
| `pnpm build` | `/tmp/w4_build.log`: `✓ built in 388ms` | **Sin línea EXIT** en el log |
| `pnpm lint` | `/tmp/w4_lint.log`: 1 warning (ConnNewPage.tsx:73) | **Sin línea EXIT**. La línea base `/tmp/wc-base-fe-lint.log` muestra el mismo warning, así que es preexistente |
| `pnpm test` | `/tmp/wc-base-fe-test.log`: `Test Files 61 passed (61)`, `Tests 727 passed (727)` | **Este log proviene del worktree `wave4-contracts`, no de `wave4`**. No hay log de `pnpm test` de este worktree |
| `pnpm contract:check` | `/tmp/w4_contract.log`: 6 `contract_fixtures` ok, `contract.generated.ts al día` | Log en este worktree |
| `git diff --check` | EXIT 0 según handoff | Se repite en la sección 6 |
| Chromium headless 420 px | Capturas de containers y stacks en `/tmp` | Las capturas no se volvieron a revisar en esta sesión |
| Inspección Docker no destructiva | Sin recursos `dockinng-dev-*` activos según handoff | Sin log |

### 4.3 No ejecutado

- Live tests que requieren `DOCKINNG_LIVE_TESTS=1` (y, según el caso, `DOCKINNG_LIVE_SSH=1`, `DOCKINNG_LIVE_REAL_SSH=1` o `DOCKINNG_LIVE_KEYRING=1`). Son los tests ignorados de `cargo test`, 37 según el handoff del backend.
- Smoke test con Docker real sobre `dockinng-dev-*`.
- Tauri / WebKitGTK / AT-SPI: arranque y pruebas nativas de la entrega.
- Flujos interactivos y diálogos (confirmación tipeada, cierre con operación en curso, foco con Tab).
- Revisión de páginas distintas de containers y stacks a 420 px.

## 5. Riesgos conocidos y residuales

- **R-01 (diseño, `runner.rs`)**: el escaneo de `include`/`extends`/`env_file` es por líneas y no es un parser YAML. Un YAML muy retorcido podría eludirlo. Las validaciones de `include` remotos siguen siendo de mejor esfuerzo (ya en `PENDIENTES.md`, Ola 1).
- **R-02 (`runner.rs`)**: cualquier línea que contenga `${` se omite del chequeo. Una ruta como `include: ${DIR}/../x.yaml` no se valida. Es el residual de seguridad más relevante de esta entrega; requiere decisión: rechazar `${` en esas claves o resolver la variable antes de comprobar.
- **R-03 (`engineStore.ts`)**: se eliminó `resumePrevious(status.quiesced)` en el fallo de conexión. Es un cambio de comportamiento. Si alguna operación previa debía reanudarse tras un fallo de conexión, ya no lo hace. No hay test específico identificado; hay que revisarlo antes de cerrar la entrega.
- **R-04 (responsive, `app.css`)**: la corrección de 420 px solo tiene evidencia visual de containers y stacks. `PENDIENTES.md` marca el desborde como corregido; la afirmación aplica a esas dos vistas hasta que se capturen las demás.
- **R-05 (wrapper glob)**: el handoff menciona un error aislado del wrapper glob. **No aparece en ningún log disponible** (`/tmp/*.log`); las coincidencias de «glob» son el crate `glob` y el test `progress_es_global_y_va_antes_del_subcomando`. No se registra como fallo ni como residual confirmado. Hace falta el origen exacto del error para documentarlo.
- **R-06 (procedencia de evidencia frontend)**: `pnpm test` (61/727) está en un log de `wave4-contracts`, y `typecheck`/`build`/`lint` no tienen línea EXIT. La evidencia frontend de este worktree queda pendiente de reejecutar.
- **R-07 (Obsidian)**: no se localizó la nota «Estándar - Nomenclatura y Puertos de Contenedores Docker» en `/mnt/toji`. El bloque 54100-54110 está confirmado solo por el comentario de `docker-compose.yml`. Hay que contrastarlo con la tabla de rangos antes de publicar.
- **R-08 (`frontend/src/data/types.ts`)**: el campo `quiesced` se retira del tipo TS. El contrato Rust lo sigue usando en `ApiError`; `contract:check` pasa, pero conviene confirmar con una operación real de conexión fallida (no ejecutada).
- **R-09 (artefactos)**: los logs están en `/tmp`, fuera del repo, y se pueden perder al reiniciar. `*.log` está en `.gitignore`, así que no se incluyen en el commit.

## 6. Decisiones pendientes

1. ¿Commit en `feature/wave4-security`? (No se ha hecho.)
2. ¿Resolver R-02 antes de la entrega o registrarlo como pendiente aceptado?
3. ¿Confirmar R-03 con el autor del cambio en `engineStore.ts`?
4. ¿Reejecutar `pnpm test`, `lint`, `typecheck` y `build` en `wave4` para tener evidencia local con EXIT?
5. ¿Dónde vive el changelog definitivo? El repo no tiene `CHANGELOG.md`; esta sección está en `docs/ENTREGA-WAVE4.md`.
