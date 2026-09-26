//! TLS mutuo hacia un daemon Docker (`tcp://host:2376`): solo RUTAS de certificados.
//! DockInng nunca copia ni guarda el contenido de la llave privada; la verificación del
//! servidor está SIEMPRE activa (no existe opción «inseguro»).

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use engine_core::{ConnSpec, ConnectionCause, EngineError};

use crate::classify::Failure;
use crate::fsutil::ensure_private_dir;

/// Destino TLS validado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsTarget {
    /// Host (con corchetes si es IPv6).
    pub host: String,
    pub port: u16,
    pub ca: PathBuf,
    pub cert: PathBuf,
    pub key: PathBuf,
}

fn check_file(path: &Path, what: &str) -> Result<(), EngineError> {
    let meta = fs::metadata(path).map_err(|e| {
        EngineError::InvalidInput(format!("{what}: no se puede leer {} ({e})", path.display()))
    })?;
    if !meta.is_file() {
        return Err(EngineError::InvalidInput(format!(
            "{what}: {} no es un archivo",
            path.display()
        )));
    }
    Ok(())
}

impl TlsTarget {
    /// Valida la especificación y comprueba que los tres archivos existen (no se leen aquí).
    pub fn from_spec(spec: &ConnSpec) -> Result<Self, EngineError> {
        engine_core::connections::validate_spec(spec)?;
        let ConnSpec::Tls {
            host,
            port,
            ca_path,
            cert_path,
            key_path,
            ..
        } = spec
        else {
            return Err(EngineError::InvalidInput(
                "la conexión no es de tipo TLS".into(),
            ));
        };
        let t = Self {
            host: host.clone(),
            port: engine_core::connections::validate_port(*port)?,
            ca: PathBuf::from(ca_path),
            cert: PathBuf::from(cert_path),
            key: PathBuf::from(key_path),
        };
        check_file(&t.ca, "CA")?;
        check_file(&t.cert, "certificado de cliente")?;
        check_file(&t.key, "llave de cliente")?;
        Ok(t)
    }

    /// Dirección para `DOCKER_HOST` y bollard.
    pub fn addr(&self) -> String {
        format!("tcp://{}:{}", self.host, self.port)
    }

    /// Etiqueta para la UI.
    pub fn label(&self) -> String {
        format!("tls://{}:{}", self.host, self.port)
    }
}

/// Directorio privado con enlaces `ca.pem`/`cert.pem`/`key.pem` hacia los archivos del
/// usuario (el formato que espera `DOCKER_CERT_PATH`). Son enlaces: no se copia la llave.
/// Se borra al soltarse.
#[derive(Debug)]
pub struct CertDir {
    path: PathBuf,
}

impl CertDir {
    /// Crea `<base>/<uuid v7>/` (0700) con los tres enlaces.
    pub fn create(base: &Path, target: &TlsTarget) -> Result<Self, EngineError> {
        ensure_private_dir(base)?;
        let path = base.join(uuid::Uuid::now_v7().to_string());
        ensure_private_dir(&path)?;
        let dir = Self { path };
        for (name, src) in [
            ("ca.pem", &target.ca),
            ("cert.pem", &target.cert),
            ("key.pem", &target.key),
        ] {
            symlink(src, dir.path.join(name))
                .map_err(|e| EngineError::Internal(format!("enlace de certificado: {e}")))?;
        }
        Ok(dir)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CertDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Directorio base de certificados temporales: junto a los túneles.
pub fn default_certs_dir() -> PathBuf {
    let tunnels = crate::fsutil::default_tunnels_dir();
    tunnels.parent().unwrap_or(&tunnels).join("certs")
}

/// ¿El texto de un error de transporte es de TLS/certificados?
pub fn looks_like_tls_error(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    [
        "certificate",
        "handshake",
        "tls",
        "unknownissuer",
        "unknown issuer",
        "badcertificate",
        "close_notify",
        "alert",
        "invalid peer",
    ]
    .iter()
    .any(|n| t.contains(n))
}

/// Fallo TLS con mensaje guiado.
pub fn tls_failure(detail: &str) -> Failure {
    let d: String = detail
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    Failure {
        cause: ConnectionCause::TlsInvalid,
        message: format!(
            "falló la conexión TLS: revisa la CA, el certificado de cliente y que el nombre del servidor esté en su certificado ({d})"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = PathBuf::from("/tmp").join(format!(
            "dktest-tls-{}",
            &uuid::Uuid::now_v7().simple().to_string()[20..]
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn spec(d: &Path) -> ConnSpec {
        ConnSpec::Tls {
            name: "t".into(),
            host: "127.0.0.1".into(),
            port: 2376,
            ca_path: d.join("ca.pem").to_string_lossy().into_owned(),
            cert_path: d.join("cert.pem").to_string_lossy().into_owned(),
            key_path: d.join("key.pem").to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn exige_los_tres_archivos() {
        let d = tmp();
        assert!(TlsTarget::from_spec(&spec(&d)).is_err());
        for f in ["ca.pem", "cert.pem"] {
            fs::write(d.join(f), "x").unwrap();
        }
        assert!(TlsTarget::from_spec(&spec(&d)).is_err());
        fs::write(d.join("key.pem"), "x").unwrap();
        let t = TlsTarget::from_spec(&spec(&d)).unwrap();
        assert_eq!(t.addr(), "tcp://127.0.0.1:2376");
        assert_eq!(t.label(), "tls://127.0.0.1:2376");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn cert_dir_usa_enlaces_privados_y_se_borra() {
        use std::os::unix::fs::MetadataExt;
        let d = tmp();
        for f in ["ca.pem", "cert.pem", "key.pem"] {
            fs::write(d.join(f), "x").unwrap();
        }
        let t = TlsTarget::from_spec(&spec(&d)).unwrap();
        let cd = CertDir::create(&d.join("certs"), &t).unwrap();
        let p = cd.path().to_path_buf();
        assert_eq!(fs::metadata(&p).unwrap().mode() & 0o777, 0o700);
        for f in ["ca.pem", "cert.pem", "key.pem"] {
            let l = fs::symlink_metadata(p.join(f)).unwrap();
            assert!(
                l.file_type().is_symlink(),
                "{f} debe ser un enlace, no una copia"
            );
        }
        drop(cd);
        assert!(!p.exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn detecta_errores_tls() {
        assert!(looks_like_tls_error(
            "invalid peer certificate: UnknownIssuer"
        ));
        assert!(looks_like_tls_error("received fatal alert: BadCertificate"));
        assert!(!looks_like_tls_error("connection refused"));
        assert_eq!(tls_failure("x\u{7}y").cause, ConnectionCause::TlsInvalid);
    }
}
