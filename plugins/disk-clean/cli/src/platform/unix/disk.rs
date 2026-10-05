use std::fs;
use std::os::unix::fs::MetadataExt;

pub fn file_id(file: &fs::File) -> Option<u128> {
    file.metadata().ok().map(|meta| u128::from(meta.ino()))
}
