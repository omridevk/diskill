use crate::clean;
use crate::http::{self, constant_eq, query_token, refuse, respond};
use crate::review::approved_page;
use crate::util;
use serde_json::Value;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(1);
const BIND_FOR: Duration = Duration::from_secs(10);
const CLOSING_GRACE: Duration = Duration::from_secs(1);

struct Tail {
    inode: Option<u64>,
    offset: u64,
    pending: Vec<u8>,
}

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

fn read_from(path: &Path, tail: &mut Tail) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    let replaced = tail.inode != Some(meta.ino()) || meta.len() < tail.offset;
    if replaced {
        *tail = Tail {
            inode: Some(meta.ino()),
            offset: 0,
            pending: Vec::new(),
        };
    }
    if file.seek(SeekFrom::Start(tail.offset)).is_ok()
        && let Ok(n) = file.read_to_end(&mut tail.pending)
    {
        tail.offset += n as u64;
    }
    true
}

fn stream_events(out: &mut TcpStream, path: &Path) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    if out.write_all(head.as_bytes()).is_err() {
        return;
    }
    let mut tail = Tail {
        inode: None,
        offset: 0,
        pending: Vec::new(),
    };
    let (mut waited, mut quiet) = (false, Instant::now());
    loop {
        let mut chunk = String::new();
        if read_from(path, &mut tail) {
            chunk = complete_lines(&mut tail.pending);
        } else if !waited {
            waited = true;
            chunk = sse("waiting", "{}");
        }
        if chunk.is_empty() && http::client_gone(out) {
            return;
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

fn handle(mut write: TcpStream, port: u16, token: &str, dir: &Path, clients: &Mutex<Clients>) {
    let req = match http::read_request(&mut write) {
        Ok(req) => req,
        Err(Some(status)) => return refuse(&mut write, status),
        Err(None) => return,
    };
    if !http::is_local_host(&req, port) {
        return refuse(&mut write, "403 Forbidden");
    }
    let target = req.target.as_str();
    let route = target.split('?').next().unwrap_or("");
    if req.method != "GET" {
        respond(
            &mut write,
            "405 Method Not Allowed",
            "text/plain",
            b"read only",
        );
    } else if route != "/events" {
        match approved_page(dir, token).filter(|_| http::is_page_route(route)) {
            Some(html) => respond(
                &mut write,
                "200 OK",
                "text/html; charset=utf-8",
                html.as_bytes(),
            ),
            None => refuse(&mut write, "404 Not Found"),
        }
    } else if !constant_eq(query_token(target).as_bytes(), token.as_bytes()) {
        refuse(&mut write, "403 Forbidden");
    } else {
        lock(clients).open += 1;
        stream_events(&mut write, &dir.join("clean.events"));
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
    let (served, accepted) = (dir.clone(), Arc::clone(&clients));
    std::thread::spawn(move || {
        http::serve(listener, move |stream| {
            handle(stream, port, &token, &served, &accepted)
        });
    });
    let mut closing: Option<Instant> = None;
    loop {
        std::thread::sleep(POLL);
        let up = began.elapsed();
        let status = clean::run_status(&dir);
        let never_started = status.is_empty() && !dir.join("clean.events").exists();
        if never_started && up >= start && closing.is_none() {
            let _ = clean::abandon(&dir, "abandoned", "clean was never run after the approval");
            closing = Some(Instant::now());
        }
        if status == "abandoned" || status == "interrupted" {
            closing.get_or_insert_with(Instant::now);
        }
        let idle_now = {
            let c = lock(&clients);
            c.open == 0 && c.last.elapsed() >= idle
        };
        if up >= most
            || closing.is_some_and(|t| t.elapsed() >= CLOSING_GRACE)
            || (status == "done" && idle_now)
        {
            return Ok(0);
        }
    }
}
