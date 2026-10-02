mod common;

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
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

    let mut child = Command::new(env!("CARGO_BIN_EXE_clean-disk"))
        .args(["review", &run.to_string_lossy()])
        .env("CLEAN_DISK_NO_BROWSER", "1")
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
    let data_line = page
        .lines()
        .find(|l| l.starts_with("const DATA = "))
        .unwrap();
    let data: Value = serde_json::from_str(
        data_line
            .trim_start_matches("const DATA = ")
            .trim_end_matches(';'),
    )
    .unwrap();
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
    let token_line = page
        .lines()
        .find(|l| l.starts_with("const TOKEN = "))
        .unwrap();
    let token = token_line.split('"').nth(1).unwrap().to_string();
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
    let out = Command::new(env!("CARGO_BIN_EXE_clean-disk"))
        .args(["review", &run.to_string_lossy()])
        .env("CLEAN_DISK_NO_BROWSER", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
}
