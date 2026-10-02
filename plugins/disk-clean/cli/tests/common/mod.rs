#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct TempDir(pub PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn temp_dir(tag: &str) -> TempDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let out = Command::new("getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .output()
        .unwrap();
    let base = String::from_utf8(out.stdout).unwrap().trim().to_string();
    let dir = PathBuf::from(base).join(format!("disk-clean-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(std::fs::canonicalize(&dir).unwrap())
}

pub fn sh(cwd: &Path, script: &str) {
    let status = Command::new("bash")
        .arg("-ec")
        .arg(script)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .unwrap();
    assert!(status.success(), "script failed: {script}");
}
