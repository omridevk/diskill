use std::fs;
use std::os::unix::fs::MetadataExt;

pub struct VolumeStats {
    pub total: u64,
    pub used: u64,
    pub avail: u64,
}

pub fn file_id(meta: &fs::Metadata) -> u64 {
    meta.ino()
}
