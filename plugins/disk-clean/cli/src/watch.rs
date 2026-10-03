use crate::review::{constant_eq, query_token, respond};
use crate::util;
use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(1);
const BIND_FOR: Duration = Duration::from_secs(10);

struct Clients {
    open: usize,
    last: Instant,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn seconds(name: &str, default: f64) -> Duration {
    Duration::from_secs_f64(util::env_num(name, default).max(0.0))
}

fn bind(port: u16) -> io::Result<TcpListener> {
    let deadline = Instant::now() + BIND_FOR;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            other => return other,
        }
    }
}

fn sse(name: &str, data: &str) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

fn complete_lines(pending: &mut Vec<u8>) -> String {
    let mut chunk = String::new();
    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=end).collect();
        let line = String::from_utf8_lossy(&line);
        let line = line.trim();
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(name) = event.get("event").and_then(Value::as_str)
            && !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_lowercase())
        {
            chunk.push_str(&sse(name, line));
        }
    }
    chunk
}

fn read_from(path: &Path, offset: &mut u64, pending: &mut Vec<u8>) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if file.seek(SeekFrom::Start(*offset)).is_ok()
        && let Ok(n) = file.read_to_end(pending)
    {
        *offset += n as u64;
    }
    true
}

fn stream_events(out: &mut TcpStream, path: &Path) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    if out.write_all(head.as_bytes()).is_err() {
        return;
    }
    let (mut offset, mut pending, mut waited) = (0, Vec::new(), false);
    let mut quiet = Instant::now();
    loop {
        let mut chunk = String::new();
        if read_from(path, &mut offset, &mut pending) {
            chunk = complete_lines(&mut pending);
        } else if !waited {
            waited = true;
            chunk = sse("waiting", "{}");
        }
        if chunk.is_empty() && quiet.elapsed() >= HEARTBEAT {
            chunk = ":\n\n".to_string();
        }
        if !chunk.is_empty() {
            if out.write_all(chunk.as_bytes()).is_err() {
                return;
            }
            quiet = Instant::now();
        }
        std::thread::sleep(POLL);
    }
}

fn handle(stream: TcpStream, token: &str, events: &Path, clients: &Mutex<Clients>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok(mut write) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) if line.trim().is_empty() => break,
            Ok(_) => {}
        }
    }
    let mut parts = request_line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let route = target.split('?').next().unwrap_or("");
    if method != "GET" {
        respond(
            &mut write,
            "405 Method Not Allowed",
            "text/plain",
            b"read only",
        );
    } else if route != "/events" {
        respond(&mut write, "404 Not Found", "text/plain", b"not found");
    } else if !constant_eq(query_token(target).as_bytes(), token.as_bytes()) {
        respond(&mut write, "403 Forbidden", "text/plain", b"forbidden");
    } else {
        lock(clients).open += 1;
        stream_events(&mut write, events);
        let mut c = lock(clients);
        c.open -= 1;
        c.last = Instant::now();
    }
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let token = std::env::var("DISK_CLEAN_WATCH_TOKEN").unwrap_or_default();
    let port = util::env_num("DISK_CLEAN_WATCH_PORT", 0u16);
    let (Some(dir), false, true) = (run_dir, token.is_empty(), port > 0) else {
        eprintln!(
            "usage: DISK_CLEAN_WATCH_TOKEN=.. DISK_CLEAN_WATCH_PORT=.. disk-clean watch RUN_DIR"
        );
        return Ok(2);
    };
    let idle = seconds("DISK_CLEAN_WATCH_IDLE", 60.0);
    let most = seconds("DISK_CLEAN_WATCH_MAX", 2700.0);
    let start = seconds("DISK_CLEAN_WATCH_START", 1800.0);
    let dir = PathBuf::from(dir);
    let listener = bind(port)?;
    let began = Instant::now();
    let clients = Arc::new(Mutex::new(Clients {
        open: 0,
        last: began,
    }));
    let (events, accepted) = (dir.join("clean.events"), Arc::clone(&clients));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (token, events, clients) = (token.clone(), events.clone(), Arc::clone(&accepted));
            std::thread::spawn(move || handle(stream, &token, &events, &clients));
        }
    });
    loop {
        std::thread::sleep(POLL);
        let up = began.elapsed();
        let finished = fs::read_to_string(dir.join("status")).is_ok_and(|s| s.trim() == "done");
        let idle_now = {
            let c = lock(&clients);
            c.open == 0 && c.last.elapsed() >= idle
        };
        if up >= most
            || (up >= start && !dir.join("clean.events").exists())
            || (finished && idle_now)
        {
            return Ok(0);
        }
    }
}
