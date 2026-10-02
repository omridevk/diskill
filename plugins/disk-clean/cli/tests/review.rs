mod common;

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Command, Stdio};

fn request(port: u16, raw: String) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

fn post(port: u16, body: &str) -> u16 {
    let raw = format!(
        "POST /decide HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    request(port, raw).0
}

#[test]
fn review_serves_page_and_writes_selection() {
    let t = common::temp_dir("review");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let rows = [
        "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/a\t/h/Library/Caches/a\t2048\tnote\t3\texact",
        "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/b\t/h/Library/Caches/b\t4096\tnote\t-\texact",
        "big-files\tLarge files (report only)\tdesc\treport\t0\trm\t-\t~/big.iso\t/h/big.iso\t9999999\tReview manually.\t10\texact",
        "docker\tDocker\tdesc\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t1000\tnote\t-\tvm",
    ];
    fs::write(run.join("scan.tsv"), rows.join("\n") + "\n").unwrap();
    fs::write(run.join("map.tsv"), "500\t/h/Library\n1000\t/h\n").unwrap();
    fs::write(
        run.join("disk.tsv"),
        "total\t100000\nused\t60000\nfree\t40000\nhome\t1000\nsnapshots\t0\n",
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["review", &run.to_string_lossy()])
        .env("DISK_CLEAN_NO_BROWSER", "1")
        .env("HOME", "/h")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let url = line
        .trim()
        .strip_prefix("review UI: ")
        .expect("url line")
        .to_string();
    let port: u16 = url
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();

    let (status, page) = request(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n".to_string());
    assert_eq!(status, 200);
    assert!(!page.contains("__DATA__") && !page.contains("__TOKEN__"));
    let json = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .expect("data script");
    let data: Value = serde_json::from_str(json).unwrap();
    assert_eq!(data["categories"][0]["id"], "caches");
    assert_eq!(data["categories"][0]["bytes"], 6144);
    assert_eq!(
        data["categories"][0]["items"][0]["path"],
        "/h/Library/Caches/b"
    );
    assert_eq!(data["categories"][0]["items"][0]["age"], Value::Null);
    assert_eq!(
        data["categories"].as_array().unwrap().last().unwrap()["id"],
        "big-files"
    );
    assert_eq!(data["reclaimable"], 6144);
    assert_eq!(data["total"], 100000);
    assert_eq!(data["tree"]["name"], "~");
    assert_eq!(data["tree"]["children"][1]["rest"], true);
    assert_eq!(data["insights"], Value::Null);
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    assert_eq!(token.len(), 22);

    assert_eq!(
        request(port, "GET /favicon.ico HTTP/1.1\r\n\r\n".to_string()).0,
        204
    );
    assert_eq!(
        request(port, "GET /nope HTTP/1.1\r\n\r\n".to_string()).0,
        404
    );
    assert_eq!(
        post(
            port,
            r#"{"token": "wrong", "decision": "approve", "items": []}"#
        ),
        403
    );
    assert_eq!(post(port, "not json"), 400);

    let raw_preview = |body: String| {
        format!(
            "POST /preview HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    };
    assert_eq!(
        request(
            port,
            raw_preview(r#"{"token": "wrong", "items": []}"#.to_string())
        )
        .0,
        403
    );
    let (status, body) = request(
        port,
        raw_preview(format!(
            r#"{{"token": "{token}", "items": [
                {{"path": "/h/Library/Caches/a"}},
                {{"path": "/h/big.iso"}},
                {{"path": "cmd:docker-prune"}}
            ]}}"#
        )),
    );
    assert_eq!(status, 200);
    let plan: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        plan["commands"],
        serde_json::json!(["docker system prune -f"])
    );
    assert_eq!(plan["rejected"][0]["path"], "/h/Library/Caches/a");
    assert_eq!(plan["rejected"][0]["reason"], "already gone");
    assert_eq!(plan["count"], 1);
    assert!(!run.join("selection.json").exists());

    let approve = format!(
        r#"{{"token": "{token}", "decision": "approve", "items": [
            {{"path": "/h/Library/Caches/a", "category": "caches"}},
            {{"path": "/h/big.iso", "category": "big-files"}},
            {{"path": "/etc/passwd", "category": "caches"}},
            {{"path": "cmd:docker-prune", "category": "docker"}}
        ]}}"#
    );
    assert_eq!(post(port, &approve), 200);
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    assert_eq!(stdout.trim(), run.join("selection.json").to_string_lossy());

    let sel: Value =
        serde_json::from_str(&fs::read_to_string(run.join("selection.json")).unwrap()).unwrap();
    let paths: Vec<&str> = sel["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["/h/Library/Caches/a", "cmd:docker-prune"]);
    assert_eq!(sel["items"][1]["cmd_id"], "docker-prune");
    assert_eq!(sel["items"][1]["action"], "cmd");
    assert_eq!(sel["total_bytes"], 3048);
}

#[test]
fn review_exits_3_when_nothing_found() {
    let t = common::temp_dir("review-cancel");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("scan.tsv"), "").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["review", &run.to_string_lossy()])
        .env("DISK_CLEAN_NO_BROWSER", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn render_keeps_hostile_paths_inside_the_data_script() {
    let data =
        serde_json::json!({"path": "/tmp/</script><script>alert(1)</script>", "also": "__TOKEN__"});
    let page = clean_disk_render(&data);
    let (_, rest) = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .expect("data script");
    let (json, _) = rest.split_once("</script>").expect("script end");
    let parsed: Value = serde_json::from_str(json).unwrap();
    assert_eq!(parsed, data);
    assert!(page.contains(r#"<meta name="disk-clean-token" content="tok""#));
}

fn clean_disk_render(data: &Value) -> String {
    disk_clean::review::render(data, "tok")
}

fn events(port: u16, token: &str, until: &str) -> Vec<(String, Value)> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "GET /events?token={token} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
    let mut reader = BufReader::new(s);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("HTTP/1.1 200"), "{line}");
    let mut out = Vec::new();
    let mut name = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0, "stream ended");
        let line = line.trim_end();
        if let Some(n) = line.strip_prefix("event: ") {
            name = n.to_string();
        } else if let Some(d) = line.strip_prefix("data: ") {
            out.push((name.clone(), serde_json::from_str(d).unwrap()));
            if name == until {
                return out;
            }
        }
    }
}

fn post_to(port: u16, route: &str, body: &str) -> u16 {
    let raw = format!(
        "POST {route} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    request(port, raw).0
}

#[test]
fn review_without_run_dir_streams_the_scan() {
    let t = common::temp_dir("live");
    let home = t.0.join("home");
    let bin = t.0.join("bin");
    let gate = t.0.join("gate");
    fs::create_dir_all(home.join("Library/Caches/app")).unwrap();
    fs::write(home.join("Library/Caches/app/blob"), vec![7u8; 64 * 1024]).unwrap();
    fs::create_dir_all(home.join("code")).unwrap();
    common::sh(
        &home.join("code"),
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q -b wt ../wt main",
    );
    fs::create_dir_all(&bin).unwrap();
    let docker = bin.join("docker");
    fs::write(
        &docker,
        format!(
            "#!/bin/sh\nwhile [ ! -e '{}' ]; do sleep 0.05; done\nexit 1\n",
            gate.display()
        ),
    )
    .unwrap();
    Command::new("chmod")
        .arg("+x")
        .arg(&docker)
        .status()
        .unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());

    let mut child = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .arg("review")
        .env("HOME", &home)
        .env("PATH", path)
        .env("DISK_CLEAN_SKIP_MAP", "1")
        .env("DISK_CLEAN_NO_BROWSER", "1")
        .env("DISK_CLEAN_MIN_BYTES", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let url = loop {
        let mut line = String::new();
        assert!(stderr.read_line(&mut line).unwrap() > 0, "no url line");
        if let Some(url) = line.trim().strip_prefix("review UI: ") {
            break url.to_string();
        }
    };
    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    let port: u16 = url
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();

    let (status, page) = request(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n".to_string());
    assert_eq!(status, 200);
    let json = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .expect("data script");
    assert_eq!(
        serde_json::from_str::<Value>(json).unwrap(),
        serde_json::json!({"live": true})
    );
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    assert_eq!(
        request(
            port,
            "GET /events?token=wrong HTTP/1.1\r\nHost: x\r\n\r\n".to_string()
        )
        .0,
        403
    );

    let mut first = events(port, &token, "walked");
    assert_eq!(
        post_to(
            port,
            "/preview",
            &format!(r#"{{"token": "{token}", "items": []}}"#)
        ),
        409
    );
    assert_eq!(
        post_to(
            port,
            "/decide",
            &format!(r#"{{"token": "{token}", "decision": "approve", "items": []}}"#)
        ),
        409
    );
    fs::write(&gate, "").unwrap();
    let rest = events(port, &token, "done");
    let replay_of_first = rest[..first.len()].to_vec();
    assert_eq!(
        replay_of_first, first,
        "a new connection replays from the start"
    );
    first = rest;

    let names: Vec<&str> = first.iter().map(|(n, _)| n.as_str()).collect();
    let walked = names.iter().position(|n| *n == "walked").unwrap();
    assert_eq!(names[0], "disk");
    assert_eq!(names.last(), Some(&"done"));
    assert_eq!(names.iter().filter(|n| **n == "walked").count(), 1);
    let before: Vec<&str> = names[1..walked]
        .iter()
        .copied()
        .skip_while(|n| *n == "progress")
        .collect();
    assert!(
        !before.is_empty() && before.iter().all(|n| *n == "item"),
        "{names:?}"
    );
    assert!(
        names[walked + 1..names.len() - 1]
            .iter()
            .all(|n| *n == "item")
    );
    let mut last = 0;
    for (name, data) in &first {
        let ms = data["elapsed_ms"]
            .as_u64()
            .unwrap_or_else(|| panic!("{name} lacks elapsed_ms"));
        assert!(ms >= last, "{name} went back in time");
        last = ms;
    }
    assert_eq!(first[walked].1["worktrees"], 1);
    let item = |path: &Path| {
        first
            .iter()
            .position(|(n, d)| n == "item" && d["item"]["path"] == path.to_str().unwrap())
            .unwrap_or_else(|| panic!("no item for {}", path.display()))
    };
    let cache = home.join("Library/Caches/app");
    assert!(item(&cache) < walked);
    assert!(item(&home.join("code/wt")) > walked);
    assert_eq!(first[item(&cache)].1["category"]["id"], "caches");
    assert_eq!(first[item(&cache)].1["item"]["preselect"], true);

    let second = events(port, &token, "done");
    assert_eq!(second, first, "a reconnect replays every event");

    assert_eq!(
        post_to(
            port,
            "/preview",
            &format!(r#"{{"token": "{token}", "items": []}}"#)
        ),
        200
    );
    let approve = format!(
        r#"{{"token": "{token}", "decision": "approve", "items": [{{"path": "{}", "category": "caches"}}]}}"#,
        cache.display()
    );
    assert_eq!(post_to(port, "/decide", &approve), 200);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    let run = Path::new(lines[0]);
    assert!(run.starts_with(home.join(".cache/disk-clean")), "{stdout}");
    assert!(run.join("scan.tsv").is_file() && run.join("disk.tsv").is_file());
    assert_eq!(Path::new(lines[1]), run.join("selection.json"));
    let sel = fs::read_to_string(run.join("selection.json")).unwrap();
    assert!(sel.contains(cache.to_str().unwrap()));
}
