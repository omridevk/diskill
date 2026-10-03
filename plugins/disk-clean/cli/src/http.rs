use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub const HEAD_MAX: usize = 16 * 1024;
pub const BODY_MAX: usize = 1 << 20;
pub const REQUEST_TIME: Duration = Duration::from_secs(10);
pub const CONNECTIONS: usize = 64;

const TOO_LARGE_HEAD: &str = "431 Request Header Fields Too Large";
const TOO_LARGE_BODY: &str = "413 Content Too Large";
const TOO_SLOW: &str = "408 Request Timeout";
const BAD: &str = "400 Bad Request";

pub struct Request {
    pub method: String,
    pub target: String,
    pub host: String,
    pub origin: Option<String>,
    pub json: bool,
    pub body: Vec<u8>,
}

pub fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.0 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

pub fn refuse(stream: &mut TcpStream, status: &str) {
    let text = status.split_once(' ').map_or(status, |(_, t)| t);
    respond(stream, status, "text/plain", text.to_lowercase().as_bytes());
}

fn read_more(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), Option<&'static str>> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(Some(TOO_SLOW));
    }
    let _ = stream.set_read_timeout(Some(left));
    let mut chunk = [0u8; 4096];
    match stream.read(&mut chunk) {
        Ok(0) => Err(None),
        Ok(n) => {
            buf.extend_from_slice(&chunk[..n]);
            Ok(())
        }
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) =>
        {
            Err(Some(TOO_SLOW))
        }
        Err(_) => Err(None),
    }
}

fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn is_json(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
}

pub fn read_request(stream: &mut TcpStream) -> Result<Request, Option<&'static str>> {
    let deadline = Instant::now() + REQUEST_TIME;
    let mut buf = Vec::new();
    let end = loop {
        if let Some(end) = head_end(&buf) {
            break end;
        }
        if buf.len() > HEAD_MAX {
            return Err(Some(TOO_LARGE_HEAD));
        }
        read_more(stream, &mut buf, deadline)?;
    };
    if end > HEAD_MAX {
        return Err(Some(TOO_LARGE_HEAD));
    }
    let head = std::str::from_utf8(&buf[..end]).map_err(|_| Some(BAD))?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("").to_string();
    let (mut hosts, mut origin, mut json, mut length) = (Vec::new(), None, false, 0usize);
    for (name, value) in lines.filter_map(|l| l.split_once(':')) {
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
        match name.as_str() {
            "host" => hosts.push(value.to_string()),
            "origin" => origin = Some(value.to_string()),
            "content-type" => json = is_json(value),
            "content-length" => length = value.parse().map_err(|_| Some(BAD))?,
            _ => {}
        }
    }
    let [host] = hosts.as_slice() else {
        return Err(Some(BAD));
    };
    if length > BODY_MAX {
        return Err(Some(TOO_LARGE_BODY));
    }
    while buf.len() < end + length {
        read_more(stream, &mut buf, deadline)?;
    }
    let _ = stream.set_read_timeout(None);
    Ok(Request {
        method,
        target,
        host: host.clone(),
        origin,
        json,
        body: buf[end..end + length].to_vec(),
    })
}

pub fn is_local_host(req: &Request, port: u16) -> bool {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")]
        .iter()
        .any(|allowed| req.host.eq_ignore_ascii_case(allowed))
}

pub fn is_trusted_post(req: &Request) -> bool {
    let own_origin = format!("http://{}", req.host);
    req.json
        && req
            .origin
            .as_deref()
            .is_none_or(|o| o.eq_ignore_ascii_case(&own_origin))
}

pub fn is_own_origin_post(req: &Request, port: u16) -> bool {
    is_local_host(req, port)
        && req.json
        && req
            .origin
            .as_deref()
            .is_some_and(|o| o.eq_ignore_ascii_case(&format!("http://{}", req.host)))
}

pub fn client_gone(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return true;
    }
    let gone = match stream.peek(&mut [0u8; 1]) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != io::ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    gone
}

fn turn_away(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let _ = stream.read(&mut [0u8; HEAD_MAX]);
    refuse(&mut stream, "503 Service Unavailable");
}

pub fn serve(listener: TcpListener, handle: impl Fn(TcpStream) + Send + Sync + 'static) {
    let handle = Arc::new(handle);
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        if open.load(Ordering::SeqCst) >= CONNECTIONS {
            turn_away(stream);
            continue;
        }
        open.fetch_add(1, Ordering::SeqCst);
        let (handle, open) = (Arc::clone(&handle), Arc::clone(&open));
        std::thread::spawn(move || {
            handle(stream);
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub const POST_ROUTES: [&str; 5] = ["/decide", "/preview", "/rescan", "/undo", "/free"];

pub fn is_page_route(route: &str) -> bool {
    route.starts_with('/') && route != "/events" && !POST_ROUTES.contains(&route)
}

pub fn query_token(target: &str) -> &str {
    target
        .split_once('?')
        .map_or("", |(_, q)| q)
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .unwrap_or("")
}
