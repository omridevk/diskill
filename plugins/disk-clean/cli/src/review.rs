use crate::clean;
use crate::scan::{self, Sink};
use crate::util;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

const PAGE: &str = include_str!("../assets/page.html");
const TIMEOUT: Duration = Duration::from_secs(1800);
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(15);
const NOTHING_FOUND: &str = "nothing-found";

#[derive(Serialize, Clone)]
pub struct Item {
    pub path: String,
    pub label: String,
    pub bytes: i64,
    pub action: String,
    pub cmd_id: String,
    pub note: String,
    pub age: Option<i64>,
    pub accuracy: String,
    pub preselect: bool,
    pub report: bool,
}

#[derive(Serialize)]
pub struct Category {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub risk: String,
    pub items: Vec<Item>,
    pub bytes: i64,
}

#[derive(Serialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub bytes: i64,
    pub children: Vec<Node>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub rest: bool,
}

pub fn parse_row(f: &[&str]) -> Option<(Value, Item)> {
    let [
        id,
        title,
        desc,
        risk,
        pre,
        action,
        cmd_id,
        label,
        path,
        bytes,
        note,
        age,
        accuracy,
    ] = f
    else {
        return None;
    };
    let bytes = bytes.trim().parse::<i64>().ok()?;
    let item = Item {
        path: path.to_string(),
        label: label.to_string(),
        bytes,
        action: action.to_string(),
        cmd_id: cmd_id.to_string(),
        note: note.to_string(),
        age: if !age.is_empty() && age.bytes().all(|b| b.is_ascii_digit()) {
            age.parse().ok()
        } else {
            None
        },
        accuracy: if accuracy.is_empty() {
            "exact".to_string()
        } else {
            accuracy.to_string()
        },
        preselect: *pre == "1" && *risk != "report",
        report: *risk == "report",
    };
    Some((
        json!({"id": id, "title": title, "desc": desc, "risk": risk}),
        item,
    ))
}

pub fn load_scan(run_dir: &Path) -> Vec<Category> {
    let mut cats: Vec<Category> = Vec::new();
    for line in util::read_lines(&run_dir.join("scan.tsv")) {
        let f: Vec<&str> = line.split('\t').collect();
        let Some((_, item)) = parse_row(&f) else {
            continue;
        };
        match cats.iter_mut().find(|c| c.id == f[0]) {
            Some(c) => c.items.push(item),
            None => cats.push(Category {
                id: f[0].to_string(),
                title: f[1].to_string(),
                desc: f[2].to_string(),
                risk: f[3].to_string(),
                items: vec![item],
                bytes: 0,
            }),
        }
    }
    for c in &mut cats {
        c.items.sort_by_key(|i| -i.bytes);
        c.bytes = c.items.iter().map(|i| i.bytes).sum();
    }
    cats.sort_by_key(|c| (c.risk == "report", -c.bytes));
    cats
}

fn disk_stats() -> (u64, u64) {
    for mount in ["/System/Volumes/Data", "/"] {
        if let Some(s) = util::volume_stats(Path::new(mount)) {
            return (s.avail, s.total);
        }
    }
    (0, 0)
}

pub fn load_facts(run_dir: &Path) -> HashMap<String, i64> {
    util::read_lines(&run_dir.join("disk.tsv"))
        .iter()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            match parts.as_slice() {
                [k, v] => v.trim().parse().ok().map(|n| (k.to_string(), n)),
                _ => None,
            }
        })
        .collect()
}

fn dirname(p: &str) -> &str {
    let head = &p[..p.rfind('/').map_or(0, |i| i + 1)];
    let trimmed = head.trim_end_matches('/');
    if trimmed.is_empty() { head } else { trimmed }
}

pub fn load_map(run_dir: &Path, home: &str, used: i64) -> Option<Node> {
    let path = run_dir.join("map.tsv");
    if !path.exists() {
        return None;
    }
    let mut sizes: HashMap<String, i64> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for line in util::read_lines(&path) {
        let parts: Vec<&str> = line.split('\t').collect();
        let [size, p] = parts.as_slice() else {
            continue;
        };
        let Ok(n) = size.trim().parse::<i64>() else {
            continue;
        };
        if sizes.insert(p.to_string(), n).is_none() {
            order.push(p.to_string());
        }
    }
    let root = if sizes.contains_key("/") {
        "/".to_string()
    } else {
        home.to_string()
    };
    let root_size = *sizes.get(&root)?;
    if root == "/" && used > root_size {
        sizes.insert(root.clone(), used);
    }
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for p in &order {
        let parent = dirname(p);
        if *p != root && sizes.contains_key(parent) {
            children
                .entry(parent.to_string())
                .or_default()
                .push(p.clone());
        }
    }
    Some(build(&root, home, &sizes, &children))
}

fn build(
    p: &str,
    home: &str,
    sizes: &HashMap<String, i64>,
    children: &HashMap<String, Vec<String>>,
) -> Node {
    let name = if p == home {
        "~".to_string()
    } else if p == "/" {
        "Whole disk (apparent sizes)".to_string()
    } else {
        p.rsplit('/').next().unwrap_or("").to_string()
    };
    let bytes = sizes.get(p).copied().unwrap_or(0);
    let mut kids: Vec<&String> = children
        .get(p)
        .map(|k| k.iter().collect())
        .unwrap_or_default();
    kids.sort_by_key(|k| -sizes.get(*k).copied().unwrap_or(0));
    let mut nodes: Vec<Node> = kids
        .into_iter()
        .map(|k| build(k, home, sizes, children))
        .collect();
    let shown: i64 = nodes.iter().map(|n| n.bytes).sum();
    let rest = bytes - shown;
    if !nodes.is_empty() && rest > 0 {
        nodes.push(Node {
            name: if p == "/" {
                "unreadable or system-protected"
            } else {
                "everything else in this folder"
            }
            .to_string(),
            path: format!("{p}/*"),
            bytes: rest,
            children: Vec::new(),
            rest: true,
        });
    }
    Node {
        name,
        path: p.to_string(),
        bytes,
        children: nodes,
        rest: false,
    }
}

pub fn token() -> String {
    let mut raw = [0u8; 16];
    // SAFETY: arc4random_buf fills exactly raw.len() bytes of the local buffer.
    unsafe { libc::arc4random_buf(raw.as_mut_ptr().cast(), raw.len()) };
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in raw.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub fn render(data: &Value, token: &str) -> String {
    let json = data.to_string().replace("</", "<\\/");
    PAGE.replacen("__TOKEN__", token, 1)
        .replacen("__DATA__", &json, 1)
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.0 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

struct Finished {
    categories: Vec<Category>,
    scan_lines: Vec<String>,
}

#[derive(Default)]
struct Log {
    generation: u64,
    events: Vec<String>,
}

pub struct Live {
    dir: PathBuf,
    log: Mutex<Log>,
    changed: Condvar,
    finished: Mutex<Option<Arc<Finished>>>,
    scanning: AtomicBool,
    last_progress: Mutex<Option<Instant>>,
    cancel: Arc<AtomicBool>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Live {
    fn new(dir: &Path) -> Live {
        Live {
            dir: dir.to_path_buf(),
            log: Mutex::default(),
            changed: Condvar::new(),
            finished: Mutex::new(None),
            scanning: AtomicBool::new(true),
            last_progress: Mutex::new(None),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    fn finished(&self) -> Option<Arc<Finished>> {
        lock(&self.finished).clone()
    }

    fn restart(&self) {
        *lock(&self.finished) = None;
        *lock(&self.last_progress) = None;
        let mut log = lock(&self.log);
        log.generation += 1;
        log.events = vec![format!(
            "event: rescan\ndata: {}\n\n",
            json!({"elapsed_ms": 0})
        )];
        self.changed.notify_all();
    }
}

impl Sink for Live {
    fn emit(&self, event: &str, data: Value) {
        if event == "progress" {
            let mut last = lock(&self.last_progress);
            if last.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        if event == "done" {
            *lock(&self.finished) = Some(Arc::new(Finished {
                categories: load_scan(&self.dir),
                scan_lines: util::read_lines(&self.dir.join("scan.tsv")),
            }));
        }
        let mut log = lock(&self.log);
        log.events.push(format!("event: {event}\ndata: {data}\n\n"));
        if event == "done" || event == "error" {
            self.scanning.store(false, Ordering::SeqCst);
        }
        drop(log);
        self.changed.notify_all();
    }
}

fn stream_events(out: &mut TcpStream, live: &Live) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    if out.write_all(head.as_bytes()).is_err() {
        return;
    }
    let (mut generation, mut sent) = (0, 0);
    loop {
        let batch = {
            let log = lock(&live.log);
            let (log, _) = live
                .changed
                .wait_timeout_while(log, HEARTBEAT, |l| {
                    l.generation == generation && l.events.len() == sent
                })
                .unwrap_or_else(PoisonError::into_inner);
            if log.generation != generation {
                (generation, sent) = (log.generation, 0);
            }
            let batch = log.events[sent..].concat();
            sent = log.events.len();
            batch
        };
        let chunk = if batch.is_empty() { ":\n\n" } else { &batch };
        if out.write_all(chunk.as_bytes()).is_err() {
            return;
        }
    }
}

fn query_token(target: &str) -> &str {
    target
        .split_once('?')
        .map_or("", |(_, q)| q)
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .unwrap_or("")
}

struct Pages {
    first: String,
    live: String,
}

fn handle(
    stream: TcpStream,
    pages: &Pages,
    token: &str,
    decided: &mpsc::Sender<Value>,
    live: &Arc<Live>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok(mut write) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) if line.trim().is_empty() => break,
            Ok(_) => {
                if let Some((k, v)) = line.split_once(':')
                    && k.trim().eq_ignore_ascii_case("content-length")
                {
                    length = v.trim().parse().unwrap_or(0);
                }
            }
        }
    }
    match method {
        "GET" => {
            let route = target.split('?').next().unwrap_or("");
            if route == "/favicon.ico" {
                respond(&mut write, "204 No Content", "text/plain", b"");
            } else if route == "/" {
                let html = if lock(&live.log).generation > 0 {
                    &pages.live
                } else {
                    &pages.first
                };
                respond(
                    &mut write,
                    "200 OK",
                    "text/html; charset=utf-8",
                    html.as_bytes(),
                );
            } else if route == "/events" {
                if constant_eq(query_token(target).as_bytes(), token.as_bytes()) {
                    stream_events(&mut write, live);
                } else {
                    respond(&mut write, "403 Forbidden", "text/plain", b"forbidden");
                }
            } else {
                respond(&mut write, "404 Not Found", "text/plain", b"not found");
            }
        }
        "POST" => {
            if !["/decide", "/preview", "/rescan"].contains(&target) {
                respond(&mut write, "404 Not Found", "text/plain", b"not found");
                return;
            }
            let mut body = vec![0u8; length.min(64 << 20)];
            if reader.read_exact(&mut body).is_err() {
                respond(&mut write, "400 Bad Request", "text/plain", b"bad request");
                return;
            }
            let payload: Value = if body.is_empty() {
                json!({})
            } else {
                match serde_json::from_slice(&body) {
                    Ok(v @ Value::Object(_)) => v,
                    _ => {
                        respond(&mut write, "400 Bad Request", "text/plain", b"bad request");
                        return;
                    }
                }
            };
            let sent = match payload.get("token") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            if !constant_eq(sent.as_bytes(), token.as_bytes()) {
                respond(&mut write, "403 Forbidden", "text/plain", b"forbidden");
                return;
            }
            if target == "/rescan" {
                if live
                    .scanning
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    respond(&mut write, "409 Conflict", "text/plain", b"scan running");
                    return;
                }
                live.restart();
                start_scan(Arc::clone(live), decided.clone(), false);
                respond(&mut write, "202 Accepted", "application/json", b"{}");
                return;
            }
            let approve = payload.get("decision").and_then(Value::as_str) == Some("approve");
            let finished = live.finished();
            if finished.is_none() && (target == "/preview" || approve) {
                respond(&mut write, "409 Conflict", "text/plain", b"scan not done");
                return;
            }
            if let (Some(f), "/preview") = (&finished, target) {
                let items = payload
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let body = preview(&f.categories, &f.scan_lines, &items).to_string();
                respond(&mut write, "200 OK", "application/json", body.as_bytes());
                return;
            }
            if !approve {
                live.cancel.store(true, Ordering::Relaxed);
            }
            respond(&mut write, "200 OK", "application/json", b"{}");
            let _ = decided.send(if approve {
                payload
            } else {
                json!({"decision": "cancel"})
            });
        }
        _ => respond(
            &mut write,
            "501 Not Implemented",
            "text/plain",
            b"not implemented",
        ),
    }
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn selection(categories: &[Category], items: &[Value]) -> Option<Value> {
    let mut valid: HashMap<&str, &Item> = HashMap::new();
    for item in categories
        .iter()
        .flat_map(|c| &c.items)
        .filter(|i| !i.report)
    {
        valid.insert(&item.path, item);
    }
    let mut chosen: Vec<Value> = Vec::new();
    for item in items {
        let Some(known) = item
            .get("path")
            .and_then(Value::as_str)
            .and_then(|p| valid.get(p))
        else {
            continue;
        };
        chosen.push(json!({
            "path": known.path,
            "label": known.label,
            "bytes": known.bytes,
            "action": known.action,
            "cmd_id": known.cmd_id,
            "category": item.get("category").cloned().unwrap_or(json!("")),
        }));
    }
    if chosen.is_empty() {
        return None;
    }
    chosen.sort_by_key(|i| -i["bytes"].as_i64().unwrap_or(0));
    let total: i64 = chosen
        .iter()
        .map(|i| i["bytes"].as_i64().unwrap_or(0))
        .sum();
    Some(json!({"items": chosen, "total_bytes": total}))
}

pub fn preview(categories: &[Category], scan_lines: &[String], items: &[Value]) -> Value {
    let chosen = selection(categories, items)
        .and_then(|s| s.get("items").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let plan = clean::plan(scan_lines, &chosen);
    let rejected: Vec<Value> = plan
        .rejected
        .iter()
        .map(|(reason, path)| json!({"reason": reason, "path": path}))
        .collect();
    json!({
        "commands": plan.commands(),
        "rejected": rejected,
        "count": plan.count(),
        "bytes": plan.bytes,
    })
}

fn reclaimable(categories: &[Category]) -> i64 {
    categories
        .iter()
        .filter(|c| c.risk != "report")
        .flat_map(|c| &c.items)
        .filter(|i| i.accuracy == "exact")
        .map(|i| i.bytes)
        .sum()
}

fn finished_run(dir: &Path) -> Option<(Value, Live)> {
    let categories = load_scan(dir);
    if categories.is_empty() {
        return None;
    }
    let (free, total) = disk_stats();
    let (free, total) = (free as i64, total as i64);
    let facts = load_facts(dir);
    let fact = |k: &str| facts.get(k).copied().filter(|v| *v != 0);
    let home = util::home();
    let used = fact("used").unwrap_or((total - free).max(0));
    let tree = load_map(dir, &home, used);
    let insights: Value = std::fs::read(dir.join("insights.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let reclaimable = reclaimable(&categories);
    let live = Live::new(dir);
    let at_zero = |mut data: Value| {
        data["elapsed_ms"] = json!(0);
        data
    };
    let snapshots = fact("snapshots").unwrap_or(0);
    let home_bytes = fact("home").unwrap_or(0);
    live.emit(
        "disk",
        at_zero(json!({"total": fact("total").unwrap_or(total), "used": used, "free": free, "snapshots": snapshots})),
    );
    for c in &categories {
        let category = json!({"id": c.id, "title": c.title, "desc": c.desc, "risk": c.risk});
        for item in &c.items {
            live.emit("item", at_zero(json!({"category": category, "item": item})));
        }
    }
    live.emit(
        "walked",
        at_zero(json!({"home": home_bytes, "tree": tree, "insights": insights, "worktrees": 0})),
    );
    live.emit("done", at_zero(json!({"reclaimable": reclaimable})));
    let data = json!({
        "categories": categories,
        "reclaimable": reclaimable,
        "free": free,
        "total": fact("total").unwrap_or(total),
        "used": used,
        "home": home_bytes,
        "snapshots": snapshots,
        "tree": tree,
        "insights": insights,
    });
    Some((data, live))
}

fn serve(data: &Value, live: Arc<Live>, tx: mpsc::Sender<Value>) -> io::Result<()> {
    let token = token();
    let pages = Arc::new(Pages {
        first: render(data, &token),
        live: render(&json!({"live": true}), &token),
    });
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let url = format!("http://127.0.0.1:{}/", listener.local_addr()?.port());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (pages, token, tx, live) = (
                Arc::clone(&pages),
                token.clone(),
                tx.clone(),
                Arc::clone(&live),
            );
            std::thread::spawn(move || handle(stream, &pages, &token, &tx, &live));
        }
    });
    eprintln!("review UI: {url}");
    if std::env::var("DISK_CLEAN_NO_BROWSER").is_ok_and(|v| v == "1") {
        eprintln!("DISK_CLEAN_NO_BROWSER=1, not opening a browser");
    } else {
        let _ = std::process::Command::new("open").arg(&url).status();
    }
    Ok(())
}

fn decide(rx: &mpsc::Receiver<Value>, live: &Live) -> io::Result<(i32, Option<PathBuf>)> {
    let Ok(payload) = rx.recv_timeout(TIMEOUT) else {
        eprintln!("timed out waiting for approval");
        return Ok((4, None));
    };
    match payload.get("decision").and_then(Value::as_str) {
        Some("approve") => {}
        Some(NOTHING_FOUND) => {
            eprintln!("nothing to clean");
            return Ok((3, None));
        }
        _ => {
            eprintln!("cancelled in the UI");
            return Ok((5, None));
        }
    }
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(selection) = live
        .finished()
        .and_then(|f| selection(&f.categories, &items))
    else {
        eprintln!("no deletable items were selected");
        return Ok((5, None));
    };
    let out = live.dir.join("selection.json");
    std::fs::write(
        &out,
        serde_json::to_string_pretty(&selection).map_err(io::Error::other)?,
    )?;
    Ok((0, Some(out)))
}

fn start_scan(live: Arc<Live>, tx: mpsc::Sender<Value>, first: bool) {
    std::thread::spawn(move || {
        let started = Instant::now();
        match scan::scan(&live.dir, &*live, Arc::clone(&live.cancel)) {
            Ok(()) => {
                if first && live.finished().is_some_and(|f| f.categories.is_empty()) {
                    let _ = tx.send(json!({"decision": NOTHING_FOUND}));
                }
            }
            Err(e) if e.kind() != io::ErrorKind::Interrupted => {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                live.emit(
                    "error",
                    json!({"message": e.to_string(), "elapsed_ms": elapsed_ms}),
                );
            }
            Err(_) => {}
        }
    });
}

fn live_scan() -> io::Result<i32> {
    let dir = scan::new_run_dir(None)?;
    let live = Arc::new(Live::new(&dir));
    let (tx, rx) = mpsc::channel();
    serve(&json!({"live": true}), Arc::clone(&live), tx.clone())?;
    start_scan(Arc::clone(&live), tx, true);
    let (code, selection) = decide(&rx, &live)?;
    println!("{}", dir.display());
    if let Some(path) = selection {
        println!("{}", path.display());
    }
    Ok(code)
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let Some(dir) = run_dir else {
        return live_scan();
    };
    let Some((data, live)) = finished_run(Path::new(&dir)) else {
        eprintln!("nothing to clean");
        return Ok(3);
    };
    let live = Arc::new(live);
    let (tx, rx) = mpsc::channel();
    serve(&data, Arc::clone(&live), tx)?;
    let (code, selection) = decide(&rx, &live)?;
    if let Some(path) = selection {
        println!("{}", path.display());
    }
    Ok(code)
}
