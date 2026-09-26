//! Vector de argumentos de `docker build` (función pura, testeable con snapshot).

use std::ffi::OsString;
use std::path::Path;

use engine_core::build::{BUILT_LABEL, BuildSpec};

/// `docker build …` con todo como argumentos separados (jamás una shell). `context` y el
/// Dockerfile ya están canonizados; `iidfile` es donde `docker` escribe el id de la imagen.
pub fn build_argv(
    spec: &BuildSpec,
    context: &Path,
    dockerfile: Option<&Path>,
    iidfile: &Path,
) -> Vec<OsString> {
    let mut a: Vec<OsString> = vec!["build".into()];
    a.push("--label".into());
    a.push(BUILT_LABEL.into());
    a.push("--iidfile".into());
    a.push(iidfile.into());
    if let Some(df) = dockerfile {
        a.push("-f".into());
        a.push(df.into());
    }
    if let Some(tag) = &spec.tag {
        a.push("-t".into());
        a.push(tag.into());
    }
    // Solo el NOMBRE en argv: el valor (posible secreto) viaja en el entorno del hijo y no
    // aparece en la lista de procesos.
    for (name, _) in &spec.build_args {
        a.push("--build-arg".into());
        a.push(name.into());
    }
    if let Some(t) = &spec.target {
        a.push("--target".into());
        a.push(t.into());
    }
    if spec.no_cache {
        a.push("--no-cache".into());
    }
    // Sin `--pull` no se toca la red para la imagen base salvo que la persona lo pida.
    if spec.pull {
        a.push("--pull".into());
    }
    a.push(context.into());
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: Vec<OsString>) -> Vec<String> {
        v.into_iter()
            .map(|x| x.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn minimo() {
        let spec = BuildSpec {
            context_dir: "/c".into(),
            dockerfile: None,
            tag: None,
            build_args: vec![],
            target: None,
            no_cache: false,
            pull: false,
        };
        assert_eq!(
            s(build_argv(
                &spec,
                Path::new("/c"),
                None,
                Path::new("/t/iid")
            )),
            [
                "build",
                "--label",
                "dev.dockinng.built=1",
                "--iidfile",
                "/t/iid",
                "/c"
            ]
        );
    }

    #[test]
    fn completo_y_sin_shell() {
        let spec = BuildSpec {
            context_dir: "/c".into(),
            dockerfile: Some("docker/Dockerfile.x".into()),
            tag: Some("app:1".into()),
            build_args: vec![("A".into(), "x; rm -rf /".into()), ("B".into(), "".into())],
            target: Some("prod".into()),
            no_cache: true,
            pull: true,
        };
        let got = s(build_argv(
            &spec,
            Path::new("/c"),
            Some(Path::new("/c/docker/Dockerfile.x")),
            Path::new("/t/iid"),
        ));
        assert_eq!(
            got,
            [
                "build",
                "--label",
                "dev.dockinng.built=1",
                "--iidfile",
                "/t/iid",
                "-f",
                "/c/docker/Dockerfile.x",
                "-t",
                "app:1",
                "--build-arg",
                "A",
                "--build-arg",
                "B",
                "--target",
                "prod",
                "--no-cache",
                "--pull",
                "/c"
            ]
        );
    }
}
