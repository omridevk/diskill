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
