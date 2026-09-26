//! Pruebas de TLS mutuo con una CA desechable (rcgen) y un proxy TLS local (tokio-rustls)
//! que exige certificado de cliente y reenvía a `/var/run/docker.sock` (solo GET/lecturas).
//! `DOCKINNG_LIVE_TESTS=1 cargo test -p transport --test live_tls -- --ignored --test-threads=1`
//!
//! Escucha solo en 127.0.0.1 con puerto efímero. Nunca se toca el daemon con escrituras.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use engine_core::{ConnSpec, ConnectionCause, ConnectionStatus, EngineClient};
use engine_docker::{DockerEngine, Endpoint, Target};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use tokio::net::{TcpListener, UnixStream};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::RootCertStore;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::crypto::ring::default_provider;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use tokio_rustls::rustls::server::WebPkiClientVerifier;
use transport::{CertDir, TlsTarget};

const DOCKER_SOCK: &str = "/var/run/docker.sock";

fn gate() -> bool {
    if std::env::var("DOCKINNG_LIVE_TESTS").as_deref() != Ok("1") {
        eprintln!("saltado: exige DOCKINNG_LIVE_TESTS=1");
        return false;
    }
    Path::new(DOCKER_SOCK).exists()
}

struct Ca {
    cert_pem: String,
    issuer: Issuer<'static, KeyPair>,
}

fn new_ca(name: &str) -> Ca {
    let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
    p.distinguished_name.push(DnType::CommonName, name);
    p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let key = KeyPair::generate().unwrap();
    let cert = p.self_signed(&key).unwrap();
    Ca {
        cert_pem: cert.pem(),
        issuer: Issuer::new(p, key),
    }
}

/// Certificado hoja (servidor con SAN 127.0.0.1 o cliente) firmado por `ca`: (cert, llave) PEM.
fn leaf(ca: &Ca, server: bool) -> (String, String) {
    let mut p = CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
    p.distinguished_name
        .push(DnType::CommonName, if server { "srv" } else { "cli" });
    p.extended_key_usages = vec![if server {
        ExtendedKeyUsagePurpose::ServerAuth
    } else {
        ExtendedKeyUsagePurpose::ClientAuth
    }];
    let key = KeyPair::generate().unwrap();
    let cert = p.signed_by(&key, &ca.issuer).unwrap();
    (cert.pem(), key.serialize_pem())
}

/// Proxy TLS mutuo: acepta conexiones y reenvía a docker.sock. Devuelve el puerto.
async fn start_proxy(server_ca: &Ca, client_ca_pem: &str) -> (u16, tokio::task::JoinHandle<()>) {
    let (cert_pem, key_pem) = leaf(server_ca, true);
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .map(Result::unwrap)
        .collect();
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).unwrap();
    let mut roots = RootCertStore::empty();
    for c in CertificateDer::pem_slice_iter(client_ca_pem.as_bytes()) {
        roots.add(c.unwrap()).unwrap();
    }
    let provider = Arc::new(default_provider());
    let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .unwrap();
    let cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(cfg));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let Ok(mut sock) = UnixStream::connect(DOCKER_SOCK).await else {
                    return;
                };
                let _ = tokio::io::copy_bidirectional(&mut tls, &mut sock).await;
            });
        }
    });
    (port, task)
}

fn dir(tag: &str) -> PathBuf {
    let d = PathBuf::from("/tmp").join(format!(
        "dktest-tls-{tag}-{}",
        &uuid::Uuid::now_v7().simple().to_string()[20..]
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(d: &Path, name: &str, content: &str) -> String {
    let p = d.join(name);
    std::fs::write(&p, content).unwrap();
    p.to_string_lossy().into_owned()
}

fn spec(port: u16, ca: String, cert: String, key: String) -> ConnSpec {
    ConnSpec::Tls {
        name: "tls-fixture".into(),
        host: "127.0.0.1".into(),
        port: u32::from(port),
        ca_path: ca,
        cert_path: cert,
        key_path: key,
    }
}

fn engine_for(t: &TlsTarget, certs: &CertDir) -> Arc<DockerEngine> {
    let e = Arc::new(DockerEngine::new());
    e.set_target(Target::tls(Endpoint::Tls {
        addr: t.addr(),
        ca: t.ca.to_string_lossy().into_owned(),
        cert: t.cert.to_string_lossy().into_owned(),
        key: t.key.to_string_lossy().into_owned(),
        cert_dir: certs.path().to_string_lossy().into_owned(),
        label: t.label(),
    }));
    e
}

#[tokio::test]
#[ignore = "requiere DOCKINNG_LIVE_TESTS=1"]
async fn mtls_correcto_y_fallos_clasificados() {
    if !gate() {
        return;
    }
    // Instala el proveedor de rustls (el mismo `ring` que usa bollard).
    let _ = default_provider().install_default();
    let d = dir("ok");
    let ca = new_ca("ca-ok");
    let (cli_cert, cli_key) = leaf(&ca, false);
    let (port, proxy) = start_proxy(&ca, &ca.cert_pem).await;
    let (ca_p, cert_p, key_p) = (
        write(&d, "ca.pem", &ca.cert_pem),
        write(&d, "cert.pem", &cli_cert),
        write(&d, "key.pem", &cli_key),
    );

    // 1) mTLS correcto: el daemon responde a través del proxy.
    let t = TlsTarget::from_spec(&spec(port, ca_p.clone(), cert_p.clone(), key_p.clone())).unwrap();
    let certs = CertDir::create(&d.join("certs"), &t).unwrap();
    let engine = engine_for(&t, &certs);
    assert!(engine.is_remote());
    engine.ping().await.expect("ping por mTLS");
    assert!(matches!(
        engine.diagnose().await,
        ConnectionStatus::Connected { .. }
    ));
    // Los subprocesos heredan DOCKER_HOST y el directorio de certificados.
    let env = engine.endpoint().docker_env();
    assert!(
        env.iter()
            .any(|(k, v)| k == "DOCKER_CERT_PATH" && *v == certs.path().to_string_lossy())
    );

    // 2) CA equivocada en el cliente: el servidor no es de confianza -> tls_invalid.
    let other = new_ca("otra-ca");
    let bad_ca = write(&d, "otra-ca.pem", &other.cert_pem);
    let t = TlsTarget::from_spec(&spec(port, bad_ca, cert_p.clone(), key_p.clone())).unwrap();
    let engine = engine_for(&t, &certs);
    match engine.diagnose().await {
        ConnectionStatus::Failed { cause, message, .. } => {
            assert_eq!(cause, ConnectionCause::TlsInvalid, "mensaje: {message}")
        }
        other => panic!("se esperaba fallo, {other:?}"),
    }

    // 3) Certificado de cliente firmado por otra CA: el servidor lo rechaza en el handshake.
    let (rogue_cert, rogue_key) = leaf(&other, false);
    let (rc, rk) = (
        write(&d, "rogue.pem", &rogue_cert),
        write(&d, "rogue.key", &rogue_key),
    );
    let t = TlsTarget::from_spec(&spec(port, ca_p, rc, rk)).unwrap();
    let engine = engine_for(&t, &certs);
    match engine.diagnose().await {
        ConnectionStatus::Failed { cause, message, .. } => {
            assert_eq!(cause, ConnectionCause::TlsInvalid, "mensaje: {message}")
        }
        other => panic!("se esperaba fallo, {other:?}"),
    }
    proxy.abort();
    std::fs::remove_dir_all(&d).unwrap();
}
