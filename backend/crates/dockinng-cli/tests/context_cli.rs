use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_dockinng");

fn run(data: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(BIN)
        .args(args)
        .env("XDG_DATA_HOME", data)
        .stdin(Stdio::null())
        .output()
        .expect("lanzar dockinng")
}

#[test]
fn context_add_use_ls_y_rm_no_exponen_secretos() {
    let data = std::env::temp_dir().join(format!("dockinng-cli-context-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&data).unwrap();

    let add = run(
        &data,
        &[
            "--json",
            "context",
            "add",
            "ssh",
            "prod",
            "example.com",
            "--user",
            "deploy",
            "--identity",
            "/home/deploy/.ssh/id_ed25519",
        ],
    );
    assert!(
        add.status.success(),
        "{}",
        String::from_utf8_lossy(&add.stderr)
    );
    let added = String::from_utf8_lossy(&add.stdout);
    assert!(added.contains("prod"));
    assert!(added.contains("/home/deploy/.ssh/id_ed25519"));
    assert!(!added.contains("PRIVATE KEY"));

    let alias = run(
        &data,
        &[
            "--json",
            "context",
            "add",
            "ssh",
            "alias-prod",
            "debian-dev",
            "--alias",
            "--agent",
        ],
    );
    assert!(
        alias.status.success(),
        "{}",
        String::from_utf8_lossy(&alias.stderr)
    );
    let alias_json = String::from_utf8_lossy(&alias.stdout);
    let alias_value: serde_json::Value = serde_json::from_str(&alias_json).unwrap();
    assert_eq!(alias_value["mode"], "alias");
    assert_eq!(alias_value["port"], 0);

    let tls = run(
        &data,
        &[
            "context",
            "add",
            "tls",
            "tls-prod",
            "docker.example.com",
            "--ca",
            "/etc/dockinng/ca.pem",
            "--cert",
            "/etc/dockinng/cert.pem",
            "--key",
            "/etc/dockinng/key.pem",
        ],
    );
    assert!(
        tls.status.success(),
        "{}",
        String::from_utf8_lossy(&tls.stderr)
    );

    let use_prod = run(&data, &["context", "use", "prod"]);
    assert!(
        use_prod.status.success(),
        "{}",
        String::from_utf8_lossy(&use_prod.stderr)
    );

    let list = run(&data, &["--json", "context", "ls"]);
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    let listed = String::from_utf8_lossy(&list.stdout);
    assert!(listed.contains("prod") && listed.contains("tls-prod"));
    assert!(!listed.contains("PRIVATE KEY"));

    // Sin TTY, el borrado confirmado exige --yes y no modifica el perfil.
    let denied = run(&data, &["context", "rm", "prod"]);
    assert!(!denied.status.success());
    let still = run(&data, &["context", "ls"]);
    assert!(String::from_utf8_lossy(&still.stdout).contains("prod"));

    let removed = run(&data, &["context", "rm", "prod", "--yes"]);
    assert!(
        removed.status.success(),
        "{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    let after = run(&data, &["context", "ls"]);
    assert!(
        String::from_utf8_lossy(&after.stdout)
            .lines()
            .all(|line| !line.split_whitespace().any(|word| word == "prod"))
    );

    let _ = std::fs::remove_dir_all(data);
}
