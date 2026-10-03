mod common;

use disk_clean::hold;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "tok-hold";

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn scan_row(cat: &str, action: &str, path: &str, bytes: i64) -> String {
    format!("{cat}\tTitle\tDesc\tsafe\t1\t{action}\t-\t{path}\t{path}\t{bytes}\tnote\t1\texact\n")
}

fn item(action: &str, path: &str, bytes: i64) -> String {
    format!(
        r#"{{"path": "{path}", "label": "{path}", "bytes": {bytes}, "action": "{action}", "cmd_id": "-"}}"#
    )
}

struct Sandbox {
    _t: common::TempDir,
    home: PathBuf,
    run: PathBuf,
}

fn sandbox(tag: &str) -> Sandbox {
    let t = common::temp_dir(tag);
    let home = t.0.join("home");
    let run = home.join(".cache/disk-clean/run-1");
    fs::create_dir_all(&run).unwrap();
    Sandbox { _t: t, home, run }
}

fn make(path: &Path, bytes: usize) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("data"), vec![7u8; bytes]).unwrap();
}

fn approve(s: &Sandbox, rows: &[(&str, &Path, i64)]) {
    let scan: String = rows
        .iter()
        .map(|(action, p, bytes)| scan_row("caches", action, &text(p), *bytes))
        .collect();
    let items: Vec<String> = rows
        .iter()
        .map(|(action, p, bytes)| item(action, &text(p), *bytes))
        .collect();
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    fs::write(
        s.run.join("selection.json"),
        format!(r#"{{"items": [{}]}}"#, items.join(",")),
    )
    .unwrap();
}

fn cli(s: &Sandbox, args: &[&str], env: &[(&str, &str)]) -> Output {
    common::cli(args, &s.home, env)
}

fn clean(s: &Sandbox, env: &[(&str, &str)]) {
    let _ = fs::remove_file(s.run.join("status"));
    let out = cli(s, &["clean", &text(&s.run)], env);
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    common::wait_for("the worker", Duration::from_secs(30), || {
        fs::read_to_string(s.run.join("status")).unwrap_or_default() == "done\n"
    });
}

fn held_dir(s: &Sandbox) -> PathBuf {
    hold::dir_of(&text(&s.home), &s.run)
}

fn named(run: &Path, name: &str) -> Vec<Value> {
    common::events_of(run)
        .into_iter()
        .filter(|e| e["event"] == name)
        .collect()
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn approved_paths_are_held_then_undone_exactly() {
    let s = sandbox("hold-undo");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a.join("nested"), 3000);
    make(&b, 5000);
    approve(&s, &[("rm", &a, 4096), ("rm", &b, 8192)]);
    clean(&s, &[]);

    assert!(!a.exists() && !b.exists());
    let manifest = hold::read(&held_dir(&s));
    assert_eq!(manifest.len(), 2, "{manifest:?}");
    assert_eq!(manifest[0].original, text(&a));
    assert_eq!(manifest[0].bytes, 4096);
    assert!(Path::new(&manifest[0].held).join("nested/data").exists());
    assert_eq!(
        Path::new(&manifest[0].held).parent(),
        Some(held_dir(&s).as_path())
    );
    let held = named(&s.run, "held");
    assert_eq!(held.len(), 2);
    assert_eq!(held[0]["held_path"], manifest[0].held.as_str());
    let done = named(&s.run, "done").pop().unwrap();
    assert_eq!(
        (&done["removed_bytes"], &done["held"], &done["held_bytes"]),
        (&0.into(), &2.into(), &(4096 + 8192).into()),
        "holding is never counted as freed"
    );

    let out = cli(&s, &["undo", &text(&s.run)], &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(
        stdout(&out).contains("restored: 2 items, 12288 bytes"),
        "{}",
        stdout(&out)
    );
    assert_eq!(fs::read(a.join("nested/data")).unwrap().len(), 3000);
    assert_eq!(fs::read(b.join("data")).unwrap().len(), 5000);
    assert!(
        !held_dir(&s).exists(),
        "an emptied run leaves no holding folder"
    );
    let undone = named(&s.run, "undone");
    assert_eq!(undone.len(), 2);
    assert!(undone.iter().all(|e| e["outcome"] == "restored"));
    let summary = named(&s.run, "undo_done").pop().unwrap();
    assert_eq!(
        (&summary["restored"], &summary["held"]),
        (&2.into(), &0.into())
    );

    let again = cli(&s, &["undo", &text(&s.run)], &[]);
    assert_eq!(again.status.code(), Some(3), "nothing left to undo");
}

#[test]
fn undo_never_overwrites_an_original_that_came_back() {
    let s = sandbox("hold-conflict");
    let nm = s.home.join("code/app/node_modules");
    make(&nm, 2000);
    approve(&s, &[("rm", &nm, 4096)]);
    clean(&s, &[]);
    make(&nm, 10);

    let out = cli(&s, &["undo", &text(&s.run)], &[]);
    assert!(stdout(&out).contains("still held: 1"), "{}", stdout(&out));
    assert_eq!(
        fs::read(nm.join("data")).unwrap().len(),
        10,
        "the reinstalled copy stays"
    );
    let kept = named(&s.run, "undone").pop().unwrap();
    assert_eq!(kept["outcome"], "kept");
    assert_eq!(kept["reason"], hold::STILL_THERE);
    let manifest = hold::read(&held_dir(&s));
    assert_eq!(manifest.len(), 1);
    assert_eq!(
        fs::read(Path::new(&manifest[0].held).join("data"))
            .unwrap()
            .len(),
        2000
    );

    fs::remove_dir_all(&nm).unwrap();
    let out = cli(&s, &["undo", &text(&s.run)], &[]);
    assert!(
        stdout(&out).contains("restored: 1 items"),
        "{}",
        stdout(&out)
    );
    assert_eq!(fs::read(nm.join("data")).unwrap().len(), 2000);
}

#[test]
fn free_deletes_only_the_held_copies_and_counts_them_freed() {
    let s = sandbox("hold-free");
    let a = s.home.join("Library/Caches/a");
    make(&a, 9000);
    approve(&s, &[("rm", &a, 12288)]);
    clean(&s, &[]);
    let dir = held_dir(&s);
    assert!(dir.exists());

    let out = cli(&s, &["free", &text(&s.run)], &[]);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        stdout(&out).contains("freed: 1 items, 12288 bytes"),
        "{}",
        stdout(&out)
    );
    assert!(!dir.exists() && !a.exists());
    let freed = named(&s.run, "freed");
    assert_eq!(freed.len(), 1);
    assert_eq!(
        (&freed[0]["path"], &freed[0]["outcome"]),
        (&Value::from(text(&a)), &"freed".into())
    );
    let done = named(&s.run, "free_done").pop().unwrap();
    assert_eq!(
        (&done["freed_bytes"], &done["held"]),
        (&12288.into(), &0.into())
    );
    assert!(done["free_after"].is_i64() && done["free_before"].is_i64());
    assert_eq!(
        cli(&s, &["free", &text(&s.run)], &[]).status.code(),
        Some(3)
    );
}

#[test]
fn a_path_whose_folder_is_read_only_is_not_held() {
    let s = sandbox("hold-perm");
    let pinned = s.home.join("Library/Caches/pinned");
    let inside = pinned.join("cache");
    make(&inside, 100);
    approve(&s, &[("rm", &inside, 4096)]);
    common::sh(&s.home, "chmod 555 Library/Caches/pinned");
    clean(&s, &[]);
    common::sh(&s.home, "chmod 755 Library/Caches/pinned");
    assert!(inside.join("data").exists(), "never deleted by this step");
    let failed = named(&s.run, "failed");
    assert_eq!(failed[0]["reason"], "not held: permission denied");
    assert!(hold::read(&held_dir(&s)).is_empty());
}

struct RamDisk {
    device: String,
    mount: PathBuf,
}

impl Drop for RamDisk {
    fn drop(&mut self) {
        let _ = Command::new("hdiutil")
            .args(["detach", "-force", &self.device])
            .output();
    }
}

fn ram_disk(tag: &str) -> RamDisk {
    let attach = Command::new("hdiutil")
        .args(["attach", "-nomount", "ram://8192"])
        .output()
        .unwrap();
    let device = String::from_utf8_lossy(&attach.stdout).trim().to_string();
    let name = format!("dc{tag}{}", std::process::id());
    let erased = Command::new("diskutil")
        .args(["erasevolume", "HFS+", &name, &device])
        .output()
        .unwrap();
    let disk = RamDisk {
        device,
        mount: PathBuf::from(format!("/Volumes/{name}")),
    };
    assert!(
        erased.status.success(),
        "{}",
        String::from_utf8_lossy(&erased.stderr)
    );
    disk
}

#[test]
fn a_path_on_another_volume_is_not_held() {
    let disk = ram_disk("x");
    let home = fs::canonicalize(&disk.mount).unwrap().join("home");
    let t = common::temp_dir("hold-exdev");
    let s = Sandbox {
        run: home.join("run"),
        home,
        _t: common::temp_dir("hold-exdev-run"),
    };
    fs::create_dir_all(&s.run).unwrap();
    let elsewhere = t.0.join("cache");
    make(&elsewhere, 100);
    approve(&s, &[("rm", &elsewhere, 4096)]);
    clean(&s, &[]);
    assert!(elsewhere.join("data").exists());
    let failed = named(&s.run, "failed");
    assert_eq!(
        failed[0]["reason"],
        "not held: on another volume than the holding folder"
    );
    assert!(named(&s.run, "held").is_empty());
}

#[test]
fn held_runs_expire_on_the_next_invocation() {
    let s = sandbox("hold-expire");
    let a = s.home.join("Library/Caches/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s, &[]);
    let dir = held_dir(&s);

    let fresh = cli(&s, &["clean", "--dry-run", &text(&s.run)], &[]);
    assert!(!String::from_utf8_lossy(&fresh.stderr).contains("freed"));
    assert!(dir.exists(), "not expired within DISK_CLEAN_HOLD_DAYS");

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run)],
        &[("DISK_CLEAN_HOLD_DAYS", "0")],
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("disk-clean: freed 1 held items (4096 bytes) held more than 0 days"),
        "{err}"
    );
    assert!(!dir.exists() && !a.exists());
}

#[test]
fn the_holding_folder_is_its_own_section_and_selecting_it_frees_it() {
    let s = sandbox("hold-section");
    let project = s.home.join("Library/Caches/project");
    let venv = project.join(".venv");
    make(&venv, 20_000);
    fs::write(project.join("big.bin"), vec![1u8; 3 << 20]).unwrap();
    common::sh(&project, "touch -t 202301010000 .venv .venv/data");
    approve(&s, &[("rm", &project, 4096)]);
    clean(&s, &[]);
    let dir = held_dir(&s);

    let scan_run = s.home.join("scan-run");
    let env = [
        ("DISK_CLEAN_SKIP_MAP", "1"),
        ("DISK_CLEAN_MIN_BYTES", "1"),
        ("DISK_CLEAN_BIGFILE_BYTES", "1048576"),
    ];
    let out = cli(&s, &["scan", &text(&scan_run)], &env);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let scan = fs::read_to_string(scan_run.join("scan.tsv")).unwrap();
    let held_root = text(&hold::root(&text(&s.home)));
    let rows: Vec<Vec<&str>> = scan.lines().map(|l| l.split('\t').collect()).collect();
    let under_hold: Vec<&Vec<&str>> = rows
        .iter()
        .filter(|r| r[8].starts_with(&held_root))
        .collect();
    assert_eq!(under_hold.len(), 1, "{scan}");
    let row = under_hold[0];
    assert_eq!(
        (row[0], row[1], row[5], row[8]),
        ("held", "Held by disk-clean", "free", text(&dir).as_str())
    );
    assert!(row[9].parse::<i64>().unwrap() > 3 << 20);

    fs::write(s.run.join("scan.tsv"), format!("{}\n", row.join("\t"))).unwrap();
    fs::write(
        s.run.join("selection.json"),
        format!(r#"{{"items": [{}]}}"#, item("free", &text(&dir), 5000)),
    )
    .unwrap();
    let dry = stdout(&cli(&s, &["clean", "--dry-run", &text(&s.run)], &[]));
    assert!(
        dry.contains(&format!("# can't be undone:\ndelete {}\n", text(&dir))),
        "{dry}"
    );
    clean(&s, &[]);
    assert!(!dir.exists());
    let freed = named(&s.run, "freed");
    assert_eq!(freed.len(), 1);
    assert_eq!(freed[0]["path"], text(&project));
    assert_eq!(named(&s.run, "done").pop().unwrap()["removed_bytes"], 4096);
}

#[test]
fn a_tampered_manifest_or_held_copy_is_never_followed() {
    let s = sandbox("hold-tamper");
    let decoy_t = common::temp_dir("hold-decoy");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a, 100);
    make(&b, 100);
    approve(&s, &[("rm", &a, 4096), ("rm", &b, 4096)]);
    clean(&s, &[]);
    let dir = held_dir(&s);
    let mut manifest = hold::read(&dir);
    let precious = decoy_t.0.join("precious");
    make(&precious, 10);
    let swapped = PathBuf::from(&manifest[1].held);
    fs::rename(&swapped, s.home.join("moved-away")).unwrap();
    std::os::unix::fs::symlink(&precious, &swapped).unwrap();
    let mut outside = manifest[0].clone();
    outside.held = text(&precious);
    manifest.push(outside);
    let lines: String = manifest
        .iter()
        .map(|e| serde_json::to_string(e).unwrap() + "\n")
        .collect();
    fs::write(dir.join("manifest.jsonl"), lines).unwrap();

    let out = cli(&s, &["free", &text(&s.run)], &[]);
    assert!(stdout(&out).contains("freed: 1 items"), "{}", stdout(&out));
    assert!(precious.join("data").exists(), "the decoy survives free");
    let reasons: Vec<String> = named(&s.run, "freed")
        .iter()
        .filter(|e| e["outcome"] == "kept")
        .map(|e| e["reason"].as_str().unwrap().to_string())
        .collect();
    assert!(
        reasons
            .iter()
            .any(|r| r.contains("replaced after it was held")),
        "{reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|r| r.contains("outside its holding folder")),
        "{reasons:?}"
    );

    let out = cli(&s, &["undo", &text(&s.run)], &[]);
    assert!(
        stdout(&out).contains("restored: 0 items"),
        "{}",
        stdout(&out)
    );
    assert!(precious.join("data").exists() && !b.exists());
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn watcher(s: &Sandbox, port: u16) -> Child {
    Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["watch", &text(&s.run)])
        .env("HOME", &s.home)
        .env("DISK_CLEAN_WATCH_TOKEN", TOKEN)
        .env("DISK_CLEAN_WATCH_PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn post(port: u16, route: &str, headers: &str, body: &str) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut stream = loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(stream) => break stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("watcher never listened: {e}"),
        }
    };
    write!(
        stream,
        "POST {route} HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).unwrap();
    out.split_whitespace().nth(1).unwrap().parse().unwrap()
}

#[test]
fn undo_and_free_routes_need_token_origin_and_host_and_stay_in_the_manifest() {
    let s = sandbox("hold-routes");
    let (a, outsider) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/outsider"),
    );
    make(&a, 100);
    make(&outsider, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s, &[]);
    let port = free_port();
    let mut child = watcher(&s, port);
    let own = format!(
        "Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
    );
    let token = format!(
        r#"{{"token": "{TOKEN}", "paths": ["{}"]}}"#,
        text(&outsider)
    );
    let refused = [
        (
            format!(
                "Host: evil.example:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
            ),
            token.clone(),
        ),
        (
            format!(
                "Host: 127.0.0.1:{port}\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\n"
            ),
            token.clone(),
        ),
        (
            format!("Host: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n"),
            token.clone(),
        ),
        (
            format!(
                "Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: text/plain\r\n"
            ),
            token.clone(),
        ),
        (own.clone(), r#"{"token": "wrong"}"#.to_string()),
        (own.clone(), "not json".to_string()),
    ];
    for route in ["/undo", "/free"] {
        for (headers, body) in &refused {
            let status = post(port, route, headers, body);
            assert!(
                status == 403 || status == 400,
                "{route} {headers:?} {body}: {status}"
            );
        }
    }
    assert!(!a.exists() && hold::read(&held_dir(&s)).len() == 1);
    assert_eq!(
        post(port, "/decide", &own, &token),
        405,
        "still read-only otherwise"
    );

    assert_eq!(post(port, "/undo", &own, &token), 202);
    common::wait_for("the undo", Duration::from_secs(10), || {
        !named(&s.run, "undo_done").is_empty()
    });
    assert!(a.join("data").exists() && outsider.join("data").exists());
    assert_eq!(
        post(port, "/free", &own, &token),
        404,
        "nothing held any more"
    );

    approve(&s, &[("rm", &a, 4096)]);
    clean(&s, &[]);
    assert_eq!(post(port, "/free", &own, &token), 202);
    common::wait_for("the free", Duration::from_secs(10), || {
        !named(&s.run, "free_done").is_empty()
    });
    assert!(
        !a.exists() && outsider.join("data").exists(),
        "only manifest entries are touched"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn the_confirm_modal_plan_groups_hold_moves_apart_from_steps_that_cannot_be_undone() {
    let s = sandbox("hold-preview");
    let a = s.home.join("Library/Caches/a");
    make(&a, 100);
    let scan = scan_row("caches", "rm", &text(&a), 4096)
        + "docker\tDocker\tD\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t7\tn\t-\tvm\n";
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    let cats = disk_clean::review::load_scan(&s.run);
    let index =
        disk_clean::clean::index_scan(&disk_clean::util::read_lines(&s.run.join("scan.tsv")));
    let items = [
        serde_json::json!({"path": text(&a)}),
        serde_json::json!({"path": "cmd:docker-prune"}),
        serde_json::json!({"path": "/etc/hosts"}),
    ];
    let plan = disk_clean::review::preview(&cats, &index, &items, &s.run);
    assert_eq!(plan["hold"][0]["path"], text(&a));
    assert_eq!(plan["hold"][0]["bytes"], 4096);
    assert!(
        plan["hold"][0]["held"]
            .as_str()
            .unwrap()
            .ends_with(&format!(
                "/.cache/disk-clean/held/{}/1",
                hold::run_id(&s.run)
            )),
        "{plan}"
    );
    assert_eq!(plan["hold_bytes"], 4096);
    assert_eq!(plan["final"], serde_json::json!(["docker system prune -f"]));
    assert_eq!((&plan["count"], &plan["bytes"]), (&2.into(), &4103.into()));
    assert!(a.exists());
}
