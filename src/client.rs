use crate::proto::{self, ERR, EXIT, OUT};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn spawn_daemon() {
    let exe = std::env::current_exe().expect("exe");
    let log_dir = crate::proto::state_dir();
    proto::private_dir(&log_dir);
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("daemon.log"))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let mut c = Command::new(exe);
    c.arg("__daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    crate::ipc::detach(&mut c);
    let _ = c.spawn();
}

fn connect() -> Result<crate::ipc::ClientStream, String> {
    if let Some(s) = crate::ipc::try_connect()? {
        return Ok(s);
    }
    let t = Instant::now();
    let mut last_spawn: Option<Instant> = None;
    while t.elapsed() < Duration::from_secs(15) {
        // a daemon that is still shutting down holds the lock and makes a new one exit: keep trying
        if last_spawn.is_none_or(|l| l.elapsed() > Duration::from_millis(1200)) {
            spawn_daemon();
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
    let mut stdout = stdout.lock();
    loop {
        match proto::read_frame(&mut s) {
            Ok((OUT, d)) => {
                if stdout.write_all(&d).is_err() {
                    return 0;
                }
                let _ = stdout.flush();
            }
            Ok((ERR, d)) => {
                let _ = std::io::stderr().write_all(&d);
            }
            Ok((EXIT, d)) => return d.first().copied().unwrap_or(0) as i32,
            Ok(_) => {}
            Err(_) => {
                eprintln!("daemon connection lost");
                return 2;
            }
        }
    }
}
