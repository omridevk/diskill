mod common;

use disk_clean::walk;
use std::collections::HashSet;
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::process::Command;

fn du_kb(path: &Path) -> u64 {
    let out = Command::new("du").arg("-sk").arg(path).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    text.split_whitespace().next().unwrap().parse().unwrap()
}

fn walk_kb(path: &Path) -> u64 {
    walk::size_of(path).unwrap().div_ceil(2)
}

#[test]
fn walk_totals_match_du() {
    let t = common::temp_dir("sizes");
    let root = t.0.join("tree");
    fs::create_dir_all(root.join("a/b/c")).unwrap();
    fs::create_dir_all(root.join("links")).unwrap();
    for (i, size) in [1usize, 4095, 4096, 4097, 100_000, 3_000_000]
        .iter()
        .enumerate()
    {
        fs::write(root.join(format!("a/f{i}")), vec![7u8; *size]).unwrap();
        fs::write(root.join(format!("a/b/c/g{i}")), vec![3u8; size * 2]).unwrap();
    }
    fs::hard_link(root.join("a/f5"), root.join("links/same-as-f5")).unwrap();
    fs::hard_link(root.join("a/b/c/g5"), root.join("a/b/c/g5-again")).unwrap();
    let mut sparse = fs::File::create(root.join("links/sparse")).unwrap();
    sparse.seek(SeekFrom::Start(512 * 1024 * 1024)).unwrap();
    sparse.write_all(b"x").unwrap();
    drop(sparse);
    std::os::unix::fs::symlink(root.join("a"), root.join("links/to-a")).unwrap();

    assert!(fs::metadata(root.join("links/sparse")).unwrap().len() > 500 * 1024 * 1024);
    for p in [
        root.clone(),
        root.join("a"),
        root.join("a/b"),
        root.join("links"),
    ] {
        assert_eq!(walk_kb(&p), du_kb(&p), "size of {}", p.display());
    }
    let sparse = root.join("links/sparse");
    assert_eq!(walk_kb(&sparse), du_kb(&sparse));
    assert!(walk_kb(&sparse) < 1024, "sparse file counted by allocation");
}

#[test]
fn map_dirs_carry_file_count_and_newest_mtime() {
    let t = common::temp_dir("map-stats");
    let root = t.0.join("tree");
    fs::create_dir_all(root.join("a/b")).unwrap();
    let stamp = |path: &Path, secs: u64| {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    };
    for (name, secs) in [("a/one", 1_000), ("a/b/two", 3_000), ("a/b/three", 2_000)] {
        fs::write(root.join(name), b"x").unwrap();
        stamp(&root.join(name), secs);
    }
    for dir in ["a/b", "a", ""] {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(500);
        fs::File::open(root.join(dir))
            .unwrap()
            .set_modified(when)
            .unwrap();
    }
    let plan = walk::Plan {
        map_depth: Some(2),
        ..walk::Plan::default()
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
    let stat = |p: &Path| {
        out.map
            .iter()
            .find(|(path, ..)| path == p)
            .map(|(_, _, files, mtime)| (*files, *mtime))
            .unwrap_or_else(|| panic!("{} not in map", p.display()))
    };
    assert_eq!(stat(&root.join("a/b")), (2, 3_000));
    assert_eq!(stat(&root.join("a")), (3, 3_000));
    assert_eq!(stat(&root), (3, 3_000));
}

fn fixture(root: &Path) {
    for p in 0..24 {
        let project = root.join(format!("p{p}"));
        for d in ["src/a/b", "node_modules/dep/lib", "target/debug", "cache/c"] {
            fs::create_dir_all(project.join(d)).unwrap();
        }
        fs::create_dir_all(project.join(".git/objects")).unwrap();
        for (i, d) in [
            "",
            "src",
            "src/a/b",
            "node_modules/dep/lib",
            "target/debug",
            "cache/c",
        ]
        .iter()
        .enumerate()
        {
            for f in 0..6 {
                let bytes = vec![b'x'; 1 + (p * 7919 + i * 131 + f * 4099) % 20_000];
                fs::write(project.join(d).join(format!("f{f}.rs")), bytes).unwrap();
            }
        }
        fs::write(project.join("Cargo.toml"), b"[package]").unwrap();
        fs::hard_link(project.join("f0.rs"), project.join("src/linked.rs")).unwrap();
    }
}

fn fixture_plan(root: &Path, now: i64) -> walk::Plan {
    walk::Plan {
        home: root.to_path_buf(),
        map_depth: Some(3),
        nm_depth: 9,
        dev_depth: 7,
        big_depth: 6,
        repo_depth: 6,
        stale_days: -1,
        now,
        big_bytes: 16_000,
        exact: [root.join("p3/src")].into_iter().collect(),
        parents: [root.join("p5/cache")].into_iter().collect(),
        days: disk_clean::insights::midnights(now),
        ..walk::Plan::default()
    }
}

fn walked(root: &Path, plan: walk::Plan, parallel: bool) -> (walk::Walk, Option<u64>, Vec<String>) {
    let (repo_tx, repo_rx) = std::sync::mpsc::channel();
    let plan = walk::Plan {
        repo_tx: Some(repo_tx),
        ..plan
    };
    let mut out = walk::Walk::default();
    let total = walk::walk(
        root,
        root,
        &plan,
        parallel,
        &mut HashSet::new(),
        &mut out,
        &|_, _| {},
    );
    drop(plan);
    let mut repos: Vec<String> = repo_rx
        .into_iter()
        .map(|p| p.display().to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    repos.sort();
    (out, total, repos)
}

#[test]
fn bounded_parallel_walk_matches_the_serial_walk() {
    let t = common::temp_dir("walk-agree");
    let root = t.0.join("tree");
    fixture(&root);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (serial, serial_total, serial_repos) = walked(&root, fixture_plan(&root, now), false);
    let (parallel, parallel_total, parallel_repos) = walked(&root, fixture_plan(&root, now), true);
    assert_eq!(parallel_total, serial_total);
    assert_eq!(parallel.files, serial.files);
    assert_eq!(parallel.bytes, serial.bytes);
    assert_eq!(parallel.map, serial.map);
    assert_eq!(parallel.sizes, serial.sizes);
    assert_eq!(parallel.children, serial.children);
    assert_eq!(parallel.node_modules, serial.node_modules);
    assert_eq!(parallel.artifacts, serial.artifacts);
    assert_eq!(parallel.big_files, serial.big_files);
    assert_eq!(parallel_repos, serial_repos);
    assert_eq!(parallel_repos.len(), 24);
    assert_eq!(serial.node_modules.len(), 24);
    assert_eq!(serial.artifacts.len(), 24);
    let home = root.display().to_string();
    let days = disk_clean::insights::midnights(now);
    assert_eq!(
        disk_clean::insights::to_json(parallel.insights, &days, now, &home),
        disk_clean::insights::to_json(serial.insights, &days, now, &home)
    );
}
