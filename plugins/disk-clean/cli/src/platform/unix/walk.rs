use crate::walk::{Kind, Meta};
use std::fs;
use std::os::unix::fs::MetadataExt;

pub fn meta_of(m: &fs::Metadata) -> Meta {
    let t = m.file_type();
    let kind = if t.is_symlink() {
        Kind::Symlink
    } else if t.is_dir() {
        Kind::Dir
    } else if t.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Meta {
        dev: m.dev(),
        ino: m.ino(),
        nlink: m.nlink(),
        blocks: m.blocks(),
        size: m.size(),
        mtime: m.mtime(),
        kind,
    }
}
