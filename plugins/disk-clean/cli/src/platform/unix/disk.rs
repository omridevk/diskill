use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub fn drives_to_walk(_home: &str) -> (Vec<PathBuf>, HashSet<PathBuf>) {
    (Vec::new(), HashSet::new())
}

pub fn planning<T>(plan: impl FnOnce() -> T) -> T {
    plan()
}

pub fn belongs_to_user(_path: &Path, _home: &str) -> bool {
    true
}

pub fn file_id(file: &fs::File) -> Option<u128> {
    file.metadata().ok().map(|meta| u128::from(meta.ino()))
}
