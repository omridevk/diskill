mod common;

use disk_clean::trash;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Output, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "tok-trash";

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
    common::assert_inside_ram_disk(&home);
    Sandbox { _t: t, home, run }
}

fn make(path: &Path, bytes: usize) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("data"), vec![7u8; bytes]).unwrap();
}

fn approve_with(s: &Sandbox, rows: &[(&str, &Path, i64)], mode: &str) {
    for (_, p, _) in rows {
        common::assert_inside_ram_disk(p);
    }
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
        format!(r#"{{"items": [{}], "mode": "{mode}"}}"#, items.join(",")),
    )
    .unwrap();
}

fn approve(s: &Sandbox, rows: &[(&str, &Path, i64)]) {
    approve_with(s, rows, "trash");
}

fn cli(s: &Sandbox, args: &[&str]) -> Output {
    let out = common::cli(args, &s.home, &[]);
    common::assert_record_inside_ram_disk(&s.home);
    out
}

fn clean(s: &Sandbox) {
    let _ = fs::remove_file(s.run.join("status"));
    let out = cli(s, &["clean", &text(&s.run)]);
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    common::wait_for("the worker", Duration::from_secs(30), || {
        fs::read_to_string(s.run.join("status")).unwrap_or_default() == "done\n"
    });
    common::assert_record_inside_ram_disk(&s.home);
}

fn record(s: &Sandbox) -> Vec<trash::Entry> {
    trash::read(&text(&s.home))
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

fn ino(path: &Path) -> u64 {
    fs::symlink_metadata(path).unwrap().ino()
}

#[test]
fn approved_paths_go_to_the_trash_and_undo_restores_them_exactly() {
    let s = sandbox("trash-undo");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a.join("nested"), 3000);
    make(&b, 5000);
    let (a_ino, b_ino) = (ino(&a), ino(&b));
    approve(&s, &[("rm", &a, 4096), ("rm", &b, 8192)]);
    clean(&s);

    assert!(!a.exists() && !b.exists());
    let entries = record(&s);
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert_eq!(entries[0].original, text(&a));
    assert!(
        Path::new(&entries[0].trashed).parent() == Some(common::trash_dir().as_path()),
        "{entries:?}"
    );
    assert_eq!((entries[0].bytes, entries[0].ino), (4096, a_ino));
    assert_eq!(entries[1].ino, b_ino);
    assert!(entries.iter().all(|e| e.state == "trashed"));
    assert!(Path::new(&entries[0].trashed).join("nested/data").exists());
    let done = named(&s.run, "done").pop().unwrap();
    assert_eq!(
        (
            &done["removed_bytes"],
            &done["trashed"],
            &done["trashed_bytes"]
        ),
        (&0.into(), &2.into(), &(4096 + 8192).into()),
        "moving to the Trash is never counted as freed"
    );

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(
        stdout(&out).contains("restored: 2 items, 12288 bytes"),
        "{}",
        stdout(&out)
    );
    assert_eq!(fs::read(a.join("nested/data")).unwrap().len(), 3000);
    assert_eq!(
        (ino(&a), ino(&b)),
        (a_ino, b_ino),
        "the same items came back"
    );
    assert!(record(&s).iter().all(|e| e.state == "restored"));
    let undone = named(&s.run, "undone");
    assert_eq!(undone.len(), 2);
    assert!(undone.iter().all(|e| e["outcome"] == "restored"));
    let summary = named(&s.run, "undo_done").pop().unwrap();
    assert_eq!(
        (&summary["restored"], &summary["trashed"]),
        (&2.into(), &0.into())
    );
    let again = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(again.status.code(), Some(3), "nothing left to undo");
}

#[test]
fn a_name_clash_in_the_trash_gets_its_own_name() {
    let s = sandbox("trash-clash");
    let name = format!("clash-{}", std::process::id());
    let a = s.home.join("Library/Caches").join(&name);
    make(&a, 100);
    fs::create_dir_all(common::trash_dir()).unwrap();
    let clash = common::trash_dir().join(&name);
    fs::write(&clash, b"someone else's").unwrap();
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let entry = &record(&s)[0];
    assert_ne!(entry.trashed, text(&clash), "{entry:?}");
    assert!(Path::new(&entry.trashed).join("data").exists());
    assert_eq!(fs::read(&clash).unwrap(), b"someone else's");
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(0));
    assert!(a.join("data").exists() && clash.exists());
    fs::remove_file(clash).unwrap();
}

#[test]
fn undo_never_overwrites_an_original_that_came_back() {
    let s = sandbox("trash-conflict");
    let a = s.home.join("Library/Caches/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    make(&a, 9);
    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        stdout(&out).contains("still in the Trash: 1"),
        "{}",
        stdout(&out)
    );
    assert_eq!(
        fs::read(a.join("data")).unwrap().len(),
        9,
        "never overwritten"
    );
    let entry = &record(&s)[0];
    assert_eq!(entry.state, "trashed");
    assert_eq!(entry.reason, trash::STILL_THERE);
    assert!(Path::new(&entry.trashed).join("data").exists());
    assert_eq!(named(&s.run, "undone")[0]["outcome"], "kept");
}

#[test]
fn sync_notices_put_back_emptied_and_replaced_items_and_never_acts() {
    let s = sandbox("trash-sync");
    let caches = s.home.join("Library/Caches");
    let (put, gone, swapped, kept) = (
        caches.join("put"),
        caches.join("gone"),
        caches.join("swapped"),
        caches.join("kept"),
    );
    for p in [&put, &gone, &swapped, &kept] {
        make(p, 10);
    }
    approve(
        &s,
        &[
            ("rm", &put, 1),
            ("rm", &gone, 2),
            ("rm", &swapped, 3),
            ("rm", &kept, 4),
        ],
    );
    clean(&s);
    let at = |name: &str| {
        record(&s)
            .into_iter()
            .find(|e| e.original.ends_with(name))
            .unwrap()
    };
    fs::rename(at("/put").trashed, &put).unwrap();
    fs::remove_dir_all(at("/gone").trashed).unwrap();
    let decoy = at("/swapped").trashed;
    fs::remove_dir_all(&decoy).unwrap();
    make(Path::new(&decoy), 1);

    let out = cli(&s, &["clean", "--dry-run", &text(&s.run)]);
    assert!(out.status.code().is_some());
    assert_eq!(at("/put").state, "put-back");
    assert_eq!(at("/gone").state, "emptied");
    let replaced = at("/swapped");
    assert_eq!(replaced.state, "failed");
    assert_eq!(
        replaced.reason,
        "the item in the Trash was replaced, not touched"
    );
    assert!(Path::new(&decoy).join("data").exists(), "never acted on");
    assert_eq!(at("/kept").state, "trashed");
    assert!(put.join("data").exists());
    fs::remove_dir_all(decoy).unwrap();
}

#[test]
fn empty_removes_only_recorded_items_still_in_the_trash() {
    let s = sandbox("trash-empty");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a, 3000);
    make(&b, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    fs::create_dir_all(common::trash_dir()).unwrap();
    let theirs = common::trash_dir().join(format!("not-ours-{}", std::process::id()));
    fs::write(&theirs, b"the user's").unwrap();
    let trashed = PathBuf::from(&record(&s)[0].trashed);

    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(stdout(&out).contains("emptied: 1 items, 4096 bytes"));
    assert!(!trashed.exists() && !a.exists());
    assert!(theirs.exists() && b.exists(), "only our record is touched");
    assert_eq!(record(&s)[0].state, "emptied");
    let done = named(&s.run, "empty_done").pop().unwrap();
    assert_eq!((&done["emptied"], &done["trashed"]), (&1.into(), &0.into()));
    assert!(done["free_after"].is_i64() && done["free_before"].is_i64());
    assert_eq!(cli(&s, &["empty", &text(&s.run)]).status.code(), Some(3));
    fs::remove_file(theirs).unwrap();
}

#[test]
fn delete_immediately_removes_and_is_never_recorded() {
    let s = sandbox("trash-now");
    let a = s.home.join("Library/Caches/a");
    make(&a.join("deep"), 100);
    approve_with(&s, &[("rm", &a, 4096)], "now");
    let dry = stdout(&cli(&s, &["clean", "--dry-run", &text(&s.run)]));
    assert!(
        dry.contains(&format!(
            "# deleted immediately, skipping the Trash (can't be undone):\nrm -rf -- {}\n",
            text(&a)
        )),
        "{dry}"
    );
    assert!(!dry.contains("trash --"), "{dry}");
    clean(&s);
    assert!(!a.exists());
    assert!(record(&s).is_empty());
    assert!(named(&s.run, "trashed").is_empty());
    assert_eq!(named(&s.run, "removed")[0]["path"], text(&a));
    let done = named(&s.run, "done").pop().unwrap();
    assert_eq!((&done["removed"], &done["trashed"]), (&1.into(), &0.into()));
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(3));
}

#[test]
fn items_already_in_the_trash_are_removed_for_good_not_trashed_again() {
    let s = sandbox("trash-old");
    let old = s.home.join(".Trash/old");
    make(&old, 10);
    approve(&s, &[("rm", &old, 4096)]);
    let dry = stdout(&cli(&s, &["clean", "--dry-run", &text(&s.run)]));
    assert!(
        dry.contains(&format!("rm -rf -- {}\n", text(&old))),
        "{dry}"
    );
    clean(&s);
    assert!(!old.exists() && record(&s).is_empty());
}

fn legacy_run(s: &Sandbox, originals: &[&Path]) -> PathBuf {
    let dir = s.home.join(".cache/disk-clean/held/run-1-0badf00d");
    fs::create_dir_all(&dir).unwrap();
    let mut manifest = String::new();
    for (n, original) in originals.iter().enumerate() {
        common::assert_inside_ram_disk(original.parent().unwrap());
        let held = dir.join((n + 1).to_string());
        make(&held, 50 + n);
        let meta = fs::symlink_metadata(&held).unwrap();
        manifest.push_str(&format!(
            "{}\n",
            serde_json::json!({"original": text(original), "held": text(&held), "bytes": 4096, "held_at": 1, "dev": meta.dev(), "ino": meta.ino()})
        ));
    }
    fs::write(dir.join("manifest.jsonl"), manifest).unwrap();
    dir
}

#[test]
fn migration_moves_held_runs_into_the_trash_and_drops_the_holding_folder() {
    let s = sandbox("trash-migrate");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("code/app/node_modules"),
    );
    fs::create_dir_all(a.parent().unwrap()).unwrap();
    fs::create_dir_all(b.parent().unwrap()).unwrap();
    let dir = legacy_run(&s, &[&a, &b]);

    let out = cli(&s, &["clean", "--dry-run", &text(&s.run)]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("disk-clean: moved 2 held items from the old holding folder to the Trash"),
        "{err}"
    );
    assert!(!dir.exists() && !s.home.join(".cache/disk-clean/held").exists());
    let entries = record(&s);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].original, text(&a));
    assert_eq!(entries[0].run, "run-1-0badf00d");
    assert_eq!(
        Path::new(&entries[1].trashed)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .split(' ')
            .next(),
        Some("node_modules"),
        "trashed under its own name"
    );
    assert!(entries.iter().all(|e| e.state == "trashed"));

    let undo = cli(&s, &["undo", "--all"]);
    assert_eq!(undo.status.code(), Some(0), "{}", stdout(&undo));
    assert_eq!(fs::read(a.join("data")).unwrap().len(), 50);
    assert_eq!(fs::read(b.join("data")).unwrap().len(), 51);
}

#[test]
fn a_tampered_record_or_swapped_folder_is_never_followed() {
    let s = sandbox("trash-tamper");
    let (a, b) = (
        s.home.join("Library/Caches/a/inner"),
        s.home.join("Library/Caches/b"),
    );
    make(&a, 10);
    make(&b, 10);
    approve(&s, &[("rm", &a, 1), ("rm", &b, 2)]);
    clean(&s);
    let decoy = common::temp_dir("trash-tamper-decoy");
    fs::rename(
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/a-moved"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&decoy.0, s.home.join("Library/Caches/a")).unwrap();
    let path = trash::record_path(&text(&s.home));
    let b_trashed = record(&s)[1].trashed.clone();
    let precious = s.home.join("Library/Caches/precious");
    make(&precious, 5);
    let tampered = fs::read_to_string(&path)
        .unwrap()
        .replace(&b_trashed, &text(&precious));
    fs::write(&path, tampered).unwrap();

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(
        !decoy.0.join("inner").exists(),
        "never restored through a symlink"
    );
    assert!(precious.join("data").exists());
    let entries = record(&s);
    assert!(
        entries[0].reason.contains("resolves elsewhere"),
        "{entries:?}"
    );
    assert_eq!(entries[0].state, "trashed");
    assert_eq!(entries[1].state, "failed", "{entries:?}");
    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(precious.join("data").exists());
    assert!(
        Path::new(&b_trashed).exists(),
        "the real b is never touched by a tampered entry"
    );
    assert!(!Path::new(&entries[0].trashed).exists());
    fs::remove_dir_all(b_trashed).unwrap();
}

#[test]
fn undo_and_empty_wait_while_the_record_is_busy() {
    let s = sandbox("trash-busy");
    let a = s.home.join("Library/Caches/a");
    make(&a, 10);
    approve(&s, &[("rm", &a, 1)]);
    clean(&s);
    let held = trash::Record::open(&text(&s.home), 1).unwrap().unwrap();
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(4));
    assert_eq!(cli(&s, &["empty", &text(&s.run)]).status.code(), Some(4));
    let port = free_port();
    let mut child = watcher(&s, port);
    let own = own_headers(port);
    let id = record(&s)[0].id.clone();
    let body = format!(r#"{{"token": "{TOKEN}", "ids": ["{id}"]}}"#);
    assert_eq!(post(port, "/undo", &own, &body), 409);
    drop(held);
    assert_eq!(post(port, "/undo", &own, &body), 202);
    common::wait_for("the undo", Duration::from_secs(10), || {
        !named(&s.run, "undo_done").is_empty()
    });
    assert!(a.join("data").exists());
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn the_worker_holds_the_record_so_an_undo_cannot_race_it() {
    let s = sandbox("trash-race");
    let caches = s.home.join("Library/Caches");
    let paths: Vec<PathBuf> = (0..150).map(|n| caches.join(format!("p{n}"))).collect();
    for p in &paths {
        make(p, 1);
    }
    let rows: Vec<(&str, &Path, i64)> = paths.iter().map(|p| ("rm", p.as_path(), 1)).collect();
    approve(&s, &rows);
    let out = cli(&s, &["clean", &text(&s.run)]);
    assert!(out.status.success());
    common::wait_for("the first trash batch", Duration::from_secs(30), || {
        !named(&s.run, "trash").is_empty()
    });
    let busy = trash::Record::open(&text(&s.home), 1).unwrap();
    let done = fs::read_to_string(s.run.join("status")).unwrap_or_default() == "done\n";
    assert!(
        busy.is_none() || done,
        "the record is free while the worker still moves items"
    );
    drop(busy);
    common::wait_for("the worker", Duration::from_secs(60), || {
        fs::read_to_string(s.run.join("status")).unwrap_or_default() == "done\n"
    });
    assert_eq!(record(&s).len(), 150);
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(0));
    assert!(paths.iter().all(|p| p.join("data").exists()));
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn watcher(s: &Sandbox, port: u16) -> Child {
    common::bin(&s.home)
        .args(["watch", &text(&s.run)])
        .env("DISK_CLEAN_WATCH_TOKEN", TOKEN)
        .env("DISK_CLEAN_WATCH_PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn own_headers(port: u16) -> String {
    format!(
        "Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
    )
}

fn connect(port: u16) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(stream) => break stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("watcher never listened: {e}"),
        }
    }
}

fn post(port: u16, route: &str, headers: &str, body: &str) -> u16 {
    let mut stream = connect(port);
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

fn get(port: u16, route: &str) -> String {
    let mut stream = connect(port);
    write!(
        stream,
        "GET {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).unwrap();
    out
}

#[test]
fn undo_and_empty_routes_need_token_origin_and_host_and_stay_in_the_record() {
    let s = sandbox("trash-routes");
    let (a, b, outsider) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
        s.home.join("Library/Caches/outsider"),
    );
    make(&a, 100);
    make(&b, 100);
    make(&outsider, 100);
    approve(&s, &[("rm", &a, 4096), ("rm", &b, 4096)]);
    clean(&s);
    let ids: Vec<String> = record(&s).into_iter().map(|e| e.id).collect();
    let port = free_port();
    let mut child = watcher(&s, port);
    let own = own_headers(port);
    let body = |id: &str| {
        format!(
            r#"{{"token": "{TOKEN}", "ids": ["{id}"], "paths": ["{}"]}}"#,
            text(&outsider)
        )
    };
    let refused = [
        (
            format!(
                "Host: evil.example:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
            ),
            body(&ids[0]),
        ),
        (
            format!(
                "Host: 127.0.0.1:{port}\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\n"
            ),
            body(&ids[0]),
        ),
        (
            format!("Host: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n"),
            body(&ids[0]),
        ),
        (
            format!(
                "Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: text/plain\r\n"
            ),
            body(&ids[0]),
        ),
        (own.clone(), r#"{"token": "wrong", "ids": []}"#.to_string()),
        (own.clone(), "not json".to_string()),
        (own.clone(), format!(r#"{{"token": "{TOKEN}"}}"#)),
    ];
    for route in ["/undo", "/empty"] {
        for (headers, body) in &refused {
            let status = post(port, route, headers, body);
            assert!(
                status == 403 || status == 400,
                "{route} {headers:?} {body}: {status}"
            );
        }
    }
    assert_eq!(
        post(port, "/free", &own, &body(&ids[0])),
        405,
        "free is gone"
    );
    assert_eq!(
        post(port, "/undo", &own, &body("00000000deadbeef")),
        404,
        "an id we never recorded"
    );

    assert_eq!(post(port, "/undo", &own, &body(&ids[0])), 202);
    common::wait_for("the undo", Duration::from_secs(10), || {
        !named(&s.run, "undo_done").is_empty()
    });
    assert!(a.join("data").exists() && !b.exists());
    assert_eq!(post(port, "/empty", &own, &body(&ids[1])), 202);
    common::wait_for("the empty", Duration::from_secs(10), || {
        !named(&s.run, "empty_done").is_empty()
    });
    assert!(outsider.join("data").exists() && a.join("data").exists());
    assert_eq!(
        record(&s)
            .iter()
            .map(|e| e.state.as_str())
            .collect::<Vec<_>>(),
        ["restored", "emptied"]
    );
    let rows = named(&s.run, "trash");
    assert!(rows.iter().any(|r| r["entries"][0]["state"] == "emptied"));
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_page_load_syncs_the_record_and_tells_the_page() {
    let s = sandbox("trash-page");
    let a = s.home.join("Library/Caches/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let entry = record(&s).remove(0);
    assert_eq!(entry.state, "trashed", "{entry:?}");
    fs::rename(&entry.trashed, &a).unwrap();
    let port = free_port();
    let mut child = watcher(&s, port);
    let page = get(port, "/trash");
    assert!(page.contains(" 200 OK"), "{page}");
    assert!(
        page.contains(r#""state":"put-back""#),
        "the page gets the synced record"
    );
    assert!(page.contains(&format!(r#""run":"{}""#, trash::run_id(&s.run))));
    let told = named(&s.run, "trash");
    assert_eq!(told.last().unwrap()["entries"][0]["state"], "put-back");
    assert_eq!(record(&s)[0].state, "put-back");
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn the_confirm_plan_lists_trash_moves_apart_from_steps_that_cannot_be_undone() {
    let s = sandbox("trash-preview");
    let a = s.home.join("Library/Caches/a");
    let old = s.home.join(".Trash/old");
    make(&a, 100);
    make(&old, 100);
    let scan = scan_row("caches", "rm", &text(&a), 4096)
        + &scan_row("trash", "rm", &text(&old), 10)
        + "docker\tDocker\tD\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t7\tn\t-\tvm\n";
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    let cats = disk_clean::review::load_scan(&s.run);
    let index =
        disk_clean::clean::index_scan(&disk_clean::util::read_lines(&s.run.join("scan.tsv")));
    let items = [
        serde_json::json!({"path": text(&a)}),
        serde_json::json!({"path": text(&old)}),
        serde_json::json!({"path": "cmd:docker-prune"}),
        serde_json::json!({"path": "/etc/hosts"}),
    ];
    let plan = disk_clean::review::preview(&cats, &index, &items, &text(&s.home));
    let paths = plan["paths"].as_array().unwrap();
    let of = |p: &Path| paths.iter().find(|r| r["path"] == text(p)).unwrap();
    assert_eq!(of(&a)["bytes"], 4096);
    assert_eq!(of(&a)["trashed"], false);
    assert_eq!(of(&old)["trashed"], true, "already in a Trash");
    assert_eq!(plan["paths_bytes"], 4106);
    assert_eq!(plan["final"], serde_json::json!(["docker system prune -f"]));
    assert_eq!((&plan["count"], &plan["bytes"]), (&3.into(), &4113.into()));
    assert!(a.exists());
}
