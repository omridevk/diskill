use crate::platform::meta_of;
use crate::walk::Meta;
use std::ffi::OsString;
use std::fs;
use std::path::Path;

pub fn read_dir_bulk(dir: &Path) -> std::io::Result<Vec<(OsString, Option<Meta>)>> {
    Ok(fs::read_dir(dir)?
        .flatten()
        .map(|e| (e.file_name(), e.metadata().ok().map(|m| meta_of(&m))))
        .collect())
}
