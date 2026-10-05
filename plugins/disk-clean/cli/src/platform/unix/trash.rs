use serde::Serialize;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

pub fn no_follow() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.custom_flags(libc::O_NOFOLLOW);
    options
}

pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

pub fn dev_and_ino(meta: &fs::Metadata) -> (u64, u64) {
    (meta.dev(), meta.ino())
}

pub fn same_item(path: &str, dev: u64, ino: u64) -> Option<bool> {
    fs::symlink_metadata(path)
        .ok()
        .map(|m| dev_and_ino(&m) == (dev, ino))
}

#[derive(Serialize, Clone)]
pub struct Checked {
    pub path: String,
    pub dev: u64,
    pub ino: u64,
}
