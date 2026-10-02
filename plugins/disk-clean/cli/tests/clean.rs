mod common;

use disk_clean::clean::is_allowed;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

const HOME: &str = "/Users/someone";
const BASE: &str = "/private/var/folders/ab/xyz";

#[test]
fn is_allowed_table() {
    let allowed = [
        "/private/tmp/x",
        "/private/tmp/some/deep/dir",
        "/private/var/folders/ab/xyz/T/cache",
        "/private/var/folders/ab/xyz/C/com.app",
        "/private/var/folders/ab/xyz/X/App.code_sign_clone",
        "/Users/someone/Library/Caches/thing",
        "/Users/someone/Library/Logs/x.log",
        "/Users/someone/.npm/_cacache",
        "/Users/someone/code/app/node_modules",
        "/Users/someone/.Trash/old",
        "/Users/someone/Downloads/big.iso",
        "/Users/someone/Documentsx",
        "/Users/someone/Library/Mailbox",
    ];
    let blocked = [
        "/private/tmp/",
        "/private/tmp",
        "/private/tmp/../etc",
        "/Users/someone/code/../Documents",
        "/private/var/folders/ab/xyz/T/",
        "/private/var/folders/ab/xyz/other/x",
        "/private/var/folders/zz/other/T/x",
        "/Users/someone",
        "/Users/someone/",
        "/",
        "/System/Library",
        "/Library/Caches",
        "/Applications/App.app",
        "/usr/local/lib",
        "/bin/ls",
        "/sbin/mount",
        "/etc/hosts",
        "/var/log",
        "/private/etc",
        "/opt/homebrew",
        "/Users",
        "/Users/other/thing",
        "relative/path",
        "/Volumes/External/x",
        "/Users/someone/Documents",
        "/Users/someone/Documents/a",
        "/Users/someone/Desktop",
        "/Users/someone/Desktop/a",
        "/Users/someone/Pictures/a",
        "/Users/someone/Movies",
        "/Users/someone/Music/a",
        "/Users/someone/.ssh",
        "/Users/someone/.ssh/id_rsa",
        "/Users/someone/.gnupg/x",
        "/Users/someone/.aws/credentials",
        "/Users/someone/.kube/config",
        "/Users/someone/.claude",
        "/Users/someone/.claude/projects",
        "/Users/someone/Library",
        "/Users/someone/Library/Keychains",
        "/Users/someone/Library/Keychains/login.keychain-db",
        "/Users/someone/Library/Group Containers/x/Keychains",
        "/Users/someone/Library/Mail",
        "/Users/someone/Library/Mail/V10",
        "/Users/someone/Library/Messages",
        "/Users/someone/Library/Messages/chat.db",
    ];
    for p in allowed {
        assert!(is_allowed(p, HOME, Some(BASE)), "should allow {p}");
    }
    for p in blocked {
        assert!(!is_allowed(p, HOME, Some(BASE)), "should block {p}");
    }
    assert!(!is_allowed(
        "/private/var/folders/ab/xyz/T/cache",
        HOME,
        None
    ));
    assert!(is_allowed("/private/tmp/x", HOME, None));
}

fn scan_row(cat: &str, action: &str, path: &str) -> String {
    format!("{cat}\tTitle\tDesc\tsafe\t1\t{action}\t-\t{path}\t{path}\t4096\tnote\t1\texact\n")
}

fn selection_item(action: &str, path: &str) -> String {
    format!(
        r#"{{"path": "{path}", "label": "{path}", "bytes": 4096, "action": "{action}", "cmd_id": "-", "category": "x"}}"#
    )
}

#[test]
fn clean_end_to_end_on_fixture() {
    let t = common::temp_dir("clean");
    let root = &t.0;
    let run = root.join("run");
    fs::create_dir_all(&run).unwrap();
    let doomed = root.join("doomed");
    fs::create_dir_all(doomed.join("nested/deeper")).unwrap();
    fs::write(doomed.join("nested/deeper/file"), vec![1u8; 10_000]).unwrap();
    let doomed_file = root.join("doomed-file.bin");
    fs::write(&doomed_file, b"bytes").unwrap();
    let not_in_scan = root.join("not-in-scan");
    fs::create_dir_all(&not_in_scan).unwrap();
    common::sh(
        root,
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init",
    );
    let repo = root.join("repo");

    let p = |x: &Path| x.to_string_lossy().into_owned();
    let scan = [
        scan_row("caches", "rm", &p(&doomed)),
        scan_row("caches", "rm", &p(&doomed_file)),
        scan_row("caches", "rm", "/etc/hosts"),
        scan_row("worktrees", "worktree", &p(&repo)),
    ]
    .concat();
    fs::write(run.join("scan.tsv"), scan).unwrap();
    fs::write(run.join("free-before"), "123\n").unwrap();
    let items = [
        selection_item("rm", &p(&doomed)),
        selection_item("rm", &p(&doomed_file)),
        selection_item("rm", &p(&not_in_scan)),
        selection_item("rm", "/etc/hosts"),
        selection_item("worktree", &p(&repo)),
        selection_item("rm", &p(&repo)),
        r#"{"action": "cmd", "cmd_id": "rm-rf-everything", "bytes": 1}"#.to_string(),
    ]
    .join(",");
    fs::write(
        run.join("selection.json"),
        format!(r#"{{"items": [{items}], "total_bytes": 0}}"#),
    )
    .unwrap();

    let dry = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["clean", "--dry-run", &p(&run)])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    let plan = String::from_utf8_lossy(&dry.stdout);
    assert!(dry.status.success(), "{plan}");
    assert!(
        plan.contains(&format!("\nrm -rf -- {}\n", p(&doomed))),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("\nrm -rf -- {}\n", p(&doomed_file))),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("# kept, not a registered worktree: {}", p(&repo))),
        "{plan}"
    );
    assert!(
        plan.contains("# rejected (protected path): /etc/hosts"),
        "{plan}"
    );
    assert!(
        plan.contains("# rejected (unknown command id): rm-rf-everything"),
        "{plan}"
    );
    assert!(plan.contains("# 3 items, 12288 bytes"), "{plan}");
    assert!(doomed.exists() && doomed_file.exists());
    assert!(!run.join("rm-list").exists() && !run.join("status").exists());

    let out = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["clean", &p(&run)])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "clean failed: {stdout} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("queued  : 3 items (12288 bytes)"),
        "{stdout}"
    );
    assert!(stdout.contains("rejected: 4"), "{stdout}");
    assert!(stdout.contains("pid     : "), "{stdout}");
    assert!(
        stdout.contains(&format!("log     : {}", p(&run.join("clean.log")))),
        "{stdout}"
    );

    let rejected = fs::read_to_string(run.join("rejected")).unwrap();
    assert!(
        rejected.contains(&format!("not in scan\t{}\n", p(&not_in_scan))),
        "{rejected}"
    );
    assert!(
        rejected.contains("protected path\t/etc/hosts\n"),
        "{rejected}"
    );
    assert!(
        rejected.contains(&format!("action does not match scan\t{}\n", p(&repo))),
        "{rejected}"
    );
    assert!(
        rejected.contains("unknown command id\trm-rf-everything\n"),
        "{rejected}"
    );
    assert_eq!(fs::read_to_string(run.join("cmd-list")).unwrap(), "");
    assert_eq!(
        fs::read_to_string(run.join("wt-list")).unwrap(),
        format!("{}\n", p(&repo))
    );

    let deadline = Instant::now() + Duration::from_secs(30);
    while fs::read_to_string(run.join("status")).unwrap_or_default() != "done\n" {
        assert!(Instant::now() < deadline, "worker never finished");
        std::thread::sleep(Duration::from_millis(100));
    }
    let log = fs::read_to_string(run.join("clean.log")).unwrap();
    assert!(log.contains(&format!("removed {}  (", p(&doomed))), "{log}");
    assert!(
        log.contains(&format!("removed {}  (", p(&doomed_file))),
        "{log}"
    );
    assert!(
        log.contains(&format!("KEPT    {} (not a registered worktree)", p(&repo))),
        "{log}"
    );
    assert!(log.contains("free before: 123 bytes"), "{log}");
    assert!(log.contains("reclaimed:   "), "{log}");
    assert!(!doomed.exists() && !doomed_file.exists());
    assert!(not_in_scan.exists() && repo.join("a").exists() && Path::new("/etc/hosts").exists());
}

#[test]
fn clean_rejects_everything() {
    let t = common::temp_dir("clean-none");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("scan.tsv"), "").unwrap();
    fs::write(
        run.join("selection.json"),
        r#"{"items": [{"path": "/etc/hosts"}]}"#,
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["clean", &run.to_string_lossy()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&out.stderr).contains("nothing passed validation"));
    assert!(!run.join("clean.log").exists());
}

#[test]
fn dry_run_quotes_paths_and_lists_fixed_commands() {
    let t = common::temp_dir("clean-dry");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let odd = t.0.join("it's a dir");
    fs::create_dir_all(&odd).unwrap();
    let odd_s = odd.to_string_lossy().into_owned();
    fs::write(run.join("scan.tsv"), scan_row("caches", "rm", &odd_s)).unwrap();
    let items = [
        selection_item("rm", &odd_s).replace('\'', "\\u0027"),
        r#"{"action": "cmd", "cmd_id": "docker-prune", "bytes": 7}"#.to_string(),
    ]
    .join(",");
    fs::write(
        run.join("selection.json"),
        format!(r#"{{"items": [{items}]}}"#),
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_disk-clean"))
        .args(["clean", "--dry-run", &run.to_string_lossy()])
        .output()
        .unwrap();
    let plan = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{plan}");
    let quoted = format!("'{}'", odd_s.replace('\'', r"'\''"));
    assert!(plan.contains(&format!("\nrm -rf -- {quoted}\n")), "{plan}");
    assert!(plan.contains("\ndocker system prune -f\n"), "{plan}");
    assert!(odd.exists());
}
