use std::path::Path;
use std::process::Command;

#[test]
fn volume_stats_match_df() {
    let mount = clean_disk::util::data_mount();
    let stats = clean_disk::util::volume_stats(&mount).unwrap();
    let out = Command::new("df").arg("-k").arg(&mount).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let cols: Vec<u64> = text
        .lines()
        .nth(1)
        .unwrap()
        .split_whitespace()
        .skip(1)
        .take(3)
        .map(|v| v.parse().unwrap())
        .collect();
    let close = |a: u64, b: u64| a.abs_diff(b) <= 64 * 1024 * 1024;
    assert_eq!(stats.total, cols[0] * 1024);
    assert!(
        close(stats.used, cols[1] * 1024),
        "used {} vs df {}",
        stats.used,
        cols[1] * 1024
    );
    assert!(
        close(stats.avail, cols[2] * 1024),
        "avail {} vs df {}",
        stats.avail,
        cols[2] * 1024
    );
    assert!(Path::new(&mount).is_dir());
}
