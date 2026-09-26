//! `logs <id> [-f] [--tail N]`.

use engine_core::{EngineClient, LogStream, LogsRequest};
use futures_util::StreamExt;

use crate::ctx::{Ctx, ctrl_c};
use crate::output::print_ndjson;

pub async fn logs(ctx: &Ctx, id: &str, follow: bool, tail: Option<u32>) -> Result<(), String> {
    engine_core::validate::container_id(id).map_err(|e| e.to_string())?;
    let req = LogsRequest {
        tail,
        follow,
        since: None,
    };
    let mut stream = ctx.engine.logs(id, req);
    let mut cancel = std::pin::pin!(ctrl_c());
    loop {
        let item = tokio::select! {
            i = stream.next() => i,
            _ = &mut cancel => return Ok(()),
        };
        let Some(item) = item else { return Ok(()) };
        let line = item.map_err(|e| e.to_string())?;
        if ctx.json {
            print_ndjson(&line);
            continue;
        }
        // writeln: si la salida se corta (`| head`) se termina sin pánico.
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let r = match line.stream {
            LogStream::Stderr => {
                drop(out);
                eprintln!("{}", line.message);
                Ok(())
            }
            _ => writeln!(out, "{}", line.message),
        };
        if r.is_err() {
            return Ok(());
        }
    }
}
