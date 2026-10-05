use super::path::{at_or_within, known_folder, wide, within};
use crate::platform::{VolumeStats, path_text, split_root};
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetTempPath2W};
use windows::Win32::UI::Shell::FOLDERID_Windows;
use windows::core::PCWSTR;

pub(super) const DRIVE_FIXED: u32 = 3;
const MAX_PATH: usize = 260;

pub fn volume_stats(path: &Path) -> Option<VolumeStats> {
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    let name = wide(path);
    // SAFETY: GetDiskFreeSpaceExW reads the NUL-terminated name and writes the three locals.
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(name.as_ptr()),
            Some(&mut avail),
            Some(&mut total),
            Some(&mut free),
        )
        .ok()?;
    }
    Some(VolumeStats {
        total,
        used: total.saturating_sub(free),
        avail,
    })
}

pub fn data_mount() -> PathBuf {
    let home = crate::util::home();
    PathBuf::from(split_root(&home).map_or("C:/", |(root, _)| root))
}

pub(super) fn is_fixed_drive(root: &str) -> bool {
    let name = wide(Path::new(root));
    // SAFETY: GetDriveTypeW only reads the NUL-terminated root name.
    unsafe { GetDriveTypeW(PCWSTR(name.as_ptr())) == DRIVE_FIXED }
}

pub fn user_tmp_base() -> Option<String> {
    let mut buf = [0u16; MAX_PATH + 1];
    // SAFETY: GetTempPath2W writes at most buf.len() characters into buf.
    let len = unsafe { GetTempPath2W(Some(&mut buf)) } as usize;
    if len == 0 || len > buf.len() {
        return None;
    }
    let raw = super::path::from_wide(&buf[..len]);
    let tmp = path_text(&fs::canonicalize(&raw).ok()?)?;
    let home = crate::util::home();
    if home.is_empty() || at_or_within(&home, &tmp) || crate::util::is_root(&tmp) {
        return None;
    }
    if within(&tmp, &home) {
        return Some(tmp);
    }
    let in_windows = known_folder(&FOLDERID_Windows).is_some_and(|w| at_or_within(&tmp, &w));
    let (root, _) = split_root(&tmp)?;
    (!in_windows && is_fixed_drive(root)).then_some(tmp)
}

pub fn file_id(meta: &fs::Metadata) -> u64 {
    meta.creation_time()
}
