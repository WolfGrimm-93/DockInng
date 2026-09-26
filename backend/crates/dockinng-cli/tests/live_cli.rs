//! Pruebas del binario `dockinng` contra el Docker real. Solo con `DOCKINNG_LIVE_TESTS=1`.
//!
//! Tocan únicamente recursos `dockinng-test-cli-<uuid>` con la etiqueta `dev.dockinng.test=1`,
//! sin descargar nada (`alpine:latest` ya debe estar en local). Nunca se ejecuta un prune ni
//! `cleanup apply --defaults`. Al final se comprueba que el resto de recursos no cambió.
//! Sin TTY (stdin nulo) la CLI está en modo no interactivo: lo que exige confirmación escrita
//! debe DENEGARSE, y eso también se comprueba.

use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_dockinng");

fn live() -> bool {
    if std::env::var("DOCKINNG_LIVE_TESTS").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("saltado: define DOCKINNG_LIVE_TESTS=1 para correr las pruebas live");
        false
    }
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn run(bin: &str, args: &[&str], xdg: Option<&str>) -> Out {
    let mut c = Command::new(bin);
    c.args(args).stdin(Stdio::null());
    if let Some(x) = xdg {
        c.env("XDG_DATA_HOME", x);
    }
    let o = c.output().expect("lanzar");
    Out {
        ok: o.status.success(),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    }
}

fn cli(args: &[&str]) -> Out {
    run(BIN, args, None)
}

fn docker(args: &[&str]) -> Out {
    run("docker", args, None)
}

fn lines(o: &Out) -> Vec<String> {
    let mut v: Vec<String> = o.stdout.lines().map(String::from).collect();
    v.sort();
    v
}

/// Ids de todo lo que hay en el daemon (para comprobar que no cambia nada ajeno).
fn snapshot() -> [Vec<String>; 4] {
    [
        lines(&docker(&["ps", "-aq"])),
        lines(&docker(&["volume", "ls", "-q"])),
        lines(&docker(&["images", "-q"])),
        lines(&docker(&["network", "ls", "-q"])),
    ]
}

#[test]
fn recursos_de_prueba_por_la_cli() {
    if !live() {
        return;
    }
    let before = snapshot();
    let id = uuid::Uuid::now_v7().simple().to_string()[26..].to_string();
    let vol = format!("dockinng-test-cli-{id}-vol");
    let net = format!("dockinng-test-cli-{id}-net");
    let ctr = format!("dockinng-test-cli-{id}-ctr");
    let tag = "dev.dockinng.test=1";

    // --- volúmenes: crear y listar; borrar exige escribir el nombre => sin TTY se deniega.
    let o = cli(&["volumes", "create", &vol, "--label", tag]);
    assert!(o.ok, "{}", o.stderr);
    let o = cli(&["volumes", "ls", "--json"]);
    assert!(o.ok && o.stdout.contains(&vol), "{}", o.stderr);
    let parsed: serde_json::Value = serde_json::from_str(&o.stdout).expect("json");
    assert!(parsed.is_array());
    let o = cli(&["volumes", "rm", &vol]);
    assert!(!o.ok, "sin TTY el borrado de un volumen debe denegarse");
    assert!(
        docker(&["volume", "inspect", &vol]).ok,
        "el volumen debe seguir existiendo"
    );
    // `--yes` tampoco lo salta: la CLI ni siquiera acepta el flag en `volumes rm`.
    assert!(!cli(&["volumes", "rm", &vol, "--yes"]).ok);
    // Y el borrado por limpieza con volumen también se deniega sin TTY.
    let o = cli(&["cleanup", "apply", "--volume", &vol, "--yes"]);
    assert!(!o.ok && o.stderr.contains("terminal"), "{}", o.stderr);
    assert!(docker(&["volume", "inspect", &vol]).ok);

    // --- redes: crear, listar, borrar con --yes (confirmación simple).
    let o = cli(&["networks", "create", &net, "--label", tag]);
    assert!(o.ok, "{}", o.stderr);
    let o = cli(&["networks", "ls"]);
    assert!(o.ok && o.stdout.contains(&net));
    // Sin --yes y sin TTY: denegado.
    let o = cli(&["networks", "rm", &net]);
    assert!(!o.ok && o.stderr.contains("--yes"), "{}", o.stderr);

    // --- imágenes (solo lectura)
    let o = cli(&["images", "ls", "--json"]);
    assert!(o.ok);
    assert!(
        serde_json::from_str::<serde_json::Value>(&o.stdout)
            .expect("json")
            .is_array()
    );

    // --- contenedor de prueba (alpine local, sin pull): logs y limpieza por selección.
    let o = docker(&[
        "run",
        "--name",
        &ctr,
        "--label",
        tag,
        "--pull",
        "never",
        "alpine:latest",
        "echo",
        "hola-dockinng",
    ]);
    assert!(o.ok, "{}", o.stderr);
    let o = cli(&["logs", &ctr]);
    assert!(
        o.ok && o.stdout.contains("hola-dockinng"),
        "{} {}",
        o.stdout,
        o.stderr
    );
    let o = cli(&["ps", "-a", "--json"]);
    assert!(o.ok && o.stdout.contains(&ctr));

    // El plan es de solo lectura y menciona nuestros recursos.
    let o = cli(&["cleanup", "plan", "--json"]);
    assert!(o.ok, "{}", o.stderr);
    let report: serde_json::Value = serde_json::from_str(&o.stdout).expect("json");
    let text = report.to_string();
    assert!(text.contains(&ctr) && text.contains(&net) && text.contains(&vol));
    // Los volúmenes nunca vienen marcados por defecto.
    for c in report["categories"].as_array().unwrap() {
        if c["id"] == "unused_volumes" {
            assert!(
                c["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|i| i["selected_by_default"] == false)
            );
        }
    }
    assert!(cli(&["cleanup", "plan"]).ok);

    // Ejecución por selección explícita SOLO de nuestros recursos.
    let ctr_id = docker(&["inspect", "--format", "{{.Id}}", &ctr])
        .stdout
        .trim()
        .to_string();
    assert_eq!(ctr_id.len(), 64);
    // Sin --yes ni TTY: denegado y no se borra nada.
    let o = cli(&[
        "cleanup",
        "apply",
        "--container",
        &ctr_id,
        "--network",
        &net,
    ]);
    assert!(!o.ok);
    assert!(docker(&["inspect", &ctr]).ok);
    // Nada seleccionado: error, no un prune.
    assert!(!cli(&["cleanup", "apply", "--yes"]).ok);
    let o = cli(&[
        "cleanup",
        "apply",
        "--container",
        &ctr_id,
        "--network",
        &net,
        "--yes",
    ]);
    assert!(o.ok, "{} {}", o.stdout, o.stderr);
    assert!(
        !docker(&["inspect", &ctr]).ok,
        "el contenedor de prueba debería haberse borrado"
    );
    assert!(
        !docker(&["network", "inspect", &net]).ok,
        "la red de prueba debería haberse borrado"
    );

    // Limpieza final del volumen (solo el nuestro).
    assert!(docker(&["volume", "rm", &vol]).ok);

    assert_eq!(before, snapshot(), "la CLI cambió recursos ajenos");
}

#[test]
fn stacks_por_la_cli() {
    if !live() {
        return;
    }
    if !docker(&["compose", "version"]).ok {
        eprintln!("saltado: no hay docker compose");
        return;
    }
    let before = snapshot();
    let name = format!(
        "dockinng-test-cli-{}",
        &uuid::Uuid::now_v7().simple().to_string()[20..]
    );
    let data = std::env::temp_dir().join(format!("dockinng-test-cli-data-{name}"));
    let store = compose::files::StackStore::new(data.join("dockinng").join("stacks"));
    let yaml = "services:\n  s:\n    image: alpine:latest\n    pull_policy: never\n    command: sleep 120\n    labels:\n      dev.dockinng.test: \"1\"\n";
    store
        .create(&name, yaml, "")
        .expect("crear stack de prueba");
    let xdg = data.display().to_string();

    let up = run(BIN, &["stacks", "up", &name], Some(&xdg));
    let ls = run(BIN, &["stacks", "ls", "--json"], Some(&xdg));
    // `down` exige escribir el nombre: sin TTY se deniega y el stack sigue arriba.
    let down = run(BIN, &["stacks", "down", &name], Some(&xdg));
    let still = docker(&[
        "ps",
        "-q",
        "--filter",
        &format!("label=com.docker.compose.project={name}"),
    ]);
    // Limpieza (solo lo que lleva nuestro nombre de proyecto), antes de afirmar nada.
    let ids: Vec<String> = docker(&[
        "ps",
        "-aq",
        "--filter",
        &format!("label=com.docker.compose.project={name}"),
    ])
    .stdout
    .lines()
    .map(String::from)
    .collect();
    for i in &ids {
        docker(&["rm", "-f", i]);
    }
    docker(&["network", "rm", &format!("{name}_default")]);
    let _ = std::fs::remove_dir_all(&data);

    assert!(up.ok, "{} {}", up.stdout, up.stderr);
    assert!(ls.ok && ls.stdout.contains(&name), "{}", ls.stdout);
    assert!(!down.ok, "sin TTY `stacks down` debe denegarse");
    assert!(
        !still.stdout.trim().is_empty(),
        "el stack debía seguir arriba tras el down denegado"
    );
    assert_eq!(before, snapshot(), "la CLI cambió recursos ajenos");
}
