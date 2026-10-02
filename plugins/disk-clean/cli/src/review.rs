use crate::clean;
use crate::util;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, mpsc};
use std::time::Duration;

const PAGE: &str = include_str!("../assets/page.html");
const TIMEOUT: Duration = Duration::from_secs(1800);

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

pub fn load_scan(run_dir: &Path) -> Vec<Category> {
    let mut cats: Vec<Category> = Vec::new();
    for line in util::read_lines(&run_dir.join("scan.tsv")) {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 13 {
            continue;
        }
        let Ok(bytes) = f[9].trim().parse::<i64>() else {
            continue;
        };
        let item = Item {
            path: f[8].to_string(),
            label: f[7].to_string(),
            bytes,
            action: f[5].to_string(),
            cmd_id: f[6].to_string(),
            note: f[10].to_string(),
            age: if !f[11].is_empty() && f[11].bytes().all(|b| b.is_ascii_digit()) {
                f[11].parse().ok()
            } else {
                None
            },
            accuracy: if f[12].is_empty() {
                "exact".to_string()
            } else {
                f[12].to_string()
            },
            preselect: f[4] == "1" && f[3] != "report",
            report: f[3] == "report",
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

fn handle(
    stream: TcpStream,
    html: &str,
    token: &str,
    done: &mpsc::Sender<Value>,
    preview: &dyn Fn(&[Value]) -> Value,
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
                respond(
                    &mut write,
                    "200 OK",
                    "text/html; charset=utf-8",
                    html.as_bytes(),
                );
            } else {
                respond(&mut write, "404 Not Found", "text/plain", b"not found");
            }
        }
        "POST" => {
            if target != "/decide" && target != "/preview" {
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
            if target == "/preview" {
                let items = payload
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let body = preview(&items).to_string();
                respond(&mut write, "200 OK", "application/json", body.as_bytes());
                return;
            }
            respond(&mut write, "200 OK", "application/json", b"{}");
            let _ = done.send(payload);
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

pub fn run(run_dir: &str) -> io::Result<i32> {
    let dir = Path::new(run_dir);
    let categories = load_scan(dir);
    if categories.is_empty() {
        eprintln!("nothing to clean");
        return Ok(3);
    }
    let (free, total) = disk_stats();
    let (free, total) = (free as i64, total as i64);
    let facts = load_facts(dir);
    let fact = |k: &str| facts.get(k).copied().filter(|v| *v != 0);
    let home = util::home();
    let used = fact("used").unwrap_or((total - free).max(0));
    let tree = load_map(dir, &home, used);
    let reclaimable: i64 = categories
        .iter()
        .filter(|c| c.risk != "report")
        .flat_map(|c| &c.items)
        .filter(|i| i.accuracy == "exact")
        .map(|i| i.bytes)
        .sum();
    let data = json!({
        "categories": categories,
        "reclaimable": reclaimable,
        "free": free,
        "total": fact("total").unwrap_or(total),
        "used": used,
        "home": fact("home").unwrap_or(0),
        "snapshots": fact("snapshots").unwrap_or(0),
        "tree": tree,
    });
    let token = token();
    let html = render(&data, &token);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let url = format!("http://127.0.0.1:{}/", listener.local_addr()?.port());
    let (tx, rx) = mpsc::channel::<Value>();
    let categories = Arc::new(categories);
    let scan_lines = Arc::new(util::read_lines(&dir.join("scan.tsv")));
    let shared = Arc::clone(&categories);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (html, token, tx) = (html.clone(), token.clone(), tx.clone());
            let (categories, scan_lines) = (Arc::clone(&shared), Arc::clone(&scan_lines));
            std::thread::spawn(move || {
                handle(stream, &html, &token, &tx, &|items| {
                    preview(&categories, &scan_lines, items)
                })
            });
        }
    });

    eprintln!("review UI: {url}");
    if std::env::var("DISK_CLEAN_NO_BROWSER").is_ok_and(|v| v == "1") {
        eprintln!("DISK_CLEAN_NO_BROWSER=1, not opening a browser");
    } else {
        let _ = std::process::Command::new("open").arg(&url).status();
    }

    let Ok(payload) = rx.recv_timeout(TIMEOUT) else {
        eprintln!("timed out waiting for approval");
        return Ok(4);
    };
    if payload.get("decision").and_then(Value::as_str) != Some("approve") {
        eprintln!("cancelled in the UI");
        return Ok(5);
    }
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(selection) = selection(&categories, &items) else {
        eprintln!("no deletable items were selected");
        return Ok(5);
    };
    let out = dir.join("selection.json");
    std::fs::write(
        &out,
        serde_json::to_string_pretty(&selection).map_err(io::Error::other)?,
    )?;
    println!("{}", out.display());
    Ok(0)
}
