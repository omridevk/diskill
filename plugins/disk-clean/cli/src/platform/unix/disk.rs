use std::fs;
use std::os::unix::fs::MetadataExt;

pub fn file_id(meta: &fs::Metadata) -> u64 {
    meta.ino()
}
