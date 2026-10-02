mod common;

use disk_clean::walk;
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
