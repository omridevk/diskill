mod common;

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const TOKEN: &str = "tok-123";

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn watch(run: &Path, port: u16, env: &[(&str, &str)]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["watch", &run.to_string_lossy()])
        .env("DISK_CLEAN_WATCH_TOKEN", TOKEN)
        .env("DISK_CLEAN_WATCH_PORT", port.to_string())
        .envs(env.iter().copied())
        .spawn()
        .unwrap()
}

fn connect(port: u16) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => return s,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("watcher never listened: {e}"),
        }
    }
}

fn request(port: u16, raw: &str) -> u16 {
    let mut s = connect(port);
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn host(port: u16) -> String {
    format!("Host: 127.0.0.1:{port}\r\n")
}

fn open_events(port: u16) -> BufReader<TcpStream> {
    let mut s = connect(port);
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        s,
        "GET /events?token={TOKEN} HTTP/1.1\r\n{}\r\n",
        host(port)
    )
    .unwrap();
    let mut reader = BufReader::new(s);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("HTTP/1.1 200"), "{line}");
    reader
}

fn read_until(reader: &mut BufReader<TcpStream>, until: &str) -> Vec<String> {
    let mut names = Vec::new();
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0, "stream ended");
        if let Some(name) = line.trim_end().strip_prefix("event: ") {
            names.push(name.to_string());
            if name == until {
                return names;
            }
        }
    }
}

fn append(run: &Path, lines: &[&str]) {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(run.join("clean.events"))
        .unwrap();
    for line in lines {
        writeln!(f, "{line}").unwrap();
    }
}

fn exits_within(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

#[test]
fn watch_replays_and_tails_the_worker_events_read_only() {
    let t = common::temp_dir("watch");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let port = free_port();
    let mut child = watch(&run, port, &[("DISK_CLEAN_WATCH_IDLE", "0.5")]);

    let mut first = open_events(port);
    assert_eq!(read_until(&mut first, "waiting"), ["waiting"]);
    assert_eq!(
        request(
            port,
            &format!("GET /events?token=wrong HTTP/1.1\r\n{}\r\n", host(port))
        ),
        403
    );
    assert_eq!(
        request(
            port,
            &format!(
                "POST /events?token={TOKEN} HTTP/1.1\r\n{}Content-Length: 0\r\n\r\n",
                host(port)
            )
        ),
        405
    );
    assert_eq!(
        request(
            port,
            &format!(
                "POST /decide HTTP/1.1\r\n{}Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}",
                host(port)
            )
        ),
        405
    );
    assert_eq!(
        request(port, &format!("GET / HTTP/1.1\r\n{}\r\n", host(port))),
        404
    );

    append(
        &run,
        &[
            r#"{"event":"started","free":1,"paths":2,"worktrees":0,"commands":0,"bytes":8,"elapsed_ms":0}"#,
            r#"{"event":"removed","path":"/x/a","bytes":4,"secs":0.1,"elapsed_ms":5}"#,
        ],
    );
    assert_eq!(read_until(&mut first, "removed"), ["started", "removed"]);
    let mut f = OpenOptions::new()
        .append(true)
        .open(run.join("clean.events"))
        .unwrap();
    write!(f, r#"{{"event":"failed","path":"/x/b","bytes":4,"#).unwrap();
    f.flush().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    writeln!(
        f,
        r#""reason":"still present after removal","elapsed_ms":9}}"#
    )
    .unwrap();
    append(
        &run,
        &[r#"{"event":"done","free_before":1,"free_after":9,"reclaimed":8,"elapsed_ms":12}"#],
    );
    assert_eq!(read_until(&mut first, "done"), ["failed", "done"]);

    let mut second = open_events(port);
    assert_eq!(
        read_until(&mut second, "done"),
        ["started", "removed", "failed", "done"],
        "a new connection replays the file without waiting"
    );
    fs::write(run.join("status"), "done\n").unwrap();
    std::thread::sleep(Duration::from_secs(1));
    assert!(
        child.try_wait().unwrap().is_none(),
        "stays up while a page is connected"
    );
    drop(first);
    drop(second);
    assert!(
        exits_within(&mut child, Duration::from_secs(5)),
        "exits once done and no page is left"
    );
    assert!(run.join("clean.events").exists());
}

#[test]
fn watch_gives_up_when_clean_never_starts_or_runs_too_long() {
    let t = common::temp_dir("watch-limits");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let port = free_port();
    let mut never = watch(&run, port, &[("DISK_CLEAN_WATCH_START", "0.5")]);
    let mut stream = open_events(port);
    assert_eq!(
        read_until(&mut stream, "abandoned"),
        ["waiting", "abandoned"]
    );
    assert!(exits_within(&mut never, Duration::from_secs(5)));
    assert_eq!(
        fs::read_to_string(run.join("status")).unwrap(),
        "abandoned\n"
    );
    fs::remove_file(run.join("status")).unwrap();
    fs::remove_file(run.join("clean.events")).unwrap();

    append(&run, &[r#"{"event":"started","elapsed_ms":0}"#]);
    let port = free_port();
    let mut long = watch(
        &run,
        port,
        &[
            ("DISK_CLEAN_WATCH_START", "0.1"),
            ("DISK_CLEAN_WATCH_MAX", "1"),
        ],
    );
    let mut connected = open_events(port);
    assert_eq!(read_until(&mut connected, "started"), ["started"]);
    assert!(exits_within(&mut long, Duration::from_secs(5)));
}

#[test]
fn watch_needs_its_token_and_port() {
    let out = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["watch", "/nonexistent"])
        .env_remove("DISK_CLEAN_WATCH_TOKEN")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn watch_serves_the_approved_page_for_a_reload() {
    let t = common::temp_dir("watch-page");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let rows = [
        "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/a\t/h/Library/Caches/a\t2048\tnote\t3\texact",
        "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/b\t/h/Library/Caches/b\t4096\tnote\t-\texact",
    ];
    fs::write(run.join("scan.tsv"), rows.join("\n") + "\n").unwrap();
    fs::write(
        run.join("selection.json"),
        r#"{"items":[{"path":"/h/Library/Caches/b","bytes":4096}],"total_bytes":4096}"#,
    )
    .unwrap();
    let port = free_port();
    let mut child = watch(&run, port, &[("DISK_CLEAN_WATCH_START", "5")]);

    let mut s = connect(port);
    write!(s, "GET / HTTP/1.1\r\n{}\r\n", host(port)).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.0 200"), "{out}");
    let (_, rest) = out
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .expect("data script");
    let (json, _) = rest.split_once("</script>").expect("script end");
    let data: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(data["approved"], true);
    assert_eq!(
        data["selection"],
        serde_json::json!(["/h/Library/Caches/b"])
    );
    assert_eq!(data["categories"][0]["items"].as_array().unwrap().len(), 2);
    assert!(out.contains(&format!(
        r#"<meta name="disk-clean-token" content="{TOKEN}""#
    )));

    fs::remove_file(run.join("selection.json")).unwrap();
    assert_eq!(
        request(port, &format!("GET / HTTP/1.1\r\n{}\r\n", host(port))),
        404
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn watch_refuses_a_foreign_host() {
    let t = common::temp_dir("watch-host");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("selection.json"), r#"{"items":[]}"#).unwrap();
    let port = free_port();
    let mut child = watch(&run, port, &[]);
    connect(port);
    for target in ["/".to_string(), format!("/events?token={TOKEN}")] {
        for host in [format!("evil.example:{port}"), "evil.example".to_string()] {
            assert_eq!(
                request(
                    port,
                    &format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n")
                ),
                403,
                "{target} with Host {host}"
            );
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn watch_notices_a_closed_page_within_a_second() {
    let t = common::temp_dir("watch-closed");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let port = free_port();
    let mut child = watch(&run, port, &[("DISK_CLEAN_WATCH_IDLE", "0.3")]);
    let mut stream = open_events(port);
    assert_eq!(read_until(&mut stream, "waiting"), ["waiting"]);
    fs::write(run.join("status"), "done\n").unwrap();
    std::thread::sleep(Duration::from_millis(700));
    assert!(child.try_wait().unwrap().is_none(), "a page is still open");
    drop(stream);
    assert!(
        exits_within(&mut child, Duration::from_millis(1200)),
        "the closed stream was not noticed"
    );
}

#[test]
fn watch_follows_a_fresh_event_file_for_a_new_run() {
    let t = common::temp_dir("watch-rerun");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    append(
        &run,
        &[
            r#"{"event":"started","run":"one","free":1,"paths":9,"worktrees":0,"commands":0,"bytes":8,"elapsed_ms":0}"#,
            r#"{"event":"removed","path":"/x/a-long-path-from-the-first-run","bytes":4,"secs":0.1,"elapsed_ms":5}"#,
            r#"{"event":"removed","path":"/x/another-long-path-from-the-first-run","bytes":4,"secs":0.1,"elapsed_ms":6}"#,
        ],
    );
    let port = free_port();
    let mut child = watch(&run, port, &[]);
    let mut stream = open_events(port);
    assert_eq!(read_until(&mut stream, "removed"), ["started", "removed"]);
    read_until(&mut stream, "removed");
    fs::remove_file(run.join("clean.events")).unwrap();
    append(
        &run,
        &[
            r#"{"event":"started","run":"two","free":1,"paths":1,"worktrees":0,"commands":0,"bytes":1,"elapsed_ms":0}"#,
        ],
    );
    let mut line = String::new();
    let data = loop {
        line.clear();
        assert!(stream.read_line(&mut line).unwrap() > 0);
        match line.trim_end().strip_prefix("data: ") {
            Some(d) if d.contains(r#""event":"started""#) => break d.to_string(),
            _ => continue,
        }
    };
    assert!(data.contains(r#""run":"two""#), "{data}");
    let _ = child.kill();
    let _ = child.wait();
}
