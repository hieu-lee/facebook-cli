use crate::proto::{self, ERR, EXIT, OUT};
use std::io::Write;
use std::time::{Duration, Instant};

fn connect() -> Result<crate::ipc::ClientStream, String> {
    if let Some(s) = crate::ipc::try_connect()? {
        return Ok(s);
    }
    let t = Instant::now();
    let mut last_spawn: Option<Instant> = None;
    while t.elapsed() < Duration::from_secs(15) {
        // a daemon that is still shutting down holds the lock and makes a new one exit: keep trying
        if last_spawn.is_none_or(|l| l.elapsed() > Duration::from_millis(1200)) {
            let _ = crate::ipc::spawn_daemon();
            last_spawn = Some(Instant::now());
        }
        if let Some(s) = crate::ipc::try_connect()? {
            return Ok(s);
        }
        std::thread::sleep(Duration::from_millis(4));
    }
    Err(format!(
        "cannot start daemon (see {}/daemon.log)",
        crate::proto::state_dir().display()
    ))
}

/// `fb unlock -` (or no argument) takes the PIN from $FB_PIN or stdin, so it never shows in `ps`.
fn with_secret_from_env_or_stdin(mut argv: Vec<String>) -> Vec<String> {
    if argv.first().map(String::as_str) == Some("unlock") && argv.get(1).is_none_or(|a| a == "-") {
        let pin = std::env::var("FB_PIN").unwrap_or_else(|_| {
            let mut l = String::new();
            let _ = std::io::stdin().read_line(&mut l);
            l
        });
        argv.truncate(1);
        argv.push(pin.trim().to_string());
    }
    argv
}

pub fn run(argv: Vec<String>) -> i32 {
    let argv = with_secret_from_env_or_stdin(argv);
    if matches!(
        argv.first().map(String::as_str),
        Some("--version" | "-V" | "version")
    ) {
        println!("fb {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if matches!(
        argv.first().map(String::as_str),
        None | Some("help" | "-h" | "--help")
    ) {
        println!("{}", crate::help::HELP);
        return 0;
    }
    let mut s = match connect() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let token = crate::ipc::client_token();
    let req = if argv.first().map(String::as_str) == Some("batch") {
        let mut lines: Vec<String> = argv[1..].to_vec();
        if lines.is_empty() || lines.iter().any(|l| l == "-") {
            lines.retain(|l| l != "-");
            let mut input = String::new();
            let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
            lines.extend(
                input
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty() && !l.starts_with('#'))
                    .map(String::from),
            );
        }
        serde_json::json!({"batch": lines, "cwd": cwd, "token": token}).to_string() + "\n"
    } else {
        serde_json::json!({"argv": argv, "cwd": cwd, "token": token}).to_string() + "\n"
    };
    if s.write_all(req.as_bytes()).is_err() {
        eprintln!("daemon write failed");
        return 2;
    }
    let stdout = std::io::stdout();
    pump(&mut s, &mut stdout.lock(), &mut std::io::stderr())
}

/// True when `buf` already holds a whole frame, so the next read cannot block.
fn frame_buffered(buf: &[u8]) -> bool {
    buf.len() >= 5 && buf.len() - 5 >= u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize
}

/// Relay the daemon's frames to stdout/stderr; the result is the process exit code.
/// Frames that arrived together are read and written together; output is flushed before blocking
/// for the next frame and before anything goes to stderr, so streaming and ordering are unchanged.
pub(crate) fn pump(s: impl std::io::Read, stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    let mut s = std::io::BufReader::new(s);
    let mut stdout = std::io::BufWriter::new(stdout);
    loop {
        match proto::read_frame(&mut s) {
            Ok((OUT, d)) => {
                if stdout.write_all(&d).is_err()
                    || (!frame_buffered(s.buffer()) && stdout.flush().is_err())
                {
                    return 0;
                }
            }
            Ok((ERR, d)) => {
                if stdout.flush().is_err() {
                    return 0;
                }
                let _ = stderr.write_all(&d);
            }
            Ok((EXIT, d)) => {
                if stdout.flush().is_err() {
                    return 0;
                }
                return d.first().copied().unwrap_or(0) as i32;
            }
            Ok(_) => {}
            Err(_) => {
                let _ = stdout.flush();
                eprintln!("daemon connection lost");
                return 2;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    struct Tagged(&'static str, Rc<RefCell<Vec<String>>>);

    impl Write for Tagged {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.1
                .borrow_mut()
                .push(format!("{}:{}", self.0, String::from_utf8_lossy(b)));
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn buffered_output_keeps_its_order_with_stderr_and_returns_the_exit_code() {
        let mut wire = Vec::new();
        for (tag, body) in [
            (OUT, "a"),
            (OUT, "b"),
            (ERR, "!"),
            (OUT, "c"),
            (EXIT, "\u{7}"),
        ] {
            wire.extend(proto::encode(tag, body.as_bytes()));
        }
        let log = Rc::new(RefCell::new(Vec::new()));
        let code = pump(
            &wire[..],
            &mut Tagged("out", log.clone()),
            &mut Tagged("err", log.clone()),
        );
        assert_eq!(code, 7);
        assert_eq!(*log.borrow(), ["out:ab", "err:!", "out:c"]);
    }

    struct Closed;

    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn a_closed_stdout_ends_quietly_with_status_zero_even_when_exit_is_already_buffered() {
        for tail in [(EXIT, "\u{1}"), (ERR, "e")] {
            let mut wire = proto::encode(OUT, b"x\n");
            wire.extend(proto::encode(tail.0, tail.1.as_bytes()));
            let log = Rc::new(RefCell::new(Vec::new()));
            let code = pump(&wire[..], &mut Closed, &mut Tagged("err", log.clone()));
            assert_eq!(code, 0);
            assert!(log.borrow().is_empty());
        }
    }

    #[test]
    fn a_partly_buffered_next_frame_does_not_hold_back_finished_output() {
        let whole = proto::encode(OUT, b"a");
        assert!(frame_buffered(&whole));
        assert!(!frame_buffered(&whole[..whole.len() - 1]));
        assert!(!frame_buffered(&whole[..3]));
        assert!(!frame_buffered(&[]));
    }
}
