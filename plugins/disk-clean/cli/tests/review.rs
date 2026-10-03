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

fn get(port: u16, target: &str) -> (u16, String) {
    request(
        port,
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    )
}

fn post(port: u16, body: &str) -> u16 {
    post_to(port, "/decide", body)
}

#[test]
fn review_serves_page_and_writes_selection() {
    let t = common::temp_dir("review");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let home = t.0.join("h");
    fs::create_dir_all(&home).unwrap();
    let h = home.to_string_lossy().into_owned();
    let rows = [
        format!(
            "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/a\t{h}/Library/Caches/a\t2048\tnote\t3\texact"
        ),
        format!(
            "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/b\t{h}/Library/Caches/b\t4096\tnote\t-\texact"
        ),
        format!(
            "big-files\tLarge files (report only)\tdesc\treport\t0\trm\t-\t~/big.iso\t{h}/big.iso\t9999999\tReview manually.\t10\texact"
        ),
        "docker\tDocker\tdesc\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t1000\tnote\t-\tvm"
            .to_string(),
    ];
    fs::write(run.join("scan.tsv"), rows.join("\n") + "\n").unwrap();
    fs::write(
        run.join("map.tsv"),
        format!("500\t{h}/Library\n1000\t7\t1700000000\t{h}\n"),
    )
    .unwrap();
    fs::write(
        run.join("disk.tsv"),
        "total\t100000\nused\t60000\nfree\t40000\nhome\t1000\nsnapshots\t0\n",
    )
    .unwrap();
    fs::write(
        run.join("clean.events"),
        r#"{"event":"started","run":"old","free":1,"paths":1,"worktrees":0,"commands":0,"bytes":1,"elapsed_ms":0}"#,
    )
    .unwrap();
    fs::write(run.join("status"), "done\n").unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["review", &run.to_string_lossy()])
        .env("DISK_CLEAN_NO_BROWSER", "1")
        .env("DISK_CLEAN_WATCH_START", "3")
        .env("HOME", &home)
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

    let (status, page) = get(port, "/");
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
        format!("{h}/Library/Caches/b")
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
    assert_eq!(data["tree"]["files"], 7);
    assert_eq!(data["tree"]["mtime"], 1700000000);
    assert_eq!(data["tree"]["children"][0]["files"], 0);
    assert_eq!(data["insights"], Value::Null);
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    assert_eq!(token.len(), 22);

    assert_eq!(get(port, "/favicon.ico").0, 204);
    assert_eq!(get(port, "/nope").0, 404);
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
            "POST /preview HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
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
                {{"path": "{h}/Library/Caches/a"}},
                {{"path": "{h}/big.iso"}},
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
    assert_eq!(plan["rejected"][0]["path"], format!("{h}/Library/Caches/a"));
    assert_eq!(plan["rejected"][0]["reason"], "already gone");
    assert_eq!(plan["count"], 1);
    assert!(!run.join("selection.json").exists());

    let approve = format!(
        r#"{{"token": "{token}", "decision": "approve", "items": [
            {{"path": "{h}/Library/Caches/a", "category": "caches"}},
            {{"path": "{h}/big.iso", "category": "big-files"}},
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
    assert_eq!(
        paths,
        [format!("{h}/Library/Caches/a").as_str(), "cmd:docker-prune"]
    );
    assert_eq!(sel["items"][1]["cmd_id"], "docker-prune");
    assert_eq!(sel["items"][1]["action"], "cmd");
    assert_eq!(sel["total_bytes"], 3048);

    assert!(
        !run.join("clean.events").exists() && !run.join("status").exists(),
        "a new approval clears the previous cleanup's events and status"
    );
    let after = events(port, &token, "waiting");
    assert_eq!(
        after[0].0, "waiting",
        "a watcher keeps serving the page's events after review exits"
    );
    assert_eq!(
        post(port, &approve),
        405,
        "the watcher accepts no decisions"
    );
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
    assert!(!json.contains('<'), "{json}");
    assert!(page.contains(r#"<meta name="disk-clean-token" content="tok""#));
}

fn clean_disk_render(data: &Value) -> String {
    disk_clean::review::render(data, "tok")
}

fn events(port: u16, token: &str, until: &str) -> Vec<(String, Value)> {
    read_until(&mut open_events(port, token), until)
}

fn open_events(port: u16, token: &str) -> BufReader<TcpStream> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut s = loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => break s,
            Err(e) => {
                assert!(std::time::Instant::now() < deadline, "{e}");
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    };
    s.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .unwrap();
    write!(
        s,
        "GET /events?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .unwrap();
    let mut reader = BufReader::new(s);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("HTTP/1.1 200"), "{line}");
    reader
}

fn read_until(reader: &mut BufReader<TcpStream>, until: &str) -> Vec<(String, Value)> {
    let mut line = String::new();
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
        "POST {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
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
    let (mut child, port, token) = spawn_live(&home, &bin);

    let (status, page) = get(port, "/");
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
    assert!(page.contains(&token));
    assert_eq!(get(port, "/events?token=wrong").0, 403);

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
    assert!(
        names[1..walked]
            .iter()
            .all(|n| *n == "item" || *n == "progress"),
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
    assert!(first[walked].1["worktrees"].as_u64().unwrap() <= 1);
    let item = |path: &Path| {
        first
            .iter()
            .position(|(n, d)| n == "item" && d["item"]["path"] == path.to_str().unwrap())
            .unwrap_or_else(|| panic!("no item for {}", path.display()))
    };
    let cache = home.join("Library/Caches/app");
    let first_progress = names
        .iter()
        .position(|n| *n == "progress")
        .unwrap_or(walked);
    assert!(
        item(&cache) < first_progress,
        "fixed locations come before the walk"
    );
    item(&home.join("code/wt"));
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

fn spawn_live(home: &Path, bin: &Path) -> (std::process::Child, u16, String) {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let mut child = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .arg("review")
        .env("HOME", home)
        .env("PATH", path)
        .env("DISK_CLEAN_SKIP_MAP", "1")
        .env("DISK_CLEAN_WATCH_START", "1")
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
    let (_, page) = get(port, "/");
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    (child, port, token)
}

#[test]
fn rescan_restarts_the_scan_in_place() {
    let t = common::temp_dir("rescan");
    let home = t.0.join("home");
    let bin = t.0.join("bin");
    let gate = t.0.join("gate");
    let old = home.join("Library/Caches/old");
    let new = home.join("Library/Caches/new");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("blob"), vec![7u8; 64 * 1024]).unwrap();
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
    let (mut child, port, token) = spawn_live(&home, &bin);
    let rescan = |token: &str| post_to(port, "/rescan", &format!(r#"{{"token": "{token}"}}"#));
    let preview = || {
        post_to(
            port,
            "/preview",
            &format!(r#"{{"token": "{token}", "items": []}}"#),
        )
    };

    assert_eq!(rescan("wrong"), 403);
    assert_eq!(rescan(&token), 409, "a scan is running");
    let mut stream = open_events(port, &token);
    fs::write(&gate, "").unwrap();
    let first = read_until(&mut stream, "done");
    assert_eq!(preview(), 200);

    fs::remove_file(&gate).unwrap();
    fs::remove_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    fs::write(new.join("blob"), vec![7u8; 64 * 1024]).unwrap();
    assert_eq!(rescan(&token), 202);
    assert_eq!(rescan(&token), 409, "the rescan is running");
    let head = read_until(&mut stream, "rescan");
    assert_eq!(
        head.len(),
        1,
        "nothing of the old scan is sent again: {head:?}"
    );
    assert_eq!(head[0].1["elapsed_ms"], 0);
    assert_eq!(preview(), 409);
    assert_eq!(
        post_to(
            port,
            "/decide",
            &format!(r#"{{"token": "{token}", "decision": "approve", "items": []}}"#)
        ),
        409
    );
    fs::write(&gate, "").unwrap();
    let second = read_until(&mut stream, "done");
    assert_eq!(second[0].0, "disk");
    assert_eq!(second.iter().filter(|(n, _)| n == "done").count(), 1);
    let paths = |events: &[(String, Value)]| -> Vec<String> {
        events
            .iter()
            .filter(|(n, _)| n == "item")
            .filter_map(|(_, d)| d["item"]["path"].as_str().map(String::from))
            .collect()
    };
    assert!(paths(&first).contains(&old.display().to_string()));
    assert!(paths(&second).contains(&new.display().to_string()));
    assert!(!paths(&second).contains(&old.display().to_string()));
    let mut last = 0;
    for (name, data) in &second {
        let ms = data["elapsed_ms"].as_u64().unwrap();
        assert!(ms >= last, "{name} went back in time");
        last = ms;
    }

    let replay = events(port, &token, "done");
    assert_eq!(
        replay[0].0, "rescan",
        "a reconnect replays only the current scan"
    );
    assert_eq!(replay[1..], second[..]);
    assert_eq!(preview(), 200);

    let approve = format!(
        r#"{{"token": "{token}", "decision": "approve", "items": [{{"path": "{}", "category": "caches"}}, {{"path": "{}", "category": "caches"}}]}}"#,
        old.display(),
        new.display()
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
    let run = Path::new(stdout.lines().next().unwrap());
    let sel: Value =
        serde_json::from_str(&fs::read_to_string(run.join("selection.json")).unwrap()).unwrap();
    let chosen: Vec<&str> = sel["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap())
        .collect();
    assert_eq!(chosen, [new.to_str().unwrap()]);
}

fn finished_review(tag: &str) -> (common::TempDir, std::process::Child, u16, String) {
    let t = common::temp_dir(tag);
    let home = t.0.join("h");
    let run = t.0.join("run");
    let cache = home.join("Library/Caches/a");
    fs::create_dir_all(&cache).unwrap();
    fs::create_dir_all(&run).unwrap();
    fs::write(
        run.join("scan.tsv"),
        format!(
            "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/a\t{}\t2048\tnote\t3\texact\n",
            cache.display()
        ),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["review", &run.to_string_lossy()])
        .env("HOME", &home)
        .env("DISK_CLEAN_NO_BROWSER", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let port: u16 = line
        .trim()
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    let (_, page) = get(port, "/");
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    (t, child, port, token)
}

fn raw(method: &str, target: &str, headers: &str, body: &str) -> String {
    format!(
        "{method} {target} HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn a_foreign_host_or_origin_is_refused_everywhere() {
    let (_t, mut child, port, token) = finished_review("rebind");
    let body = format!(r#"{{"token": "{token}", "decision": "cancel", "items": []}}"#);
    let json = "Content-Type: application/json\r\n";
    for host in [
        format!("evil.example:{port}"),
        "evil.example".to_string(),
        "127.0.0.1".to_string(),
        format!("127.0.0.2:{port}"),
    ] {
        let headers = format!("Host: {host}\r\nOrigin: http://{host}\r\n{json}");
        for (method, target) in [
            ("GET", "/".to_string()),
            ("GET", format!("/events?token={token}")),
            ("POST", "/preview".to_string()),
            ("POST", "/rescan".to_string()),
            ("POST", "/decide".to_string()),
        ] {
            let sent = if method == "GET" { "" } else { body.as_str() };
            assert_eq!(
                request(port, raw(method, &target, &headers, sent)).0,
                403,
                "{method} {target} with Host {host}"
            );
        }
    }
    let local = format!("Host: 127.0.0.1:{port}\r\n");
    let preview = format!(r#"{{"token": "{token}", "items": []}}"#);
    let plain = format!("{local}Content-Type: text/plain\r\n");
    assert_eq!(
        request(port, raw("POST", "/preview", &plain, &preview)).0,
        403
    );
    assert_eq!(
        request(port, raw("POST", "/preview", &local, &preview)).0,
        403
    );
    let foreign = format!("{local}{json}Origin: http://evil.example\r\n");
    assert_eq!(
        request(port, raw("POST", "/preview", &foreign, &preview)).0,
        403
    );
    let own = format!("{local}{json}Origin: http://127.0.0.1:{port}\r\n");
    assert_eq!(
        request(port, raw("POST", "/preview", &own, &preview)).0,
        200
    );
    let named = format!("Host: localhost:{port}\r\n");
    assert_eq!(request(port, raw("GET", "/", &named, "")).0, 200);
    assert_eq!(post(port, &body), 200);
    assert_eq!(child.wait().unwrap().code(), Some(5));
}

#[test]
fn oversized_slow_and_excess_requests_are_turned_away() {
    let (_t, mut child, port, token) = finished_review("limits");
    let local = format!("Host: 127.0.0.1:{port}\r\n");
    let padded = format!("{local}X-Pad: {}\r\n", "a".repeat(17 * 1024));
    assert_eq!(request(port, raw("GET", "/", &padded, "")).0, 431);
    let huge = format!(
        "POST /preview HTTP/1.1\r\n{local}Content-Type: application/json\r\nContent-Length: 2000000\r\n\r\n"
    );
    assert_eq!(request(port, huge).0, 413);

    let started = std::time::Instant::now();
    let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(slow, "GET / HTTP/1.1\r\n{local}").unwrap();
    let mut answer = String::new();
    slow.read_to_string(&mut answer).unwrap();
    assert!(answer.starts_with("HTTP/1.0 408"), "{answer}");
    assert!(started.elapsed() >= std::time::Duration::from_secs(9));

    let streams: Vec<_> = (0..64).map(|_| open_events(port, &token)).collect();
    assert_eq!(get(port, "/").0, 503);
    drop(streams);
    let dropped = std::time::Instant::now();
    while get(port, "/").0 != 200 {
        assert!(
            dropped.elapsed() < std::time::Duration::from_millis(1500),
            "closed event streams still hold their slots"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(
        post(
            port,
            &format!(r#"{{"token": "{token}", "decision": "cancel"}}"#)
        ),
        200
    );
    assert_eq!(child.wait().unwrap().code(), Some(5));
}
