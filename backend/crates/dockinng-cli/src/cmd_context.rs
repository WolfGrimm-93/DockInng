//! `context add|use|ls|rm`: perfiles de conexión guardados (comparten el almacén con la app).
//! `context add` solo guarda metadatos y rutas; la conexión remota se prepara al ejecutar otro
//! comando con `--context` o con la selección predeterminada.

use std::sync::Arc;

use crate::error::CliError;
use engine_core::connections::{SshIdentity, SshMode};
use engine_core::{ActionRequest, ConnSpec, ConnectionControl, EngineError};
use store::Store;

use crate::apply::apply_checked;
use crate::cli::Confirm;
use crate::confirm::{Asker, Stdin};
use crate::ctx::Ctx;
use crate::output::{print_json, print_lines, table};

fn open_store() -> Result<Store, CliError> {
    Store::open_default().map_err(CliError::from)
}

fn find_profile<'a>(
    profiles: &'a [engine_core::ConnectionProfile],
    target: &str,
) -> Result<&'a engine_core::ConnectionProfile, CliError> {
    profiles
        .iter()
        .find(|p| p.id == target || p.spec.name().eq_ignore_ascii_case(target))
        .ok_or_else(|| CliError::Usage(format!("no existe la conexión {target}")))
}

pub fn add(ctx: &Ctx, add: crate::cli::ContextAddCmd) -> Result<(), CliError> {
    let spec = match add {
        crate::cli::ContextAddCmd::Ssh {
            name,
            host,
            port,
            user,
            identity,
            agent: _,
            alias,
        } => ConnSpec::Ssh {
            name,
            host,
            port: port.unwrap_or(if alias { 0 } else { 22 }),
            user,
            mode: if alias {
                SshMode::Alias
            } else {
                SshMode::Explicit
            },
            identity: identity
                .map(|path| SshIdentity::File { path })
                .unwrap_or(SshIdentity::Agent),
        },
        crate::cli::ContextAddCmd::Tls {
            name,
            host,
            port,
            ca,
            cert,
            key,
        } => ConnSpec::Tls {
            name,
            host,
            port,
            ca_path: ca,
            cert_path: cert,
            key_path: key,
        },
    };
    let profile = open_store()?
        .connection_save(&spec, None)
        .map_err(|e| e.to_string())?;
    if ctx.json {
        print_json(&profile)
    } else {
        println!("{}", profile.spec.name());
        Ok(())
    }
}

pub fn use_context(ctx: &Ctx, target: &str) -> Result<(), CliError> {
    let store = open_store()?;
    let profiles = store.connection_list().map_err(|e| e.to_string())?;
    let id = if target.eq_ignore_ascii_case("local") {
        engine_core::LOCAL_CONNECTION_ID.to_string()
    } else {
        find_profile(&profiles, target)?.id.clone()
    };
    store
        .prefs_set("last_connection_id", &serde_json::Value::String(id))
        .map_err(|e| e.to_string())?;
    if !ctx.json {
        println!("{target}");
    }
    Ok(())
}

fn kind(spec: &ConnSpec) -> &'static str {
    match spec {
        ConnSpec::Ssh { .. } => "ssh",
        ConnSpec::Tls { .. } => "tls",
    }
}

pub fn ls(ctx: &Ctx) -> Result<(), CliError> {
    let profiles = open_store()?.connection_list().map_err(|e| e.to_string())?;
    if ctx.json {
        return print_json(&profiles);
    }
    let rows: Vec<Vec<String>> = profiles
        .iter()
        .map(|p| {
            vec![
                p.spec.name().to_string(),
                kind(&p.spec).to_string(),
                format!("{}:{}", p.spec.host(), p.spec.port()),
                p.id.clone(),
            ]
        })
        .collect();
    print_lines(&table(&["NOMBRE", "TIPO", "DESTINO", "ID"], &rows));
    Ok(())
}

/// Adaptador de perfiles sobre el almacén de la CLI: el núcleo no conoce SQLite.
struct StoreProfiles(Arc<Store>);

#[async_trait::async_trait]
impl ConnectionControl for StoreProfiles {
    async fn profile_name(&self, id: &str) -> Result<Option<String>, EngineError> {
        let profiles = self.0.connection_list()?;
        Ok(profiles
            .into_iter()
            .find(|p| p.id == id)
            .map(|p| p.spec.name().to_string()))
    }

    async fn delete_profile(&self, id: &str) -> Result<(), EngineError> {
        self.0.connection_delete(id)?;
        Ok(())
    }
}

/// Borra un perfil guardado (por nombre o id). Pasa por el broker de acciones: plan, ticket,
/// confirmación del usuario y, solo entonces, borrado. No toca el servidor remoto.
pub async fn rm(ctx: &Ctx, target: &str, confirm: Confirm) -> Result<(), CliError> {
    rm_with(ctx, Arc::new(open_store()?), target, confirm, &mut Stdin).await
}

/// Igual que [`rm`] con el almacén y la pregunta inyectados (tests).
pub async fn rm_with(
    ctx: &Ctx,
    store: Arc<Store>,
    target: &str,
    confirm: Confirm,
    asker: &mut dyn Asker,
) -> Result<(), CliError> {
    let profiles = store.connection_list().map_err(|e| e.to_string())?;
    let p = find_profile(&profiles, target)?;
    let name = p.spec.name().to_string();
    let id = p.id.clone();
    let svc = ctx.actions_with_connections(Arc::new(StoreProfiles(store)));
    apply_checked(
        ctx,
        &svc,
        ActionRequest::RemoveConnection { id },
        confirm.yes,
        &format!("¿Eliminar la conexión guardada {name}?"),
        asker,
        |_| Ok(()),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confirm::tests::Script;
    use engine_core::Interactivity;

    /// Almacén temporal con un perfil SSH guardado. Devuelve (directorio, almacén, id).
    fn almacen_con_perfil() -> (std::path::PathBuf, Arc<Store>, String) {
        let dir = std::env::temp_dir().join(format!("dockinng-ctx-rm-{}", uuid::Uuid::now_v7()));
        let store = Arc::new(Store::open(&dir).expect("almacén"));
        let spec = ConnSpec::Ssh {
            name: "prod".into(),
            host: "srv.example".into(),
            port: 22,
            user: "deploy".into(),
            mode: SshMode::Explicit,
            identity: SshIdentity::Agent,
        };
        let p = store.connection_save(&spec, None).expect("guardar");
        (dir, store, p.id)
    }

    fn ctx_interactivo() -> Ctx {
        let mut ctx = Ctx::new(true);
        ctx.interactivity = Interactivity::Interactive;
        ctx
    }

    fn sigue(store: &Store, id: &str) -> bool {
        store
            .connection_list()
            .expect("lista")
            .iter()
            .any(|p| p.id == id)
    }

    /// `context rm` sin aprobación del usuario NO borra el perfil: el ticket nunca se canjea.
    #[tokio::test]
    async fn context_rm_no_borra_sin_ticket_aprobado() {
        let (dir, store, id) = almacen_con_perfil();
        let mut asker = Script {
            yes: false,
            ..Default::default()
        };
        let r = rm_with(
            &ctx_interactivo(),
            store.clone(),
            "prod",
            Confirm { yes: false },
            &mut asker,
        )
        .await;
        assert!(r.is_err(), "el usuario dijo que no");
        assert_eq!(asker.asked, 1, "se preguntó una vez");
        assert!(sigue(&store, &id), "sin aprobación el perfil se conserva");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Con la aprobación del usuario, el perfil se borra al ejecutar el ticket.
    #[tokio::test]
    async fn context_rm_con_aprobacion_borra_el_perfil() {
        let (dir, store, id) = almacen_con_perfil();
        let mut asker = Script {
            yes: true,
            ..Default::default()
        };
        rm_with(
            &ctx_interactivo(),
            store.clone(),
            "prod",
            Confirm { yes: false },
            &mut asker,
        )
        .await
        .expect("borra");
        assert!(!sigue(&store, &id));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `--yes` cuenta como aprobación del gate de la CLI (sin preguntar).
    #[tokio::test]
    async fn context_rm_con_yes_no_pregunta_y_borra() {
        let (dir, store, id) = almacen_con_perfil();
        let mut asker = Script::default();
        rm_with(
            &ctx_interactivo(),
            store.clone(),
            "prod",
            Confirm { yes: true },
            &mut asker,
        )
        .await
        .expect("borra");
        assert_eq!(asker.asked, 0);
        assert!(!sigue(&store, &id));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Sin TTY y sin `--yes` la política deniega: no hay ticket y no se borra nada.
    #[tokio::test]
    async fn context_rm_no_interactivo_sin_yes_no_borra() {
        let (dir, store, id) = almacen_con_perfil();
        let mut ctx = Ctx::new(true);
        ctx.interactivity = Interactivity::NonInteractive;
        let mut asker = Script {
            yes: true,
            ..Default::default()
        };
        assert!(
            rm_with(
                &ctx,
                store.clone(),
                "prod",
                Confirm { yes: false },
                &mut asker
            )
            .await
            .is_err()
        );
        assert!(sigue(&store, &id));
        let _ = std::fs::remove_dir_all(dir);
    }
}
