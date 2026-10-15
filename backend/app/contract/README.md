# Contrato IPC generado desde Rust

`fixtures.json` lo genera el test `contract_fixtures` de `dockinng-app` a partir de los tipos
Rust reales. No se edita a mano.

- Regenerar: `UPDATE_CONTRACT=1 cargo test -p dockinng-app contract_fixtures`
- Comprobar (falla si está desactualizado): `cargo test -p dockinng-app contract_fixtures`

## Forma del archivo

```
{
  "version": 1,
  "note": "...",
  "commands":   { "<comando>": { "args": {...}, "result_type": "...", "result": <json> } },
  "api_errors": { "by_code": {<code>: ApiError}, "by_cause": {<cause>: ApiError}, "quiesced": ApiError },
  "feeds":      { "<NombreFeed>": [ <una instancia por variante>... ] },
  "enums":      { "<Enum>": ["valor", ...] },       // enums de variantes unitarias, todas
  "types":      { "<Enum>": [ <una instancia por variante>... ] }  // enums con datos, todas
}
```

- `commands`: hay una entrada por cada nombre de `src/command_names.rs` (72). `args` son los
  argumentos EXACTOS que envía la webview a `invoke` (camelCase; el test los compara con la firma
  Rust). Un argumento que en la webview es un `Channel` aparece como `{"$channel": "<Feed>"}`.
  `result` es lo que devuelve Rust en éxito (`null` para `()`); `result_type` usa nombres de
  tipos Rust (`T[]` lista, `T | null` opcional, `void`, `string`, `json`).
- `api_errors`: `ApiError` serializado. `cause` va siempre (`null` si no aplica); `quiesced` solo
  aparece (con `true`) cuando es verdadero. Hay 20 códigos y 10 causas.
- `feeds`: `EngineFeed`, `LogFeed`, `StatsFeed`, `ExecFeed`, `PullFeed`, `StackOpFeed`,
  `BuildFeed`, `AppFeed`. Cada elemento lleva `type` (etiqueta serde) y cubre todas las variantes.
- Los enums tienen un `match` sin comodín en Rust: añadir una variante obliga a añadir su fixture.

## Cambios de la Ola 3 relevantes para la webview

- El backend NO emite eventos de Tauri (`listen` exigiría permisos `core:event:*`): los avisos
  de la app llegan por el canal de `subscribe_app_events` (`AppFeed`).
- `execute_action(ticket, typed)`: NO recibe confirmación del webview. Si el ticket la exige, la
  app muestra un diálogo NATIVO (`approvals.rs`); sin aceptación responde `policy_denied` y el
  ticket sigue vivo. Con `ConfirmTyped` el texto va en `typed` y se valida después del diálogo.
- `AppFeed = {type:"quit_requested", summary:{stacks,pulls,builds,terminals}} |
  {type:"window_visibility", visible:boolean}`. Ante `quit_requested` la UI confirma y llama
  `quit_app({confirmed:true})`.
