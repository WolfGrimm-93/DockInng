//! Tests de los comandos de persistencia, registros y conexiones bajo la ACL real de Tauri
//! (manifest de permisos + capability + serialización), con un almacén temporal y el
//! llavero en memoria: nunca se toca el llavero ni los datos reales del usuario.

use std::path::PathBuf;
use std::sync::Arc;

use engine_docker::DockerEngine;
use serde_json::{Value, json};
use store::{MemorySecrets, Store};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

use crate::state::AppState;

fn request(cmd: &str, body: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("url"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn tempdir(tag: &str) -> PathBuf {
    let d = PathBuf::from("/tmp").join(format!(
        "dktest-app-{tag}-{}",
        &uuid::Uuid::now_v7().simple().to_string()[20..]
    ));
    std::fs::create_dir_all(&d).expect("tempdir");
    d
}

/// Aplicación de prueba con almacén temporal, llavero en memoria y motor sin socket.
struct Harness {
    webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    dir: PathBuf,
    _app: tauri::App<tauri::test::MockRuntime>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn harness(tag: &str) -> Harness {
    let dir = tempdir(tag);
    let mut state = AppState::new(Arc::new(DockerEngine::with_socket(
        "/nonexistent/docker.sock",
    )));
    state.store = Some(Arc::new(Store::open(&dir.join("data")).expect("store")));
    state.secrets = Arc::new(MemorySecrets::default());
    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            crate::commands::start_container,
            crate::commands::stop_container,
            crate::commands::restart_container,
            crate::commands::execute_action,
            crate::commands_store::groups_load,
            crate::commands_store::groups_mutate,
            crate::commands_store::groups_import_legacy,
            crate::commands_store::prefs_get,
            crate::commands_store::prefs_set,
            crate::commands_store::registry_list,
            crate::commands_store::registry_save,
            crate::commands_store::registry_delete,
            crate::commands_store::registry_test,
            crate::commands_remote::connection_list,
            crate::commands_remote::connection_probe_host_key,
            crate::commands_remote::connection_trust_host_key,
            crate::commands_remote::connection_test,
            crate::commands_remote::connection_save,
            crate::commands_remote::connection_delete,
            crate::commands_remote::connection_select,
        ])
        .build(tauri::generate_context!())
        .expect("app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("ventana");
    Harness {
        webview,
        dir,
        _app: app,
    }
}

impl Harness {
    fn call(&self, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(&self.webview, request(cmd, body)).map(|r| match r {
            InvokeResponseBody::Json(s) => serde_json::from_str(&s).expect("json"),
            InvokeResponseBody::Raw(_) => panic!("respuesta binaria inesperada"),
        })
    }

    fn ok(&self, cmd: &str, body: Value) -> Value {
        self.call(cmd, body)
            .unwrap_or_else(|e| panic!("{cmd} falló: {e}"))
    }
}

#[test]
fn grupos_por_ipc_con_acl_real() {
    let h = harness("groups");
    let snap = h.ok("groups_load", json!({}));
    assert_eq!(snap["legacy_imported"], false);
    assert_eq!(snap["groups"], json!([]));
    let snap = h.ok(
        "groups_mutate",
        json!({"op": {"type": "create_group", "name": "Web", "hue": 210}}),
    );
    let gid = snap["groups"][0]["id"].as_str().expect("id").to_string();
    assert_eq!(gid.len(), 36);
    let snap = h.ok(
        "groups_mutate",
        json!({"op": {"type": "assign", "connection_id": "local", "names": ["nginx"], "group_id": gid}}),
    );
    assert_eq!(snap["assignments"][0]["container_name"], "nginx");
    // Entradas inválidas -> invalid_input; nombre duplicado -> conflict.
    let e = h
        .call(
            "groups_mutate",
            json!({"op": {"type": "create_group", "name": ""}}),
        )
        .expect_err("nombre vacío");
    assert_eq!(e["code"], "invalid_input");
    let e = h
        .call(
            "groups_mutate",
            json!({"op": {"type": "create_group", "name": "web"}}),
        )
        .expect_err("duplicado");
    assert_eq!(e["code"], "conflict");
    let e = h
        .call("groups_mutate", json!({"op": {"type": "explota"}}))
        .expect_err("op desconocida");
    assert!(e.is_string() || e.get("code").is_some());
}

#[test]
fn migracion_de_grupos_es_idempotente_por_ipc() {
    let h = harness("legacy");
    let id = uuid::Uuid::now_v7().to_string();
    let payload = json!({
        "v": 1,
        "groups": [{"id": id, "name": "Uno", "hue": 30}],
        "assign": {"local\u{0}web": id, "otra\u{0}x": id},
        "stackHue": {"proj": 120}
    });
    let r = h.ok("groups_import_legacy", json!({"payload": payload}));
    assert_eq!(r["already_imported"], false);
    assert_eq!(r["imported_groups"], 1);
    assert_eq!(r["imported_assignments"], 1);
    assert_eq!(r["dropped_assignments"], 1);
    assert_eq!(r["snapshot"]["stack_hues"]["proj"], 120);
    let r2 = h.ok("groups_import_legacy", json!({"payload": payload}));
    assert_eq!(r2["already_imported"], true);
    assert_eq!(
        r2["snapshot"]["groups"].as_array().expect("groups").len(),
        1
    );
    assert_eq!(h.ok("groups_load", json!({}))["legacy_imported"], true);
}

#[test]
fn preferencias_con_lista_blanca() {
    let h = harness("prefs");
    assert_eq!(h.ok("prefs_get", json!({"key": "polling"})), Value::Null);
    h.ok(
        "prefs_set",
        json!({"key": "polling", "value": {"ms": 5000}}),
    );
    assert_eq!(
        h.ok("prefs_get", json!({"key": "polling"})),
        json!({"ms": 5000})
    );
    let e = h
        .call("prefs_set", json!({"key": "cualquiera", "value": 1}))
        .expect_err("clave fuera de la lista");
    assert_eq!(e["code"], "invalid_input");
    // La clave interna de migración no es accesible desde la UI.
    assert!(
        h.call("prefs_get", json!({"key": "legacy_groups_imported"}))
            .is_err()
    );
}

#[test]
fn registros_el_secreto_no_sale_y_borrar_exige_confirmacion() {
    let h = harness("registry");
    let saved = h.ok(
        "registry_save",
        json!({"server": "GHCR.io", "username": "bob", "secret": "s3cr3t-ultra"}),
    );
    assert_eq!(saved["server"], "ghcr.io");
    assert!(!saved.to_string().contains("s3cr3t-ultra"));
    let list = h.ok("registry_list", json!({}));
    assert_eq!(list.as_array().expect("lista").len(), 1);
    assert!(!list.to_string().contains("s3cr3t-ultra"));
    // Secreto inválido: error sin eco del valor.
    let e = h
        .call(
            "registry_save",
            json!({"server": "x.io", "username": "u", "secret": "mal\nsecreto"}),
        )
        .expect_err("secreto con salto de línea");
    assert_eq!(e["code"], "invalid_input");
    assert!(!e.to_string().contains("mal"));
    // Probar sin daemon: error de conexión, nunca un pánico ni el secreto.
    let id = saved["id"].as_str().expect("id").to_string();
    let e = h
        .call("registry_test", json!({"id": id}))
        .expect_err("sin daemon");
    assert!(!e.to_string().contains("s3cr3t-ultra"));
    // Borrar sin confirmar: denegado; confirmado: ok.
    let e = h
        .call("registry_delete", json!({"id": id, "confirmed": false}))
        .expect_err("sin confirmación");
    assert_eq!(e["code"], "policy_denied");
    h.ok("registry_delete", json!({"id": id, "confirmed": true}));
    assert_eq!(h.ok("registry_list", json!({})), json!([]));
}

#[test]
fn conexiones_guardar_listar_seleccionar_y_borrar() {
    let h = harness("conn");
    let key = h.dir.join("id_test");
    std::fs::write(&key, "no es una llave real").expect("archivo");
    let spec = json!({
        "kind": "ssh", "name": "prod", "host": "example.invalid", "port": 22, "user": "deploy",
        "mode": "explicit", "identity": {"type": "file", "path": key.to_string_lossy()}
    });
    let profile = h.ok("connection_save", json!({"spec": spec}));
    assert_eq!(profile["remote"], true);
    assert_eq!(profile["simulated"], false);
    let id = profile["id"].as_str().expect("id").to_string();
    assert_eq!(
        h.ok("connection_list", json!({}))
            .as_array()
            .expect("lista")
            .len(),
        1
    );

    // Validación en el borde: host con opción de ssh, usuario inválido, llave inexistente.
    for (field, value) in [
        ("host", json!("-oProxyCommand=x")),
        ("user", json!("Bad User")),
    ] {
        let mut bad = spec.clone();
        bad[field] = value;
        bad["name"] = json!("otra");
        let e = h
            .call("connection_save", json!({"spec": bad}))
            .expect_err("inválido");
        assert_eq!(e["code"], "invalid_input", "{field}");
    }
    let mut missing = spec.clone();
    missing["name"] = json!("sinllave");
    missing["identity"] = json!({"type": "file", "path": "/nonexistent/id"});
    let e = h
        .call("connection_save", json!({"spec": missing}))
        .expect_err("llave inexistente");
    assert_eq!(e["code"], "invalid_input");

    // Seleccionar un id inexistente; `local` responde con el estado (sin socket = failed).
    let e = h
        .call(
            "connection_select",
            json!({"id": uuid::Uuid::now_v7().to_string()}),
        )
        .expect_err("no existe");
    assert_eq!(e["code"], "not_found");
    let status = h.ok("connection_select", json!({"id": "local"}));
    assert_eq!(status["state"], "failed");

    // Sondear/confiar exigen SSH; TLS se rechaza.
    let tls = json!({"kind": "tls", "name": "t", "host": "h.invalid", "port": 2376,
        "ca_path": "/nonexistent/ca.pem", "cert_path": "/nonexistent/c.pem", "key_path": "/nonexistent/k.pem"});
    let e = h
        .call("connection_probe_host_key", json!({"spec": tls}))
        .expect_err("no es ssh");
    assert_eq!(e["code"], "invalid_input");
    // `connection_test` de TLS con archivos inexistentes: resultado ok=false, sin pánico.
    let r = h.ok("connection_test", json!({"spec": tls}));
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"]["code"], "invalid_input");

    // Borrar exige confirmación.
    let e = h
        .call("connection_delete", json!({"id": id, "confirmed": false}))
        .expect_err("sin confirmación");
    assert_eq!(e["code"], "policy_denied");
    h.ok("connection_delete", json!({"id": id, "confirmed": true}));
    assert_eq!(h.ok("connection_list", json!({})), json!([]));
}

#[test]
fn ssh_a_host_inalcanzable_da_causa_clasificada_y_no_activa_nada() {
    let h = harness("unreach");
    let key = h.dir.join("id_test");
    std::fs::write(&key, "x").expect("archivo");
    // Puerto cerrado en loopback: el túnel se levanta pero ssh no conecta.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        l.local_addr().expect("addr").port()
    };
    let spec = json!({
        "kind": "ssh", "name": "cerrado", "host": "127.0.0.1", "port": closed, "user": "nobody",
        "mode": "explicit", "identity": {"type": "file", "path": key.to_string_lossy()}
    });
    let r = h.ok("connection_test", json!({"spec": spec}));
    assert_eq!(r["ok"], false);
    assert_eq!(r["cause"], "unreachable");
    let profile = h.ok("connection_save", json!({"spec": spec}));
    let e = h
        .call("connection_select", json!({"id": profile["id"]}))
        .expect_err("inalcanzable");
    assert_eq!(e["code"], "connection");
    assert_eq!(e["cause"], "unreachable");
    // El motor sigue en el destino anterior (local): el estado sigue siendo del socket local.
    let status = h.ok("connection_select", json!({"id": "local"}));
    assert_eq!(status["cause"], "socket_missing");
}

/// Referencia y credenciales (servidor, usuario, secreto) con que se lanzó una descarga.
type SeenPull = (String, Option<(String, String, String)>);

/// Motor de pull de mentira que registra qué credenciales recibió cada descarga.
#[derive(Default)]
struct RecordingPull {
    seen: std::sync::Mutex<Vec<SeenPull>>,
}

impl engine_core::PullEngine for RecordingPull {
    fn pull_image(&self, reference: &str) -> engine_core::EngineStream<engine_core::PullEvent> {
        self.pull_image_with_auth(reference, None)
    }

    fn pull_image_with_auth(
        &self,
        reference: &str,
        auth: Option<engine_core::RegistryAuth>,
    ) -> engine_core::EngineStream<engine_core::PullEvent> {
        self.seen.lock().expect("lock").push((
            reference.to_string(),
            auth.map(|a| (a.server, a.username, a.secret.expose().to_string())),
        ));
        Box::pin(futures_util::stream::empty())
    }
}

/// La descarga usa el registro guardado del servidor de la referencia (Docker Hub y hosts
/// propios) y ninguna credencial para el resto; sin almacén sigue funcionando sin ellas.
#[tokio::test]
async fn pull_usa_las_credenciales_guardadas_del_servidor_correcto() {
    use futures_util::StreamExt;
    let dir = tempdir("pullauth");
    let store = Arc::new(Store::open(&dir.join("d")).expect("store"));
    let secrets: Arc<dyn store::SecretStore> = Arc::new(MemorySecrets::default());
    store
        .registry_save(
            secrets.as_ref(),
            "ghcr.io",
            "bob",
            &engine_core::Secret::new("tok-ghcr"),
        )
        .expect("guardar");
    store
        .registry_save(
            secrets.as_ref(),
            "docker.io",
            "hubuser",
            &engine_core::Secret::new("tok-hub"),
        )
        .expect("guardar");
    let pull = Arc::new(RecordingPull::default());
    for reference in ["ghcr.io/acme/app:1", "nginx:latest", "otro.io/x:1"] {
        let mut s = crate::commands_engine::pull_with_saved_auth(
            pull.clone(),
            Some(store.clone()),
            secrets.clone(),
            reference.to_string(),
        );
        while s.next().await.is_some() {}
    }
    // Sin almacén: sin credenciales y sin error.
    let mut s = crate::commands_engine::pull_with_saved_auth(
        pull.clone(),
        None,
        secrets,
        "ghcr.io/acme/app:2".to_string(),
    );
    while s.next().await.is_some() {}
    let seen = pull.seen.lock().expect("lock").clone();
    assert_eq!(
        seen[0].1,
        Some(("ghcr.io".into(), "bob".into(), "tok-ghcr".into()))
    );
    assert_eq!(
        seen[1].1,
        Some((
            engine_core::DOCKER_HUB_SERVER.into(),
            "hubuser".into(),
            "tok-hub".into()
        ))
    );
    assert_eq!(seen[2].1, None);
    assert_eq!(seen[3].1, None);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Prueba VIVA del selector de contexto contra un `sshd` local desechable en 127.0.0.1:54110.
/// `DOCKINNG_LIVE_TESTS=1 DOCKINNG_LIVE_SSH=1 cargo test -p dockinng-app --lib live_ -- --ignored`
/// (la fixture solo usa llaves y host key desechables en /tmp; nunca `~/.ssh`).
mod live {
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;
    use engine_core::{ConnSpec, ConnectionStatus, HostKeyState, SshIdentity, SshMode};
    use transport::keyscan;
    use transport::ssh_args::SshTarget;

    const PORT: u16 = 54110;

    struct Sshd {
        dir: PathBuf,
        child: Child,
        user: String,
    }

    impl Drop for Sshd {
        fn drop(&mut self) {
            // Solo el PID propio.
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn keygen(path: &std::path::Path) {
        let st = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(path)
            .status()
            .expect("ssh-keygen");
        assert!(st.success());
    }

    fn start_sshd(tag: &str) -> Sshd {
        let dir = tempdir(tag);
        keygen(&dir.join("hostkey"));
        keygen(&dir.join("id"));
        std::fs::copy(dir.join("id.pub"), dir.join("authorized_keys")).expect("authorized_keys");
        let user =
            String::from_utf8_lossy(&Command::new("id").arg("-un").output().expect("id").stdout)
                .trim()
                .to_string();
        let d = dir.display();
        std::fs::write(
            dir.join("sshd_config"),
            format!(
                "Port {PORT}\nListenAddress 127.0.0.1\nHostKey {d}/hostkey\nAuthorizedKeysFile {d}/authorized_keys\n\
                 PidFile {d}/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n\
                 PubkeyAuthentication yes\nStrictModes no\nAllowUsers {user}\nLogLevel ERROR\nPerSourcePenalties no\n"
            ),
        )
        .expect("config");
        let child = Command::new("/usr/bin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(dir.join("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sshd");
        let start = Instant::now();
        while std::net::TcpStream::connect(("127.0.0.1", PORT)).is_err() {
            assert!(start.elapsed() < Duration::from_secs(5), "sshd no arrancó");
            std::thread::sleep(Duration::from_millis(50));
        }
        Sshd { dir, child, user }
    }

    fn spec(s: &Sshd, key: &std::path::Path, name: &str) -> ConnSpec {
        ConnSpec::Ssh {
            name: name.into(),
            host: "127.0.0.1".into(),
            port: u32::from(PORT),
            user: s.user.clone(),
            mode: SshMode::Explicit,
            identity: SshIdentity::File {
                path: key.to_string_lossy().into_owned(),
            },
        }
    }

    #[tokio::test]
    #[ignore = "requiere DOCKINNG_LIVE_TESTS=1 y DOCKINNG_LIVE_SSH=1"]
    async fn live_selector_de_contexto_por_ssh() {
        let on = |k: &str| std::env::var(k).as_deref() == Ok("1");
        if !(on("DOCKINNG_LIVE_TESTS") && on("DOCKINNG_LIVE_SSH"))
            || !std::path::Path::new("/usr/bin/sshd").exists()
        {
            eprintln!("saltado: exige DOCKINNG_LIVE_TESTS=1, DOCKINNG_LIVE_SSH=1 y sshd");
            return;
        }
        let s = start_sshd("sw");
        let mut state = AppState::new(Arc::new(DockerEngine::with_socket("/var/run/docker.sock")));
        state.store = Some(Arc::new(Store::open(&s.dir.join("data")).expect("store")));
        let store = state.store.clone().expect("store");
        let good = store
            .connection_save(&spec(&s, &s.dir.join("id"), "ok"), None)
            .expect("guardar");
        let bad_key = s.dir.join("noautorizada");
        keygen(&bad_key);
        let bad = store
            .connection_save(&spec(&s, &bad_key, "mala"), None)
            .expect("guardar");

        // Sin confiar en la clave del servidor: no se conecta y el motor sigue local.
        let e = crate::switch::select_connection(&state, &good.id)
            .await
            .expect_err("sin TOFU");
        assert_eq!(e.cause, Some(engine_core::ConnectionCause::HostKeyUnknown));
        assert!(!state.engine.is_remote());

        // Confianza explícita con la huella vista.
        let target = SshTarget::from_spec(&good.spec).expect("target");
        let probe = keyscan::probe(&target, &store.known_hosts_path())
            .await
            .expect("probe");
        assert_eq!(probe.state, HostKeyState::Unknown);
        keyscan::trust(
            &target,
            &store.known_hosts_path(),
            &probe.fingerprint_sha256,
        )
        .await
        .expect("trust");

        // Llave equivocada: auth_failed y el motor sigue local.
        let e = crate::switch::select_connection(&state, &bad.id)
            .await
            .expect_err("auth");
        assert_eq!(e.cause, Some(engine_core::ConnectionCause::AuthFailed));
        assert!(!state.engine.is_remote());
        assert!(state.remote.active_id().await.is_none());

        // Conexión buena: el motor compartido pasa a remoto y responde por el túnel.
        let status = crate::switch::select_connection(&state, &good.id)
            .await
            .expect("select");
        match status {
            ConnectionStatus::Connected { endpoint, .. } => assert!(endpoint.starts_with("ssh://")),
            other => panic!("{other:?}"),
        }
        assert!(state.engine.is_remote());
        assert_eq!(
            state.remote.active_id().await.as_deref(),
            Some(good.id.as_str())
        );
        state
            .engine
            .list_containers(true)
            .await
            .expect("listar por el túnel");
        // GPU local no aplica en remoto.
        assert!(state.engine.is_remote());

        // De vuelta a local: sin remoto activo y el túnel cerrado.
        let status = crate::switch::select_connection(&state, "local")
            .await
            .expect("local");
        assert!(matches!(status, ConnectionStatus::Connected { .. }));
        assert!(!state.engine.is_remote());
        assert!(state.remote.active_id().await.is_none());
    }
}

/// Mientras dura un cambio de conexión no se admiten streams nuevos ni acciones: nada puede
/// atarse al motor viejo entre `quiesce` y `set_target`; al terminar se reanuda.
#[tokio::test]
async fn cambio_en_curso_rechaza_suscripciones_y_acciones() {
    let state = AppState::new(Arc::new(DockerEngine::with_socket(
        "/nonexistent/docker.sock",
    )));
    assert!(state.ensure_not_switching().is_ok());
    state.streams.set_paused(true);
    let e = state.ensure_not_switching().expect_err("en curso");
    assert_eq!(e.code, engine_core::ApiErrorCode::Conflict);
    let r = state
        .streams
        .spawn("main", crate::streams::StreamKind::Logs, async {}, || {});
    assert_eq!(
        r.expect_err("pausado").code,
        engine_core::ApiErrorCode::Conflict
    );
    assert_eq!(state.streams.total(), 0);
    state.streams.set_paused(false);
    assert!(state.ensure_not_switching().is_ok());
    assert!(
        state
            .streams
            .spawn("main", crate::streams::StreamKind::Logs, async {}, || {})
            .is_ok()
    );
}

/// `quiesced` solo se serializa cuando es `true` (el contrato previo no cambia).
#[test]
fn quiesced_solo_aparece_cuando_es_true() {
    let mut e = engine_core::ApiError::new(engine_core::ApiErrorCode::Connection, "x");
    assert!(
        serde_json::to_value(&e)
            .expect("json")
            .get("quiesced")
            .is_none()
    );
    e.quiesced = true;
    assert_eq!(serde_json::to_value(&e).expect("json")["quiesced"], true);
}

/// El motivo real por el que no abrió el almacén llega al usuario.
#[test]
fn error_del_almacen_conserva_la_causa() {
    let mut state = AppState::new(Arc::new(DockerEngine::with_socket(
        "/nonexistent/docker.sock",
    )));
    state.store_error = Some("la base de datos es de una versión más nueva".into());
    let e = crate::commands_store::store_of(&state)
        .err()
        .expect("sin almacén");
    assert!(e.message.contains("versión más nueva"), "{}", e.message);
}

/// Un nombre repetido no pisa en silencio; se edita con el id explícito.
#[test]
fn guardar_con_nombre_repetido_es_conflicto_y_editar_usa_id() {
    let h = harness("dup");
    let key = h.dir.join("id_test");
    std::fs::write(&key, "x").expect("archivo");
    let spec = |host: &str| {
        json!({
            "kind": "ssh", "name": "prod", "host": host, "port": 22, "user": "Deploy",
            "mode": "explicit", "identity": {"type": "file", "path": key.to_string_lossy()}
        })
    };
    let first = h.ok("connection_save", json!({"spec": spec("a.example")}));
    let e = h
        .call("connection_save", json!({"spec": spec("b.example")}))
        .expect_err("nombre repetido");
    assert_eq!(e["code"], "conflict");
    // La original sigue intacta.
    assert_eq!(h.ok("connection_list", json!({}))[0]["host"], "a.example");
    let edited = h.ok(
        "connection_save",
        json!({"spec": spec("b.example"), "id": first["id"]}),
    );
    assert_eq!(edited["id"], first["id"]);
    assert_eq!(edited["host"], "b.example");
    assert_eq!(edited["user"], "Deploy");
    let e = h
        .call(
            "connection_save",
            json!({"spec": spec("c.example"), "id": "no-existe"}),
        )
        .expect_err("id inexistente");
    assert_eq!(e["code"], "not_found");
}

/// N2: iniciar/detener/reiniciar y ejecutar acciones se rechazan durante un cambio de conexión.
#[test]
fn acciones_de_contenedor_se_rechazan_durante_un_cambio() {
    use tauri::Manager;
    let h = harness("acciones");
    h.webview.state::<AppState>().streams.set_paused(true);
    for cmd in ["start_container", "stop_container", "restart_container"] {
        let e = h.call(cmd, json!({"id": "abc"})).expect_err(cmd);
        assert_eq!(e["code"], "conflict", "{cmd}");
    }
    let e = h
        .call("execute_action", json!({"ticket": "x", "typed": null}))
        .expect_err("execute");
    assert_eq!(e["code"], "conflict");
    h.webview.state::<AppState>().streams.set_paused(false);
    // Reanudado: ya no es `conflict` (falla por otro motivo: sin socket).
    let e = h
        .call("start_container", json!({"id": "abc"}))
        .expect_err("sin socket");
    assert_ne!(e["code"], "conflict");
}

/// N3: un cambio de conexión espera a que termine la acción en vuelo (lado de lectura de
/// `switch_lock`), y una acción nueva no arranca mientras el cambio tiene el lado de escritura.
#[tokio::test]
async fn el_cambio_de_conexion_espera_a_las_acciones_en_vuelo() {
    let state = Arc::new(AppState::new(Arc::new(DockerEngine::with_socket(
        "/nonexistent/docker.sock",
    ))));
    let action = state.action_guard().await.expect("guarda");
    let s2 = state.clone();
    let switcher = tokio::spawn(async move {
        let _w = s2.switch_lock.write().await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        !switcher.is_finished(),
        "el cambio debe esperar a la acción en vuelo"
    );
    drop(action);
    tokio::time::timeout(std::time::Duration::from_secs(2), switcher)
        .await
        .expect("el cambio procede al terminar la acción")
        .expect("tarea");
}
