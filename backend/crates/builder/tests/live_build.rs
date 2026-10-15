//! Pruebas contra el `docker` real. Solo con `DOCKINNG_LIVE_TESTS=1`.
//! Solo crean/borran la imagen `dockinng-test-build-<uuid>:1` (label `dev.dockinng.test=1`),
//! con `FROM scratch`: sin red y sin descargar nada.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use builder::{BuildService, BuildSink, BuildTarget};
use engine_core::{BuildFeed, BuildOutcome, BuildSpec, EngineClient};
use engine_docker::DockerEngine;

#[derive(Default)]
struct Collect(Mutex<Vec<BuildFeed>>);

impl BuildSink for Collect {
    fn send(&self, feed: BuildFeed) -> bool {
        self.0.lock().unwrap().push(feed);
        true
    }
}

fn live() -> bool {
    if std::env::var("DOCKINNG_LIVE_TESTS").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("saltado: define DOCKINNG_LIVE_TESTS=1 para correr las pruebas live");
        false
    }
}

fn context(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("dockinng-test-{tag}-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn spec(dir: &std::path::Path, tag: &str) -> BuildSpec {
    BuildSpec {
        context_dir: dir.display().to_string(),
        dockerfile: None,
        tag: Some(tag.into()),
        build_args: vec![],
        target: None,
        no_cache: true,
        pull: false,
    }
}

#[tokio::test]
async fn construye_una_imagen_scratch_y_la_borra() {
    if !live() {
        return;
    }
    let dir = context("build");
    std::fs::write(
        dir.join("Dockerfile"),
        "FROM scratch\nLABEL dev.dockinng.test=1\nCOPY hola.txt /hola.txt\n",
    )
    .unwrap();
    std::fs::write(dir.join("hola.txt"), "hola\n").unwrap();
    let tag = format!("dockinng-test-build-{}:1", uuid::Uuid::now_v7());
    let engine = DockerEngine::new();
    let svc = BuildService::new();
    let sink = Collect::default();
    let (host, env) = (
        Some(engine.endpoint().display()),
        engine.endpoint().docker_env(),
    );
    let target = BuildTarget {
        docker_host: host,
        env,
    };
    let r = svc
        .run(
            &spec(&dir, &tag),
            None,
            None,
            &target,
            &sink,
            std::future::pending(),
        )
        .await
        .expect("run");
    let feeds = sink.0.lock().unwrap().clone();
    let images = engine.list_images().await.expect("list_images");
    let found = images.iter().any(|i| i.reference == tag);
    // Limpieza SIEMPRE antes de afirmar: solo la imagen de prueba.
    if found {
        engine.remove_image(&tag).await.expect("remove_image");
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(r.outcome, BuildOutcome::Ok, "{r:?} {feeds:?}");
    assert!(found, "la imagen {tag} debería existir");
    assert!(
        r.image_id
            .as_deref()
            .is_some_and(|i| i.contains("sha256:") || i.len() >= 12)
    );
    assert!(matches!(
        feeds.last(),
        Some(BuildFeed::Ended {
            outcome: BuildOutcome::Ok,
            ..
        })
    ));
    assert!(feeds.iter().any(|f| matches!(f, BuildFeed::Lines { .. })));
    let images = engine.list_images().await.expect("list_images");
    assert!(
        !images.iter().any(|i| i.reference == tag),
        "imagen de prueba sin borrar"
    );
}

#[tokio::test]
async fn cancelar_a_mitad_termina_como_canceled() {
    if !live() {
        return;
    }
    let dir = context("cancel");
    std::fs::write(
        dir.join("Dockerfile"),
        "FROM scratch\nCOPY grande.bin /grande.bin\n",
    )
    .unwrap();
    // Archivo disperso de 256 MiB: el envío del contexto tarda lo bastante para cancelar.
    let f = std::fs::File::create(dir.join("grande.bin")).unwrap();
    f.set_len(256 * 1024 * 1024).unwrap();
    let tag = format!("dockinng-test-build-{}:cancel", uuid::Uuid::now_v7());
    let engine = DockerEngine::new();
    let svc = BuildService::new();
    let sink = Collect::default();
    let (host, env) = (
        Some(engine.endpoint().display()),
        engine.endpoint().docker_env(),
    );
    let target = BuildTarget {
        docker_host: host,
        env,
    };
    let r = svc
        .run(
            &spec(&dir, &tag),
            None,
            None,
            &target,
            &sink,
            tokio::time::sleep(Duration::from_millis(150)),
        )
        .await
        .expect("run");
    // Si la máquina fuera tan rápida como para terminar antes, se borra la imagen igualmente.
    let images = engine.list_images().await.expect("list_images");
    if images.iter().any(|i| i.reference == tag) {
        engine.remove_image(&tag).await.expect("remove_image");
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(r.outcome, BuildOutcome::Canceled, "{r:?}");
    let feeds = sink.0.lock().unwrap().clone();
    assert!(matches!(
        feeds.last(),
        Some(BuildFeed::Ended {
            outcome: BuildOutcome::Canceled,
            ..
        })
    ));
}
