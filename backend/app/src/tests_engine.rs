//! Tests de terminal (exec), descarga (pull) y creación con mocks, y de los comandos IPC
//! nuevos bajo la ACL real de Tauri.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use engine_core::testing::MockEngine;
use engine_core::testing_create::MockCreate;
use engine_core::testing_exec::MockExec;
use engine_core::testing_pull::MockPull;
use engine_core::testing_stacks::MockStacks;
use engine_core::{ApiErrorCode, ContainerState, EngineError, ExecRequest, PullEvent};
use tokio::sync::mpsc;

use crate::commands_engine::start_pull;
use crate::exec_sessions::{
    ExecCmd, ExecEndReason, ExecFeed, INPUT_QUEUE, close_session, resize_terminal, start_session,
    write_input,
};
use crate::pull_feed::{PullFeed, PullOutcome};
use crate::state::AppState;
use crate::streams::{MAX_EXEC_STREAMS, Sink};

struct ChanSink<T>(mpsc::UnboundedSender<T>);

impl<T: Send + 'static> Sink<T> for ChanSink<T> {
    fn send(&self, item: T) -> bool {
        self.0.send(item).is_ok()
    }
}

fn chan<T: Send + 'static>() -> (Arc<dyn Sink<T>>, mpsc::UnboundedReceiver<T>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(ChanSink(tx)), rx)
}

struct Rig {
    state: AppState,
    engine: Arc<MockEngine>,
    exec: Arc<MockExec>,
}

fn rig_with(exec: MockExec, pull: MockPull) -> Rig {
    let engine = Arc::new(MockEngine::new());
    engine.state().containers.push(MockEngine::container(
        "c1",
        "web",
        ContainerState::Running,
        "t0",
    ));
    let exec = Arc::new(exec);
    let stacks = Arc::new(MockStacks::default());
    let state = AppState::with_parts(
        engine.clone(),
        exec.clone(),
        Arc::new(pull),
        Arc::new(MockCreate::default()),
        stacks.clone(),
        stacks,
    );
    Rig {
        state,
        engine,
        exec,
    }
}

fn rig() -> Rig {
    rig_with(MockExec::default(), MockPull { events: vec![] })
}

fn open(r: &Rig, window: &str) -> (String, mpsc::UnboundedReceiver<ExecFeed>) {
    let (sink, rx) = chan::<ExecFeed>();
    let id = start_session(
        &r.state.streams,
        &r.state.exec_sessions,
        r.state.exec.clone(),
        r.state.engine.clone(),
        window,
        ExecRequest {
            container: "c1".into(),
            cols: 80,
            rows: 24,
        },
        sink,
    )
    .expect("sesión");
    (id, rx)
}

async fn next(rx: &mut mpsc::UnboundedReceiver<ExecFeed>) -> ExecFeed {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("a tiempo")
        .expect("feed")
}

/// Salida decodificada acumulada hasta `Ended`.
async fn collect(rx: &mut mpsc::UnboundedReceiver<ExecFeed>) -> (Vec<u8>, ExecFeed) {
    let mut out = Vec::new();
    loop {
        match next(rx).await {
            ExecFeed::Output { data } => out.extend(STANDARD.decode(data).expect("base64")),
            e @ ExecFeed::Ended { .. } => return (out, e),
            ExecFeed::Opened { .. } => {}
        }
    }
}

// ------------------------------------------------------------------------------ exec

#[tokio::test(start_paused = true)]
async fn exec_abre_y_envia_salida_en_base64_con_bytes_crudos() {
    let r = rig();
    let (_id, mut rx) = open(&r, "main");
    match next(&mut rx).await {
        ExecFeed::Opened { shell, risk } => {
            assert_eq!(shell, "/bin/sh");
            assert!(!risk.privileged);
        }
        other => panic!("se esperaba Opened: {other:?}"),
    }
    let tx = r.exec.output_sender().expect("emisor");
    // Secuencia UTF-8 partida entre fragmentos, byte de control 0x01 y 0x00 al inicio.
    tx.send(Ok(vec![0xC3])).expect("send");
    tx.send(Ok(vec![0xA9, 0x01, 0x00, b'x'])).expect("send");
    // Soltar los emisores termina el stream (EOF).
    r.exec.clear_sender();
    drop(tx);
    let (out, ended) = collect(&mut rx).await;
    // Los bytes llegan intactos aunque el UTF-8 esté partido entre fragmentos.
    assert_eq!(out, [0xC3, 0xA9, 0x01, 0x00, b'x']);
    assert!(matches!(
        ended,
        ExecFeed::Ended {
            reason: ExecEndReason::ProcessExited,
            ..
        }
    ));
}

#[tokio::test(start_paused = true)]
async fn exec_write_resize_y_close_llegan_al_control_y_mata_el_shell() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    write_input(&r.state.exec_sessions, &id, "main", "ls\n").expect("write");
    // 3 resizes seguidos: gana el último (máx. 10/s).
    for (c, rw) in [(100, 30), (110, 31), (120, 32)] {
        resize_terminal(&r.state.exec_sessions, &id, "main", c, rw).expect("resize");
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    {
        let log = r.exec.log.lock().expect("log");
        assert_eq!(log.writes, [b"ls\n".to_vec()]);
        assert_eq!(log.resizes.last(), Some(&(120, 32)));
        assert!(log.resizes.len() <= 2, "coalescido: {:?}", log.resizes);
        assert!(!log.closed);
    }
    close_session(&r.state.exec_sessions, &id, "main")
        .await
        .expect("close");
    let (_, ended) = collect(&mut rx).await;
    assert!(matches!(
        ended,
        ExecFeed::Ended {
            reason: ExecEndReason::Closed,
            ..
        }
    ));
    assert!(r.exec.log.lock().expect("log").closed);
    // Tras cerrar, la sesión ya no existe.
    assert_eq!(
        write_input(&r.state.exec_sessions, &id, "main", "x")
            .expect_err("cerrada")
            .code,
        ApiErrorCode::NotFound
    );
}

#[tokio::test(start_paused = true)]
async fn exec_una_ventana_no_puede_usar_sesiones_de_otra() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    for res in [
        write_input(&r.state.exec_sessions, &id, "otra", "x"),
        resize_terminal(&r.state.exec_sessions, &id, "otra", 80, 24),
        close_session(&r.state.exec_sessions, &id, "otra").await,
    ] {
        let e = res.expect_err("ajena");
        assert_eq!(e.code, ApiErrorCode::NotFound);
    }
    // La sesión ajena sigue viva para su dueña.
    write_input(&r.state.exec_sessions, &id, "main", "ok").expect("dueña");
    // Un id inexistente da la misma respuesta.
    assert_eq!(
        write_input(&r.state.exec_sessions, "no-existe", "main", "x")
            .expect_err("inexistente")
            .code,
        ApiErrorCode::NotFound
    );
}

#[tokio::test(start_paused = true)]
async fn exec_la_quinta_terminal_de_una_ventana_es_conflicto() {
    let r = rig();
    let mut keep = Vec::new();
    for _ in 0..MAX_EXEC_STREAMS {
        keep.push(open(&r, "main"));
    }
    let (sink, _rx) = chan::<ExecFeed>();
    let err = start_session(
        &r.state.streams,
        &r.state.exec_sessions,
        r.state.exec.clone(),
        r.state.engine.clone(),
        "main",
        ExecRequest {
            container: "c1".into(),
            cols: 80,
            rows: 24,
        },
        sink,
    )
    .expect_err("5ª");
    assert_eq!(err.code, ApiErrorCode::Conflict);
    assert!(err.message.contains("terminales"));
    // Otra ventana no se ve afectada.
    let _other = open(&r, "otra");
}

#[tokio::test(start_paused = true)]
async fn exec_limites_de_entrada_y_tamano() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    // > 16 KiB por llamada.
    let big = "a".repeat(16 * 1024 + 1);
    assert_eq!(
        write_input(&r.state.exec_sessions, &id, "main", &big)
            .expect_err("grande")
            .code,
        ApiErrorCode::InvalidInput
    );
    // Justo 16 KiB sí; una ráfaga que agota 1 MiB/s se rechaza como saturada.
    let ok = "a".repeat(16 * 1024);
    let mut saturada = false;
    for _ in 0..200 {
        match write_input(&r.state.exec_sessions, &id, "main", &ok) {
            Ok(()) => {}
            Err(e) => {
                assert_eq!(e.code, ApiErrorCode::Conflict);
                saturada = true;
                break;
            }
        }
        // Deja que el bucle vacíe la cola (el límite es de bytes/s, no de la cola).
        tokio::task::yield_now().await;
    }
    assert!(saturada, "el límite de 1 MiB/s debe activarse");
    // Vacío = no-op.
    write_input(&r.state.exec_sessions, &id, "main", "").expect("vacío");
    // Tamaños fuera de rango se ajustan (0 -> 1, 65535 -> 500).
    tokio::time::sleep(Duration::from_secs(1)).await;
    resize_terminal(&r.state.exec_sessions, &id, "main", 0, 65535).expect("resize");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        r.exec.log.lock().expect("log").resizes.last(),
        Some(&(1, 500))
    );
    assert_eq!(INPUT_QUEUE, 64);
}

#[tokio::test(start_paused = true)]
async fn exec_fin_del_shell_es_process_exited_con_codigo() {
    let r = rig_with(MockExec::with_exit(7), MockPull { events: vec![] });
    let (_id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    let tx = r.exec.output_sender().expect("emisor");
    tx.send(Ok(b"bye\r\n".to_vec())).expect("send");
    // Al soltar TODOS los emisores el stream termina.
    r.exec.clear_sender();
    drop(tx);
    let (out, ended) = collect(&mut rx).await;
    assert_eq!(out, b"bye\r\n");
    assert_eq!(
        ended,
        ExecFeed::Ended {
            reason: ExecEndReason::ProcessExited,
            exit_code: Some(7),
            error: None
        }
    );
}

#[tokio::test(start_paused = true)]
async fn exec_si_el_contenedor_paro_el_motivo_es_container_stopped() {
    let r = rig_with(MockExec::with_exit(137), MockPull { events: vec![] });
    r.engine.state().containers[0].summary.state = ContainerState::Exited;
    let (_id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    r.exec.clear_sender();
    let (_, ended) = collect(&mut rx).await;
    assert!(matches!(
        ended,
        ExecFeed::Ended {
            reason: ExecEndReason::ContainerStopped,
            exit_code: Some(137),
            ..
        }
    ));
}

#[tokio::test(start_paused = true)]
async fn exec_error_al_abrir_se_reporta_en_el_feed() {
    for (err, reason, code) in [
        (
            EngineError::Conflict("el contenedor no está en ejecución".into()),
            ExecEndReason::Error,
            ApiErrorCode::Conflict,
        ),
        (
            EngineError::coded(ApiErrorCode::NoShell, "sin shell"),
            ExecEndReason::NoShell,
            ApiErrorCode::NoShell,
        ),
    ] {
        let r = rig_with(MockExec::failing(err), MockPull { events: vec![] });
        let (_id, mut rx) = open(&r, "main");
        match next(&mut rx).await {
            ExecFeed::Ended {
                reason: got,
                error: Some(e),
                ..
            } => {
                assert_eq!(got, reason);
                assert_eq!(e.code, code);
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test(start_paused = true)]
async fn exec_error_de_lectura_termina_con_error_y_mata_el_shell() {
    let r = rig();
    let (_id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    let tx = r.exec.output_sender().expect("emisor");
    tx.send(Err(EngineError::Timeout)).expect("send");
    let (_, ended) = collect(&mut rx).await;
    assert!(matches!(
        ended,
        ExecFeed::Ended {
            reason: ExecEndReason::Error,
            error: Some(_),
            ..
        }
    ));
    assert!(r.exec.log.lock().expect("log").closed);
}

#[tokio::test(start_paused = true)]
async fn exec_abortar_la_ventana_ejecuta_la_cascada_de_cierre() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    assert!(!r.exec.log.lock().expect("log").closed);
    // Cierre de ventana: se aborta la tarea; el guardia lanza `close()` desacoplado.
    assert_eq!(r.state.streams.abort_for_window("main"), 1);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        r.exec.log.lock().expect("log").closed,
        "el shell debe matarse aunque la ventana se cierre"
    );
    // Y la sesión deja de existir.
    assert!(write_input(&r.state.exec_sessions, &id, "main", "x").is_err());
}

#[tokio::test(start_paused = true)]
async fn exec_unsubscribe_aborta_y_mata_el_shell() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    assert!(r.state.streams.abort(&id));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(r.exec.log.lock().expect("log").closed);
}

#[tokio::test(start_paused = true)]
async fn exec_close_all_cierra_todas_las_sesiones() {
    let r = rig();
    let a = open(&r, "main");
    let b = open(&r, "otra");
    let (mut ra, mut rb) = (a.1, b.1);
    assert!(matches!(next(&mut ra).await, ExecFeed::Opened { .. }));
    assert!(matches!(next(&mut rb).await, ExecFeed::Opened { .. }));
    r.state
        .exec_sessions
        .close_all(Duration::from_secs(3))
        .await;
    for rx in [&mut ra, &mut rb] {
        let (_, e) = collect(rx).await;
        assert!(
            matches!(
                e,
                ExecFeed::Ended {
                    reason: ExecEndReason::Closed,
                    ..
                }
            ),
            "{e:?}"
        );
    }
    assert!(r.state.exec_sessions.is_empty());
}

/// Contrapresión: con salida ilimitada se deja de leer del stream al pasar de 8 MiB/s
/// (se cuenta lo que llega a la UI en 1 s de tiempo simulado) y NO se descarta nada.
#[tokio::test(start_paused = true)]
async fn exec_frena_la_lectura_por_encima_de_8_mib_por_segundo_sin_perder_bytes() {
    let r = rig();
    let (_id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    let tx = r.exec.output_sender().expect("emisor");
    // 200 MiB en trozos de 64 KiB, encolados de golpe.
    let chunk = vec![b'y'; 64 * 1024];
    let total_chunks = 3200usize;
    for _ in 0..total_chunks {
        tx.send(Ok(chunk.clone())).expect("send");
    }
    let mut got = 0usize;
    let start = tokio::time::Instant::now();
    // Durante 1 s simulado se mide lo que llega.
    while start.elapsed() < Duration::from_secs(1) {
        if let Ok(Some(ExecFeed::Output { data })) =
            tokio::time::timeout(Duration::from_millis(20), rx.recv()).await
        {
            got += STANDARD.decode(data).expect("b64").len();
        }
    }
    let limit = (super::exec_sessions::OUTPUT_BURST + super::exec_sessions::OUTPUT_RATE) as usize;
    assert!(got > 0, "algo debe llegar");
    // Ráfaga (2 MiB) + 1 s a 8 MiB/s (+ margen de un trozo por redondeo).
    assert!(
        got <= limit + 2 * 64 * 1024,
        "leyó {got} bytes en 1 s, límite {limit}"
    );
    // El resto NO se pierde: se sigue entregando después.
    let mut rest = 0usize;
    while got + rest < total_chunks * chunk.len() {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(ExecFeed::Output { data })) => {
                rest += STANDARD.decode(data).expect("b64").len();
            }
            other => panic!(
                "se perdió salida: {other:?} ({} de {})",
                got + rest,
                total_chunks * chunk.len()
            ),
        }
    }
    assert_eq!(got + rest, total_chunks * chunk.len());
}

/// Con la salida frenada, la entrada (Ctrl-C) se sigue atendiendo.
#[tokio::test(start_paused = true)]
async fn exec_la_entrada_se_atiende_aunque_la_salida_este_frenada() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    let tx = r.exec.output_sender().expect("emisor");
    let chunk = vec![b'y'; 64 * 1024];
    for _ in 0..1000 {
        tx.send(Ok(chunk.clone())).expect("send");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    write_input(&r.state.exec_sessions, &id, "main", "\x03").expect("ctrl-c");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        r.exec.log.lock().expect("log").writes.last(),
        Some(&vec![3u8])
    );
}

#[test]
fn feed_de_exec_serializa_como_espera_el_frontend() {
    let v = serde_json::to_value(ExecFeed::Ended {
        reason: ExecEndReason::ContainerStopped,
        exit_code: Some(1),
        error: None,
    })
    .expect("json");
    assert_eq!(
        v,
        serde_json::json!({"type": "ended", "reason": "container_stopped", "exit_code": 1, "error": null})
    );
    let v = serde_json::to_value(ExecFeed::Opened {
        shell: "/bin/sh".into(),
        risk: Default::default(),
    })
    .expect("json");
    assert_eq!(v["type"], "opened");
    assert_eq!(v["risk"]["docker_socket"], false);
    assert_eq!(
        serde_json::to_value(ExecFeed::Output {
            data: "AA==".into()
        })
        .expect("json"),
        serde_json::json!({"type": "output", "data": "AA=="})
    );
    let _ = ExecCmd::Resize(1, 1);
}

// ------------------------------------------------------------------------------ pull

fn ev(id: Option<&str>, status: &str, cur: Option<u64>, tot: Option<u64>) -> PullEvent {
    PullEvent {
        id: id.map(String::from),
        status: status.into(),
        current: cur,
        total: tot,
    }
}

async fn pull_until_ended(rx: &mut mpsc::UnboundedReceiver<PullFeed>) -> Vec<PullFeed> {
    let mut all = Vec::new();
    loop {
        let f = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a tiempo")
            .expect("feed");
        let end = matches!(f, PullFeed::Ended { .. });
        all.push(f);
        if end {
            return all;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn pull_reproduce_started_progreso_coalescido_y_ended_done() {
    let events = vec![
        Ok(ev(Some("1"), "Pulling from x/y", None, None)),
        Ok(ev(Some("aaa"), "Pulling fs layer", None, None)),
        Ok(ev(Some("aaa"), "Downloading", Some(10), Some(100))),
        Ok(ev(Some("aaa"), "Downloading", Some(50), Some(100))),
        Ok(ev(Some("aaa"), "Pull complete", None, None)),
        Ok(ev(None, "Digest: sha256:abcd", None, None)),
        Ok(ev(
            None,
            "Status: Downloaded newer image for x/y:1",
            None,
            None,
        )),
    ];
    let r = rig_with(MockExec::default(), MockPull { events });
    let (sink, mut rx) = chan::<PullFeed>();
    start_pull(&r.state, "main", "x/y:1".into(), sink).expect("pull");
    let feeds = pull_until_ended(&mut rx).await;
    assert_eq!(
        feeds[0],
        PullFeed::Started {
            reference: "x/y:1".into()
        }
    );
    // Todos los eventos llegaron de golpe: una sola instantánea antes del cierre.
    let progress: Vec<_> = feeds
        .iter()
        .filter(|f| matches!(f, PullFeed::Progress { .. }))
        .collect();
    assert_eq!(progress.len(), 1, "{feeds:?}");
    match feeds.last().expect("último") {
        PullFeed::Ended {
            outcome,
            up_to_date,
            digest,
            error,
        } => {
            assert_eq!(*outcome, PullOutcome::Done);
            assert!(!up_to_date);
            assert_eq!(digest.as_deref(), Some("sha256:abcd"));
            assert!(error.is_none());
        }
        other => panic!("{other:?}"),
    }
    let v = serde_json::to_value(&feeds[1]).expect("json");
    assert_eq!(v["type"], "progress");
    assert_eq!(v["layers"][0]["phase"], "complete");
}

#[tokio::test(start_paused = true)]
async fn pull_error_termina_con_ended_error_y_libera_la_referencia() {
    let events = vec![
        Ok(ev(Some("1"), "Pulling from x/y", None, None)),
        Err(EngineError::coded(
            ApiErrorCode::AuthRequired,
            "pull access denied",
        )),
    ];
    let r = rig_with(MockExec::default(), MockPull { events });
    let (sink, mut rx) = chan::<PullFeed>();
    start_pull(&r.state, "main", "x/y:1".into(), sink).expect("pull");
    let feeds = pull_until_ended(&mut rx).await;
    match feeds.last().expect("último") {
        PullFeed::Ended {
            outcome: PullOutcome::Error,
            error: Some(e),
            ..
        } => assert_eq!(e.code, ApiErrorCode::AuthRequired),
        other => panic!("{other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(10)).await;
    // La referencia quedó libre: se puede reintentar.
    let (sink, _rx2) = chan::<PullFeed>();
    start_pull(&r.state, "main", "x/y:1".into(), sink).expect("reintento");
}

/// Un pull que no termina (stream pendiente) para probar exclusión y límites.
struct PendingPull;

impl engine_core::PullEngine for PendingPull {
    fn pull_image(&self, _r: &str) -> engine_core::EngineStream<PullEvent> {
        Box::pin(futures_util::stream::pending())
    }
}

fn rig_pending_pull() -> Rig {
    let engine = Arc::new(MockEngine::new());
    let stacks = Arc::new(MockStacks::default());
    let exec = Arc::new(MockExec::default());
    Rig {
        state: AppState::with_parts(
            engine.clone(),
            exec.clone(),
            Arc::new(PendingPull),
            Arc::new(MockCreate::default()),
            stacks.clone(),
            stacks,
        ),
        engine,
        exec,
    }
}

#[tokio::test(start_paused = true)]
async fn pull_una_a_la_vez_por_referencia_y_maximo_dos_por_ventana() {
    let r = rig_pending_pull();
    let mk = |reference: &str, window: &str| {
        let (sink, rx) = chan::<PullFeed>();
        (start_pull(&r.state, window, reference.into(), sink), rx)
    };
    let (a, _ra) = mk("a/x:1", "main");
    let a = a.expect("1ª");
    // Misma referencia y ventana: conflicto.
    let (dup, _r) = mk("a/x:1", "main");
    assert_eq!(dup.expect_err("duplicada").code, ApiErrorCode::Conflict);
    let (_b, _rb) = mk("b/x:1", "main");
    // 3ª distinta: supera el tope de 2 por ventana.
    let (c, _rc) = mk("c/x:1", "main");
    assert_eq!(c.expect_err("3ª").code, ApiErrorCode::Conflict);
    // Otra ventana tiene su cupo, incluso con la misma referencia.
    let (o, _ro) = mk("a/x:1", "otra");
    o.expect("otra ventana");
    // Cancelar (unsubscribe) libera cupo y referencia.
    assert!(r.state.streams.abort(&a));
    tokio::time::sleep(Duration::from_millis(10)).await;
    let (again, _r2) = mk("a/x:1", "main");
    again.expect("tras cancelar");
}

#[tokio::test(start_paused = true)]
async fn pull_referencia_invalida_se_rechaza_sin_lanzar_tarea() {
    let r = rig_pending_pull();
    for bad in ["", "a b", "--x", "a/../b", &"a".repeat(300)] {
        let (sink, _rx) = chan::<PullFeed>();
        let e = start_pull(&r.state, "main", bad.into(), sink).expect_err("inválida");
        assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad:?}");
    }
    assert_eq!(r.state.streams.total(), 0);
}

#[tokio::test(start_paused = true)]
async fn pull_cancelar_suelta_el_stream() {
    // El stream se suelta al abortar: la descarga en el daemon se aborta.
    struct DropProbe(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    struct Probed(Arc<std::sync::atomic::AtomicBool>);
    impl engine_core::PullEngine for Probed {
        fn pull_image(&self, _r: &str) -> engine_core::EngineStream<PullEvent> {
            let probe = DropProbe(self.0.clone());
            Box::pin(futures_util::stream::poll_fn(move |_| {
                let _ = &probe;
                std::task::Poll::Pending
            }))
        }
    }
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let engine = Arc::new(MockEngine::new());
    let stacks = Arc::new(MockStacks::default());
    let state = AppState::with_parts(
        engine,
        Arc::new(MockExec::default()),
        Arc::new(Probed(dropped.clone())),
        Arc::new(MockCreate::default()),
        stacks.clone(),
        stacks,
    );
    let (sink, _rx) = chan::<PullFeed>();
    let id = start_pull(&state, "main", "a/x:1".into(), sink).expect("pull");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!dropped.load(std::sync::atomic::Ordering::SeqCst));
    assert!(state.streams.abort(&id));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
}

// ------------------------------------------------- aislamiento y épocas del registro

use crate::streams::{StreamKind, StreamRegistry};

/// `unsubscribe` solo aborta lo de la propia ventana; un id ajeno se comporta como inexistente.
#[tokio::test(start_paused = true)]
async fn unsubscribe_no_aborta_suscripciones_de_otra_ventana() {
    let r = rig();
    let (id, mut rx) = open(&r, "main");
    assert!(matches!(next(&mut rx).await, ExecFeed::Opened { .. }));
    // Otra ventana conoce el id: no puede abortarlo (misma respuesta que un id inexistente).
    assert!(!r.state.streams.abort_in("otra", &id));
    assert!(!r.state.streams.abort_in("otra", "no-existe"));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !r.exec.log.lock().expect("log").closed,
        "la terminal sigue viva"
    );
    write_input(&r.state.exec_sessions, &id, "main", "ok").expect("sigue viva");
    // La dueña sí puede.
    assert!(r.state.streams.abort_in("main", &id));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(r.exec.log.lock().expect("log").closed);
}

/// `reset_subscriptions` no puede abortar lo creado tras la carga de la página, aunque el
/// frontend no espere su respuesta (época por ventana).
#[tokio::test]
async fn reset_solo_aborta_lo_de_epocas_anteriores() {
    let reg = StreamRegistry::new();
    let pending = || std::future::pending::<()>();
    let old = reg
        .spawn("main", StreamKind::Logs, pending(), || {})
        .expect("old");
    let other = reg
        .spawn("otra", StreamKind::Logs, pending(), || {})
        .expect("otra");
    // Nueva página: lo anterior se aborta al empezar la carga.
    reg.begin_page("main");
    assert_eq!(reg.count("main", StreamKind::Logs), 0, "{old}");
    // La página nueva suscribe y luego llega el reset (carrera del frontend): no la toca.
    let fresh = reg
        .spawn("main", StreamKind::Logs, pending(), || {})
        .expect("fresh");
    assert_eq!(reg.reset_stale("main"), 0);
    assert_eq!(reg.count("main", StreamKind::Logs), 1);
    assert!(reg.abort_in("main", &fresh));
    // Otras ventanas no se ven afectadas por la página de `main`.
    assert_eq!(reg.count("otra", StreamKind::Logs), 1);
    assert!(reg.abort_in("otra", &other));
}

// ---------------------------------------------------------------------- IPC con ACL real

mod ipc {
    use engine_docker::DockerEngine;
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;

    use super::*;

    fn request(cmd: &str, body: serde_json::Value) -> InvokeRequest {
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

    fn ok(r: Result<InvokeResponseBody, serde_json::Value>) -> serde_json::Value {
        match r.expect("respuesta OK") {
            InvokeResponseBody::Json(s) => serde_json::from_str(&s).expect("json"),
            InvokeResponseBody::Raw(_) => panic!("binaria"),
        }
    }

    fn spec() -> serde_json::Value {
        serde_json::json!({
            "image": "alpine", "name": null, "ports": [], "volumes": [],
            "env": [], "network": null, "restart": "no", "restart_max_retries": null,
            "command": null, "labels": {}
        })
    }

    /// Los comandos nuevos de este bloque responden bajo la ACL real (manifest + capability)
    /// con un motor sin socket, sin pánico y con datos tipados.
    #[test]
    fn comandos_de_exec_pull_y_crear_bajo_acl_real() {
        let state = AppState::new(Arc::new(DockerEngine::with_socket(
            "/nonexistent/docker.sock",
        )));
        let app = mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                crate::commands_engine::subscribe_exec,
                crate::commands_engine::exec_write,
                crate::commands_engine::exec_resize,
                crate::commands_engine::exec_close,
                crate::commands_engine::subscribe_pull,
                crate::commands_engine::plan_create_container,
                crate::commands_engine::create_container,
                crate::commands_engine::create_volume,
                crate::commands_engine::create_network,
                crate::commands::unsubscribe,
            ])
            .build(tauri::generate_context!())
            .expect("app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("ventana");

        // Plan de una spec válida: ok, sin ticket, IP de loopback por defecto.
        let mut s = spec();
        s["ports"] = serde_json::json!([{"host_ip": null, "host_port": 54100, "container_port": 80, "protocol": "tcp"}]);
        let plan = ok(get_ipc_response(
            &webview,
            request("plan_create_container", serde_json::json!({"spec": s})),
        ));
        assert_eq!(plan["ok"], true);
        assert_eq!(plan["decision"]["type"], "allow");
        assert!(plan["ticket"].is_null());
        assert_eq!(plan["normalized"]["ports"][0]["host_ip"], "127.0.0.1");

        // Spec inválida: el plan lo dice con errores de campo (no es un fallo del comando).
        let mut bad = spec();
        bad["image"] = serde_json::json!("a b");
        let plan = ok(get_ipc_response(
            &webview,
            request("plan_create_container", serde_json::json!({"spec": bad})),
        ));
        assert_eq!(plan["ok"], false);
        assert_eq!(plan["field_errors"][0]["field"], "image");

        // Crear con spec inválida: invalid_input; con spec válida y sin socket: connection.
        let err = get_ipc_response(
            &webview,
            request(
                "create_container",
                serde_json::json!({"spec": bad, "start": false, "ticket": null}),
            ),
        )
        .expect_err("inválida");
        assert_eq!(err["code"], "invalid_input");
        let err = get_ipc_response(
            &webview,
            request(
                "create_container",
                serde_json::json!({"spec": spec(), "start": true, "ticket": null}),
            ),
        )
        .expect_err("sin socket");
        assert_eq!(err["code"], "connection");

        let err = get_ipc_response(
            &webview,
            request(
                "create_volume",
                serde_json::json!({"spec": {"name": "a b", "labels": {}}}),
            ),
        )
        .expect_err("nombre inválido");
        assert_eq!(err["code"], "invalid_input");
        let err = get_ipc_response(
            &webview,
            request(
                "create_network",
                serde_json::json!({"spec": {"name": "bridge", "internal": false, "subnet": null, "gateway": null, "labels": {}}}),
            ),
        )
        .expect_err("reservada");
        assert_eq!(err["code"], "invalid_input");

        // Sesión de terminal inexistente (o de otra ventana): not_found.
        for (cmd, body) in [
            (
                "exec_write",
                serde_json::json!({"subscriptionId": "x", "data": "ls"}),
            ),
            (
                "exec_resize",
                serde_json::json!({"subscriptionId": "x", "cols": 80, "rows": 24}),
            ),
            ("exec_close", serde_json::json!({"subscriptionId": "x"})),
        ] {
            let err = get_ipc_response(&webview, request(cmd, body)).expect_err(cmd);
            assert_eq!(err["code"], "not_found", "{cmd}");
        }

        // Suscripciones por Channel: devuelven un id (los errores viajan por el feed).
        let id = ok(get_ipc_response(
            &webview,
            request(
                "subscribe_exec",
                serde_json::json!({"id": "c1", "cols": 80, "rows": 24, "onEvent": "__CHANNEL__:1"}),
            ),
        ));
        assert_eq!(id.as_str().expect("id").len(), 36);
        let id2 = ok(get_ipc_response(
            &webview,
            request(
                "subscribe_pull",
                serde_json::json!({"reference": "alpine:latest", "onEvent": "__CHANNEL__:2"}),
            ),
        ));
        assert_eq!(id2.as_str().expect("id").len(), 36);
        // Referencia inválida: error inmediato.
        let err = get_ipc_response(
            &webview,
            request(
                "subscribe_pull",
                serde_json::json!({"reference": "a b", "onEvent": "__CHANNEL__:3"}),
            ),
        )
        .expect_err("inválida");
        assert_eq!(err["code"], "invalid_input");
        ok(get_ipc_response(
            &webview,
            request("unsubscribe", serde_json::json!({"subscriptionId": id})),
        ));
    }
}
