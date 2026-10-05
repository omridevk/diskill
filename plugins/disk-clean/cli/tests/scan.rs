mod common;

use disk_clean::scan::parse_docker_bytes;
use disk_clean::walk;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

#[test]
fn docker_reclaimable_parsing() {
    let cases = [
        ("1.2GB (40%)", (1.2f64 * 1073741824.0) as u64),
        ("512MB", 512 * 1048576),
        ("3.5 GB", (3.5f64 * 1073741824.0) as u64),
        ("0B (0%)", 0),
        ("120B", 120),
        ("12.5kB", 0),
        ("2TB", 2 * 1099511627776),
        ("", 0),
        ("n/a", 0),
        ("1.2.3GB", 0),
    ];
    for (input, want) in cases {
        assert_eq!(parse_docker_bytes(input), want, "{input:?}");
    }
}

fn scan(home: &Path, run: &Path) -> String {
    let out = common::cli(
        &["scan", &run.to_string_lossy()],
        home,
        &[
            ("DISK_CLEAN_SKIP_MAP", "1"),
            ("DISK_CLEAN_MIN_BYTES", "1"),
            ("DISK_CLEAN_NM_MIN_BYTES", "1"),
        ],
    );
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(out.status.success(), "{err}");
    err
}

#[test]
fn a_symlinked_home_is_scanned_through_its_real_path() {
    let t = common::temp_dir("scan-homelink");
    let real = t.0.join("real-home");
    let nm = real.join("code/app/node_modules/pkg");
    fs::create_dir_all(&nm).unwrap();
    fs::write(nm.join("index.js"), vec![1u8; 8192]).unwrap();
    let link = t.0.join("home-link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let run = t.0.join("run");
    let err = scan(&link, &run);
    assert!(
        err.contains(&format!("resolves to {}", real.display())),
        "{err}"
    );
    let rows = fs::read_to_string(run.join("scan.tsv")).unwrap();
    let wanted = format!("\t{}\t", real.join("code/app/node_modules").display());
    assert!(rows.contains(&wanted), "{rows}");
}

#[test]
fn folders_nested_too_deep_to_read_are_reported() {
    let t = common::temp_dir("scan-deep");
    let home = t.0.join("home");
    fs::create_dir_all(home.join("deep")).unwrap();
    common::sh(
        &home.join("deep"),
        &format!(
            "n=$(printf 'd%.0s' $(seq 1 120)); for i in $(seq 1 {}); do mkdir \"$n\"; cd \"$n\"; done; echo hi >f",
            common::levels_past_path_max()
        ),
    );
    let run = t.0.join("run");
    let err = scan(&home, &run);
    assert!(err.contains("nested too deep to read"), "{err}");
    let facts = fs::read_to_string(run.join("disk.tsv")).unwrap();
    let skipped: u64 = facts
        .lines()
        .find_map(|l| l.strip_prefix("too_deep\t"))
        .expect("too_deep in disk.tsv")
        .parse()
        .unwrap();
    assert!(skipped >= 1, "{facts}");
}

#[test]
fn a_future_mtime_never_becomes_the_newest_change_of_its_parents() {
    let t = common::temp_dir("scan-future");
    let root = t.0.join("tree");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("sub/normal"), b"x").unwrap();
    fs::write(root.join("sub/future"), b"x").unwrap();
    common::sh(
        &root,
        "touch -t 210601010000 sub/future && touch -t 202001010000 sub . ",
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let plan = walk::Plan {
        map_depth: Some(3),
        now,
        ..Default::default()
    };
    let mut out = walk::Walk::default();
    walk::walk(
        &root,
        &root,
        &plan,
        false,
        &mut HashSet::new(),
        &mut out,
        &|_, _| {},
    );
    let newest = |p: &Path| {
        out.map
            .iter()
            .find(|(path, ..)| path == p)
            .map(|(_, _, _, mtime)| *mtime)
            .unwrap()
    };
    assert!(newest(&root) <= now, "root says {}", newest(&root));
    assert!(newest(&root.join("sub")) <= now);
    assert!(
        newest(&root) > 1_600_000_000,
        "the normal file still counts"
    );
}
