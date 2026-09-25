//! Ensamblado de líneas de log a partir de frames del daemon.
//!
//! bollard entrega `LogOutput` por *frame* (no por línea): un frame puede traer varias líneas
//! o media línea. Se mantiene un buffer parcial por stream, con tope de memoria.

use engine_core::{LogLine, LogStream};

/// Tope de longitud de línea: el resto hasta el salto de línea se descarta (`truncated`).
pub const MAX_LINE_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct Splitter {
    buf: Vec<u8>,
    overflow: bool,
}

impl Splitter {
    fn push(&mut self, data: &[u8], stream: LogStream, out: &mut Vec<LogLine>) {
        let mut rest = data;
        while let Some(pos) = rest.iter().position(|b| *b == b'\n') {
            self.append(&rest[..pos]);
            out.push(self.take(stream));
            rest = &rest[pos + 1..];
        }
        self.append(rest);
    }

    fn append(&mut self, chunk: &[u8]) {
        let room = MAX_LINE_BYTES.saturating_sub(self.buf.len());
        if chunk.len() > room {
            self.overflow = true;
        }
        self.buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    fn take(&mut self, stream: LogStream) -> LogLine {
        let mut bytes = std::mem::take(&mut self.buf);
        let truncated = std::mem::take(&mut self.overflow);
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        to_line(&bytes, stream, truncated)
    }

    fn finish(&mut self, stream: LogStream, out: &mut Vec<LogLine>) {
        if !self.buf.is_empty() || self.overflow {
            out.push(self.take(stream));
        }
    }
}

/// ¿Empieza `s` con un timestamp RFC3339 (`2026-09-24T14:02:11.123456789Z`)?
fn looks_like_timestamp(s: &[u8]) -> bool {
    s.len() >= 20
        && s[..4].iter().all(u8::is_ascii_digit)
        && s[4] == b'-'
        && s[7] == b'-'
        && s[10] == b'T'
        && s[13] == b':'
        && s[16] == b':'
        && (s[s.len() - 1] == b'Z' || s[s.len() - 6..].contains(&b':'))
}

fn to_line(bytes: &[u8], stream: LogStream, truncated: bool) -> LogLine {
    let (timestamp, body) = match bytes.iter().position(|b| *b == b' ') {
        Some(i) if looks_like_timestamp(&bytes[..i]) => (
            Some(String::from_utf8_lossy(&bytes[..i]).into_owned()),
            &bytes[i + 1..],
        ),
        _ => (None, bytes),
    };
    LogLine {
        stream,
        timestamp,
        // Los logs no son de fiar: UTF-8 inválido y NUL se sustituyen.
        message: String::from_utf8_lossy(body).replace('\0', "\u{FFFD}"),
        truncated,
    }
}

/// Un buffer parcial por stream (stdout / stderr / console).
#[derive(Default)]
pub struct LineAssembler {
    stdout: Splitter,
    stderr: Splitter,
    console: Splitter,
}

impl LineAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, stream: LogStream, data: &[u8]) -> Vec<LogLine> {
        let mut out = Vec::new();
        let sp = match stream {
            LogStream::Stdout => &mut self.stdout,
            LogStream::Stderr => &mut self.stderr,
            LogStream::Console => &mut self.console,
        };
        sp.push(data, stream, &mut out);
        out
    }

    /// Vacía lo pendiente al terminar el stream.
    pub fn finish(&mut self) -> Vec<LogLine> {
        let mut out = Vec::new();
        self.stdout.finish(LogStream::Stdout, &mut out);
        self.stderr.finish(LogStream::Stderr, &mut out);
        self.console.finish(LogStream::Console, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(v: &[LogLine]) -> Vec<&str> {
        v.iter().map(|l| l.message.as_str()).collect()
    }

    #[test]
    fn media_linea_entre_frames_y_varias_lineas() {
        let mut a = LineAssembler::new();
        assert!(a.push(LogStream::Stdout, b"hol").is_empty());
        let l = a.push(LogStream::Stdout, b"a\nsegunda\ntercera");
        assert_eq!(msgs(&l), ["hola", "segunda"]);
        assert_eq!(msgs(&a.finish()), ["tercera"]);
    }

    #[test]
    fn buffers_separados_por_stream() {
        let mut a = LineAssembler::new();
        a.push(LogStream::Stdout, b"out-");
        let l = a.push(LogStream::Stderr, b"err\n");
        assert_eq!(l[0].stream, LogStream::Stderr);
        let l = a.push(LogStream::Stdout, b"fin\n");
        assert_eq!(msgs(&l), ["out-fin"]);
        assert_eq!(l[0].stream, LogStream::Stdout);
    }

    #[test]
    fn crlf_de_tty_y_lineas_vacias() {
        let mut a = LineAssembler::new();
        let l = a.push(LogStream::Console, b"uno\r\n\r\ndos\r\n");
        assert_eq!(msgs(&l), ["uno", "", "dos"]);
        assert!(l.iter().all(|x| x.stream == LogStream::Console));
    }

    #[test]
    fn timestamp_presente_y_ausente() {
        let mut a = LineAssembler::new();
        let l = a.push(
            LogStream::Stdout,
            b"2026-09-24T14:02:11.123456789Z hola mundo\nsin marca de tiempo\n2026-09-24 nada\n",
        );
        assert_eq!(
            l[0].timestamp.as_deref(),
            Some("2026-09-24T14:02:11.123456789Z")
        );
        assert_eq!(l[0].message, "hola mundo");
        assert_eq!(l[1].timestamp, None);
        assert_eq!(l[1].message, "sin marca de tiempo");
        assert_eq!(l[2].timestamp, None);
    }

    #[test]
    fn utf8_invalido_y_nul() {
        let mut a = LineAssembler::new();
        let l = a.push(LogStream::Stdout, b"a\xffb\0c\n");
        assert_eq!(l[0].message, "a\u{FFFD}b\u{FFFD}c");
    }

    #[test]
    fn frame_gigante_sin_salto_de_linea_no_crece_sin_tope() {
        let mut a = LineAssembler::new();
        let big = vec![b'x'; 5 * 1024 * 1024];
        assert!(a.push(LogStream::Stdout, &big).is_empty());
        assert!(a.stdout.buf.len() <= MAX_LINE_BYTES);
        // Lo que llega después, hasta el salto de línea, también se descarta.
        let l = a.push(LogStream::Stdout, b"mas\nsiguiente\n");
        assert_eq!(l.len(), 2);
        assert!(l[0].truncated);
        assert_eq!(l[0].message.len(), MAX_LINE_BYTES);
        assert!(!l[1].truncated);
        assert_eq!(l[1].message, "siguiente");
    }

    #[test]
    fn frame_gigante_con_muchas_lineas() {
        let mut a = LineAssembler::new();
        let data: Vec<u8> = (0..100_000)
            .flat_map(|_| b"linea\n".iter().copied())
            .collect();
        assert_eq!(a.push(LogStream::Stdout, &data).len(), 100_000);
    }
}
