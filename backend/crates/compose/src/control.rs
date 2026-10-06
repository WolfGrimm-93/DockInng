//! `impl StackControl for ComposeRunner`: editor de stacks, validación, operaciones y `down`.

use std::fs::{DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use engine_core::{
    CancelSignal, ComposeContainer, ComposeInfo, EngineError, StackControl, StackFiles, StackOp,
    StackOpFeed, StackOpRun, StackOrigin, StackOutcome, StackSink, StackSummary, StackValidation,
};

use crate::args::{ConfigFiles, ProjectSpec};
use crate::error::ComposeError;
use crate::files::{
    MAX_ENV_BYTES, MAX_YAML_BYTES, ResolvedStack, StackStore, StoredStack, read_external_readonly,
    validate_external_file,
};
use crate::risks::analyze_with;
use crate::runner::{ComposeRunner, PreparedOp, env_secret_values, lock, project_of};
use crate::summary::{DeclaredServices, summarize};
use crate::types::{OpKind, split_op};
use crate::validate::{infer_lines, validate_service_list, validate_stack_name};

type EResult<T> = Result<T, EngineError>;

fn text_ok(text: &str, max: usize, what: &str) -> Result<(), ComposeError> {
    if text.len() > max {
        return Err(ComposeError::InvalidInput(format!(
            "{what} demasiado grande"
        )));
    }
    if text.contains('\0') {
        return Err(ComposeError::InvalidInput(format!(
            "{what} contiene bytes NUL"
        )));
    }
    Ok(())
}

/// Directorio temporal 0700 con un `.env` 0600 para validar; se borra siempre al soltar.
struct ValidationDir {
    dir: PathBuf,
}

impl ValidationDir {
    fn create(env: &str) -> Result<Self, ComposeError> {
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_dir())
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "dockinng-validate-{}",
            uuid::Uuid::now_v7().simple()
        ));
        DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| ComposeError::io("crear directorio temporal", &e))?;
        let this = Self { dir };
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(this.dir.join(".env"))
            .map_err(|e| ComposeError::io("crear .env temporal", &e))?;
        f.write_all(env.as_bytes())
            .map_err(|e| ComposeError::io("escribir .env temporal", &e))?;
        Ok(this)
    }
    fn env_path(&self) -> PathBuf {
        self.dir.join(".env")
    }
}

impl Drop for ValidationDir {
    fn drop(&mut self) {
        // En `drop` no hay a quién devolver el error: se avisa por stderr (sin rutas, solo el
        // tipo de fallo). Que el archivo ya no exista es lo normal y no se avisa.
        let avisar = |paso: &str, r: std::io::Result<()>| {
            if let Err(e) = r
                && e.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!(
                    "aviso: no se pudo limpiar la validación temporal ({paso}: {:?})",
                    e.kind()
                );
            }
        };
        avisar("borrar .env", std::fs::remove_file(self.dir.join(".env")));
        avisar("borrar directorio", std::fs::remove_dir(&self.dir));
    }
}

/// Deriva un nombre de proyecto válido a partir del que devuelve `config`.
fn sanitize_project_name(raw: &str) -> Option<String> {
    let mut s: String = raw
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while s.starts_with(['-', '_']) {
        s.remove(0);
    }
    s.truncate(63);
    validate_stack_name(&s).ok().map(|_| s)
}

impl ComposeRunner {
    async fn blocking<T, F>(&self, f: F) -> Result<T, ComposeError>
    where
        T: Send + 'static,
        F: FnOnce(&StackStore) -> Result<T, ComposeError> + Send + 'static,
    {
        let core = self.core.clone();
        tokio::task::spawn_blocking(move || f(&core.store))
            .await
            .map_err(|_| ComposeError::Internal("la tarea de disco falló".into()))?
    }

    /// Servicios declarados de los stacks sin contenedores (4 en paralelo, 5 s, caché por marca).
    async fn declared_services(&self, names: Vec<String>) -> DeclaredServices {
        let mut out = DeclaredServices::new();
        let Ok(info) = self.core.require_compose().await else {
            return out;
        };
        let sem = Arc::new(tokio::sync::Semaphore::new(4));
        let mut set = tokio::task::JoinSet::new();
        for name in names {
            let core = self.core.clone();
            let sem = sem.clone();
            set.spawn(async move {
                let resolved = {
                    let core2 = core.clone();
                    let n = name.clone();
                    tokio::task::spawn_blocking(move || core2.store.resolve(&n))
                        .await
                        .ok()
                        .and_then(Result::ok)
                }?;
                let stamp = StackStore::revision_of(&resolved);
                if let Some((s, v)) = lock(&core.declared_cache).get(&name)
                    && *s == stamp
                {
                    return Some((name, v.clone()));
                }
                let _permit = sem.acquire().await.ok()?;
                let project = project_of(&resolved);
                let cwd = resolved.project_dir.clone();
                let cfg = tokio::time::timeout(
                    Duration::from_secs(5),
                    core.config(info.flavor, &project, &cwd, None, &[]),
                )
                .await
                .ok()?
                .ok()?;
                let v: Vec<(String, String)> = cfg
                    .services
                    .into_iter()
                    .map(|s| (s.name, s.image.unwrap_or_default()))
                    .collect();
                lock(&core.declared_cache).insert(name.clone(), (stamp, v.clone()));
                Some((name, v))
            });
        }
        while let Some(r) = set.join_next().await {
            if let Ok(Some((n, v))) = r {
                out.insert(n, v);
            }
        }
        out
    }

    /// Proyecto para operar sobre un stack: propio/vinculado con archivos, o descubierto por nombre.
    async fn project_for(
        &self,
        name: &str,
    ) -> Result<(ProjectSpec, StackOrigin, Vec<String>), ComposeError> {
        validate_stack_name(name)?;
        let n = name.to_string();
        let resolved = self
            .blocking(move |s| match s.origin_of(&n)? {
                Some(_) => s.resolve(&n).map(Some),
                None => Ok(None),
            })
            .await?;
        match resolved {
            Some(r) => {
                let secrets = read_secrets(&r);
                Ok((project_of(&r), r.origin, secrets))
            }
            None => Ok((
                ProjectSpec {
                    name: name.to_string(),
                    project_dir: None,
                    files: ConfigFiles::None,
                    env_file: None,
                },
                StackOrigin::Discovered,
                vec![],
            )),
        }
    }

    pub async fn prepare(
        &self,
        name: &str,
        kind: OpKind,
        services: Vec<String>,
    ) -> Result<PreparedOp, ComposeError> {
        validate_service_list(&services)?;
        let info = self.core.require_compose().await?;
        let (project, origin, secrets) = self.project_for(name).await?;
        if origin == StackOrigin::Discovered
            && !matches!(
                kind,
                OpKind::Down
                    | OpKind::Lifecycle(crate::types::StackOpKind::Stop)
                    | OpKind::Lifecycle(crate::types::StackOpKind::Start)
                    | OpKind::Lifecycle(crate::types::StackOpKind::Restart)
            )
        {
            return Err(ComposeError::Denied(
                "este stack solo fue descubierto; vincula su archivo compose para gestionarlo"
                    .into(),
            ));
        }
        let guard = self.core.acquire(name)?;
        Ok(PreparedOp {
            core: self.core.clone(),
            stack: name.to_string(),
            kind,
            services,
            project,
            secrets,
            info,
            _guard: guard,
        })
    }
}

/// Valores a redactar: los del `.env` y los de `environment:` del YAML con nombre de secreto.
fn read_secrets(r: &ResolvedStack) -> Vec<String> {
    let mut v: Vec<String> = r
        .env_file
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .filter(|t| t.len() <= MAX_ENV_BYTES)
        .map(|t| env_secret_values(&t))
        .unwrap_or_default();
    for f in &r.config_files {
        if let Ok(t) = std::fs::read_to_string(f)
            && t.len() <= MAX_YAML_BYTES
        {
            v.extend(crate::validate::yaml_secret_values(&t));
        }
    }
    v.sort_by_key(|s| std::cmp::Reverse(s.len()));
    v.dedup();
    v
}

#[async_trait]
impl StackControl for ComposeRunner {
    async fn down(&self, project: &str) -> EResult<()> {
        let op = self.prepare(project, OpKind::Down, vec![]).await?;
        let result: Arc<Mutex<Option<StackOpFeed>>> = Arc::new(Mutex::new(None));
        let r2 = result.clone();
        let sink: StackSink = Arc::new(move |ev| {
            if matches!(ev, StackOpFeed::Ended { .. }) {
                *lock(&r2) = Some(ev);
            }
        });
        let never: CancelSignal = Box::pin(std::future::pending());
        op.execute(sink, never).await;
        let ended = lock(&result).take();
        match ended {
            Some(StackOpFeed::Ended {
                outcome: StackOutcome::Success,
                ..
            }) => Ok(()),
            Some(StackOpFeed::Ended {
                outcome: StackOutcome::Timeout,
                ..
            }) => Err(EngineError::Timeout),
            Some(StackOpFeed::Ended { error: Some(e), .. }) => {
                Err(EngineError::coded(e.code, e.message))
            }
            _ => Err(EngineError::Internal(
                "bajar el stack terminó sin resultado".into(),
            )),
        }
    }

    async fn delete_files(&self, name: &str) -> EResult<()> {
        self.core.store.require_available()?;
        let n = name.to_string();
        Ok(self.blocking(move |s| s.delete_managed(&n)).await?)
    }

    async fn origin_of(&self, name: &str) -> EResult<Option<StackOrigin>> {
        let n = name.to_string();
        Ok(self.blocking(move |s| s.origin_of(&n)).await?)
    }

    async fn compose_info(&self, recheck: bool) -> ComposeInfo {
        self.core.info(recheck).await
    }

    async fn list_stacks(&self, containers: Vec<ComposeContainer>) -> EResult<Vec<StackSummary>> {
        let stored: Vec<StoredStack> = self.blocking(|s| Ok(s.list())).await?;
        let editable: Vec<(String, bool)> = {
            let names: Vec<(String, StackOrigin)> =
                stored.iter().map(|s| (s.name.clone(), s.origin)).collect();
            self.blocking(move |s| {
                Ok(names
                    .into_iter()
                    .map(|(n, o)| {
                        let e =
                            o == StackOrigin::Managed || s.resolve(&n).is_ok_and(|r| r.editable);
                        (n, e)
                    })
                    .collect::<Vec<_>>())
            })
            .await?
        };
        let with_containers: std::collections::HashSet<&str> =
            containers.iter().map(|c| c.project.as_str()).collect();
        let empty: Vec<String> = stored
            .iter()
            .filter(|s| !with_containers.contains(s.name.as_str()))
            .map(|s| s.name.clone())
            .collect();
        let declared = if empty.is_empty() {
            DeclaredServices::new()
        } else {
            self.declared_services(empty).await
        };
        Ok(summarize(
            &stored,
            &|s| {
                editable
                    .iter()
                    .find(|(n, _)| *n == s.name)
                    .is_some_and(|(_, e)| *e)
            },
            &containers,
            &declared,
        ))
    }

    async fn stack_read(
        &self,
        name: &str,
        containers: Vec<ComposeContainer>,
    ) -> EResult<StackFiles> {
        validate_stack_name(name)?;
        let n = name.to_string();
        if self.origin_of(name).await?.is_some() {
            return Ok(self.blocking(move |s| s.read(&n)).await?);
        }
        // Descubierto: solo lectura del primer archivo que declaran las labels (validado).
        let files: Vec<String> = containers
            .iter()
            .find(|c| c.project == name && !c.config_files.is_empty())
            .map(|c| c.config_files.clone())
            .ok_or_else(|| ComposeError::NotFound("stack no encontrado".into()))?;
        let first = files[0].clone();
        let yaml = self
            .blocking(move |_| read_external_readonly(Path::new(&first)))
            .await?;
        Ok(StackFiles {
            name: name.to_string(),
            origin: StackOrigin::Discovered,
            yaml,
            env: String::new(),
            path: files[0].clone(),
            env_path: String::new(),
            editable: false,
            config_files: files,
            revision: String::new(),
        })
    }

    async fn stack_save(
        &self,
        name: &str,
        yaml: &str,
        env: &str,
        expected_revision: Option<&str>,
    ) -> EResult<StackFiles> {
        validate_stack_name(name)?;
        self.core.store.require_available()?;
        text_ok(yaml, MAX_YAML_BYTES, "compose")?;
        text_ok(env, MAX_ENV_BYTES, ".env")?;
        if self.origin_of(name).await?.is_none() {
            return Err(ComposeError::Denied(
                "este stack solo fue descubierto y es de solo lectura: vincúlalo para editarlo"
                    .into(),
            )
            .into());
        }
        let (n, y, e, rev) = (
            name.to_string(),
            yaml.to_string(),
            env.to_string(),
            expected_revision.map(str::to_string),
        );
        Ok(self
            .blocking(move |s| s.save(&n, &y, &e, rev.as_deref()))
            .await?)
    }

    async fn stack_validate(
        &self,
        name: Option<&str>,
        yaml: &str,
        env: &str,
    ) -> EResult<StackValidation> {
        text_ok(yaml, MAX_YAML_BYTES, "compose")?;
        text_ok(env, MAX_ENV_BYTES, ".env")?;
        let info = self.core.require_compose().await?;
        // Tope de validaciones simultáneas (cada una lanza `docker compose config`).
        let _permit = self
            .core
            .validate_sem
            .acquire()
            .await
            .map_err(|_| ComposeError::Internal("semáforo cerrado".into()))?;
        let tmp = ValidationDir::create(env)?;
        let (project_name, project_dir) = match name {
            Some(n) => {
                validate_stack_name(n)?;
                let n2 = n.to_string();
                let r = self.blocking(move |s| s.resolve(&n2)).await?;
                (n.to_string(), r.project_dir)
            }
            None => ("validacion".to_string(), tmp.dir.clone()),
        };
        let project = ProjectSpec {
            name: project_name,
            project_dir: Some(project_dir.clone()),
            files: ConfigFiles::Stdin,
            env_file: Some(tmp.env_path()),
        };
        let mut secrets = env_secret_values(env);
        secrets.extend(crate::validate::yaml_secret_values(yaml));
        let result = self
            .core
            .config(
                info.flavor,
                &project,
                &project_dir,
                Some(yaml.as_bytes().to_vec()),
                &secrets,
            )
            .await;
        drop(tmp);
        match result {
            Ok(cfg) => {
                let home = std::env::var("HOME").ok();
                Ok(StackValidation {
                    ok: true,
                    issues: vec![],
                    services: cfg.services.iter().map(|s| s.name.clone()).collect(),
                    risks: analyze_with(&cfg.raw, home.as_deref(), self.core.is_remote()),
                })
            }
            Err(ComposeError::Invalid(mut issues)) => {
                infer_lines(yaml, &mut issues);
                Ok(StackValidation {
                    ok: false,
                    issues,
                    services: vec![],
                    risks: vec![],
                })
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn stack_create(&self, name: &str, yaml: &str, env: &str) -> EResult<StackFiles> {
        let (n, y, e) = (name.to_string(), yaml.to_string(), env.to_string());
        Ok(self.blocking(move |s| s.create(&n, &y, &e)).await?)
    }

    async fn stack_link(&self, path: &str, containers: Vec<ComposeContainer>) -> EResult<String> {
        let info = self.core.require_compose().await?;
        // `~/` se expande aquí (con $HOME del proceso) ANTES de validar.
        let p = crate::files::expand_tilde(path)?;
        let p2 = p.clone();
        let canon = self
            .blocking(move |_| validate_external_file(&p2, MAX_YAML_BYTES, true))
            .await?;
        let dir = canon
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| ComposeError::InvalidInput("ruta sin directorio".into()))?;
        // Sin `-p`: Compose resuelve `name:` del YAML o el nombre del directorio; sin `--env-file`:
        // usa el `.env` del directorio, como en la terminal.
        // `.env` solo si es un archivo normal dentro del proyecto; si no, `/dev/null` para que
        // Compose no autocargue un `.env` symlink hacia un archivo ajeno.
        let env_file = {
            let (d2, e2) = (dir.clone(), dir.join(".env"));
            self.blocking(move |_| Ok(crate::files::confined_env(&e2, &d2)))
                .await?
        }
        .unwrap_or_else(|| PathBuf::from("/dev/null"));
        let project = ProjectSpec {
            name: String::new(),
            project_dir: Some(dir.clone()),
            files: ConfigFiles::Paths(vec![canon.clone()]),
            env_file: Some(env_file),
        };
        let cfg = self
            .core
            .config(info.flavor, &project, &dir, None, &[])
            .await?;
        let raw = cfg.name.unwrap_or_default();
        let name = sanitize_project_name(&raw).ok_or_else(|| {
            ComposeError::InvalidInput(
                "no se pudo derivar un nombre de stack válido de este compose".into(),
            )
        })?;
        // Un `name:` que coincide con un proyecto EXISTENTE de otro origen haría que up/down
        // operen sobre contenedores ajenos: solo se vincula si esos contenedores ya usan este archivo.
        let same: Vec<&ComposeContainer> = containers
            .iter()
            .filter(|c| c.project == name && !c.oneoff)
            .collect();
        if !same.is_empty() {
            let c2 = canon.clone();
            let labels: Vec<Vec<String>> = same.iter().map(|c| c.config_files.clone()).collect();
            let all_match = self
                .blocking(move |_| {
                    Ok(labels.iter().all(|files| {
                        files
                            .iter()
                            .any(|f| std::fs::canonicalize(f).is_ok_and(|x| x == c2))
                    }))
                })
                .await?;
            if !all_match {
                return Err(ComposeError::Conflict(format!(
                    "ya existe un proyecto de Compose llamado `{name}` con otros archivos; cambia `name:` en tu compose antes de vincularlo"
                ))
                .into());
            }
        }
        let n = name.clone();
        self.blocking(move |s| s.link(&n, &[canon], None, None).map(|_| ()))
            .await?;
        Ok(name)
    }

    async fn stack_unlink(&self, name: &str) -> EResult<()> {
        self.core.store.require_available()?;
        let n = name.to_string();
        Ok(self.blocking(move |s| s.unlink(&n)).await?)
    }

    async fn prepare_op(&self, name: &str, op: StackOp) -> EResult<Box<dyn StackOpRun>> {
        let (kind, services) = split_op(&op);
        let prepared = self
            .prepare(name, OpKind::Lifecycle(kind), services)
            .await?;
        Ok(Box::new(prepared))
    }
}
