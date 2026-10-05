use super::path::{from_wide, wide};
use crate::walk::{Kind, Meta};
use std::ffi::{OsString, c_void};
use std::fs;
use std::io;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_FILE_NOT_FOUND, FILETIME, HANDLE, NO_ERROR, SetLastError,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_PINNED,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_ATTRIBUTE_UNPINNED,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
    FILE_INFO_BY_HANDLE_CLASS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_STANDARD_INFO, FIND_FIRST_EX_LARGE_FETCH, FileAttributeTagInfo,
    FileIdInfo, FileStandardInfo, FindClose, FindExInfoBasic, FindExSearchNameMatch,
    FindFirstFileExW, FindNextFileW, GetCompressedFileSizeW, GetDiskFreeSpaceW,
    GetFileAttributesExW, GetFileExInfoStandard, GetFileInformationByHandleEx, GetVolumePathNameW,
    INVALID_FILE_SIZE, WIN32_FILE_ATTRIBUTE_DATA, WIN32_FIND_DATAW,
};
use windows::core::PCWSTR;

const NAME_SURROGATE: u32 = 0x2000_0000;
const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
const CLOUD_TAG_MASK: u32 = 0xFFFF_0FFF;
const NO_OPEN: u32 = FILE_ATTRIBUTE_RECALL_ON_OPEN.0
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0
    | FILE_ATTRIBUTE_OFFLINE.0;
pub(super) const CLOUD_ATTRS: u32 = FILE_ATTRIBUTE_RECALL_ON_OPEN.0
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0
    | FILE_ATTRIBUTE_PINNED.0
    | FILE_ATTRIBUTE_UNPINNED.0;
const EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;
const TICKS_PER_SECOND: i64 = 10_000_000;

pub const DEV_NAMES: &[&str] = &[
    ".venv",
    "venv",
    "target",
    ".next",
    ".nuxt",
    ".turbo",
    ".svelte-kit",
    ".parcel-cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "bin",
    "obj",
];
const DOTNET_PROJECTS: &[&str] = &["csproj", "fsproj", "vbproj"];

pub fn is_build_output(d: &Path) -> bool {
    match d.file_name().and_then(|n| n.to_str()) {
        Some("target") => d.with_file_name("Cargo.toml").is_file(),
        Some("bin" | "obj") => d.parent().is_some_and(has_dotnet_project),
        _ => true,
    }
}

fn has_dotnet_project(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|list| {
        list.flatten().any(|e| {
            Path::new(&e.file_name())
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| DOTNET_PROJECTS.iter().any(|p| x.eq_ignore_ascii_case(p)))
        })
    })
}

struct Entry {
    attrs: u32,
    tag: u32,
    size: u64,
    mtime: i64,
}

struct Volume {
    serial: u64,
    cluster: u64,
}

fn unix_time(t: FILETIME) -> i64 {
    let ticks = (i64::from(t.dwHighDateTime) << 32) | i64::from(t.dwLowDateTime);
    (ticks - EPOCH_AS_FILETIME).div_euclid(TICKS_PER_SECOND)
}

pub(super) fn is_cloud_tag(attrs: u32, tag: u32) -> bool {
    attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 && tag & CLOUD_TAG_MASK == IO_REPARSE_TAG_CLOUD
}

fn kind_of(attrs: u32, tag: u32) -> Kind {
    let reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;
    if reparse && tag & NAME_SURROGATE != 0 {
        Kind::Symlink
    } else if is_cloud_tag(attrs, tag) {
        Kind::Other
    } else if attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        Kind::Dir
    } else {
        Kind::File
    }
}

fn open_attributes(name: &[u16]) -> Option<HANDLE> {
    // SAFETY: CreateFileW reads the NUL-terminated name; it opens for attributes only and never follows a reparse point.
    unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            windows::Win32::Storage::FileSystem::OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .ok()
    }
}

fn info<T: Default>(handle: HANDLE, class: FILE_INFO_BY_HANDLE_CLASS) -> Option<T> {
    let mut out = T::default();
    // SAFETY: GetFileInformationByHandleEx writes at most size_of::<T>() bytes into out, which is the struct the class names.
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut out as *mut T).cast::<c_void>(),
            std::mem::size_of::<T>() as u32,
        )
        .ok()?;
    }
    Some(out)
}

fn close(handle: HANDLE) {
    // SAFETY: the handle came from CreateFileW and is closed exactly once.
    let _ = unsafe { CloseHandle(handle) };
}

fn volume_of(name: &[u16]) -> Option<Volume> {
    let handle = open_attributes(name)?;
    let id: Option<FILE_ID_INFO> = info(handle, FileIdInfo);
    close(handle);
    let mut root = [0u16; 1024];
    let (mut sectors, mut bytes) = (0u32, 0u32);
    // SAFETY: GetVolumePathNameW writes at most root.len() characters into root; GetDiskFreeSpaceW reads the NUL-terminated root and writes the two locals.
    let cluster = unsafe {
        GetVolumePathNameW(PCWSTR(name.as_ptr()), &mut root)
            .and_then(|()| {
                GetDiskFreeSpaceW(
                    PCWSTR(root.as_ptr()),
                    Some(&mut sectors),
                    Some(&mut bytes),
                    None,
                    None,
                )
            })
            .map_or(4096, |()| u64::from(sectors) * u64::from(bytes))
    };
    Some(Volume {
        serial: id?.VolumeSerialNumber,
        cluster: cluster.max(1),
    })
}

fn allocated(name: &[u16], fallback: u64, cluster: u64) -> u64 {
    let mut high = 0u32;
    // SAFETY: SetLastError only clears this thread's error code, so a failed size can be told from a size whose low half is INVALID_FILE_SIZE; GetCompressedFileSizeW reads the NUL-terminated name and writes the high half into the local.
    let low = unsafe {
        SetLastError(NO_ERROR);
        GetCompressedFileSizeW(PCWSTR(name.as_ptr()), Some(&mut high))
    };
    let bytes = if low == INVALID_FILE_SIZE && io::Error::last_os_error().raw_os_error() != Some(0)
    {
        fallback
    } else {
        (u64::from(high) << 32) | u64::from(low)
    };
    bytes.div_ceil(cluster) * cluster
}

fn meta_from(name: &[u16], e: &Entry, volume: &Volume) -> Meta {
    let kind = kind_of(e.attrs, e.tag);
    let mut meta = Meta {
        dev: volume.serial,
        ino: 0,
        nlink: 1,
        blocks: 0,
        size: e.size,
        mtime: e.mtime,
        kind,
    };
    if kind != Kind::File || e.attrs & NO_OPEN != 0 {
        return meta;
    }
    if let Some(handle) = open_attributes(name) {
        let id: Option<FILE_ID_INFO> = info(handle, FileIdInfo);
        let standard: Option<FILE_STANDARD_INFO> = info(handle, FileStandardInfo);
        close(handle);
        if let Some(id) = id {
            meta.dev = id.VolumeSerialNumber;
            meta.ino = u64::from_le_bytes(id.FileId.Identifier[..8].try_into().unwrap_or([0; 8]));
        }
        if let Some(standard) = standard {
            meta.nlink = u64::from(standard.NumberOfLinks);
        }
    }
    meta.blocks = allocated(name, e.size, volume.cluster).div_ceil(512);
    meta
}

fn child(dir: &Path, name: &OsString) -> Vec<u16> {
    wide(&dir.join(name))
}

fn find_first(pattern: &[u16], data: &mut WIN32_FIND_DATAW) -> windows::core::Result<HANDLE> {
    // SAFETY: FindFirstFileExW reads the NUL-terminated pattern and writes one WIN32_FIND_DATAW into data.
    unsafe {
        FindFirstFileExW(
            PCWSTR(pattern.as_ptr()),
            FindExInfoBasic,
            (data as *mut WIN32_FIND_DATAW).cast::<c_void>(),
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    }
}

fn find_close(find: HANDLE) {
    // SAFETY: find is an open search handle and is closed exactly once.
    let _ = unsafe { FindClose(find) };
}

pub(super) fn find_one(path: &Path) -> Option<(u32, u32)> {
    let mut data = WIN32_FIND_DATAW::default();
    let find = find_first(&wide(path), &mut data).ok()?;
    find_close(find);
    Some((data.dwFileAttributes, data.dwReserved0))
}

pub fn read_dir_bulk(dir: &Path) -> io::Result<Vec<(OsString, Option<Meta>)>> {
    let dir_name = wide(dir);
    let volume = volume_of(&dir_name).ok_or_else(io::Error::last_os_error)?;
    let pattern = wide(&dir.join("*"));
    let mut data = WIN32_FIND_DATAW::default();
    let find = match find_first(&pattern, &mut data) {
        Ok(find) => find,
        Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return Ok(Vec::new()),
        Err(_) => return Err(io::Error::last_os_error()),
    };
    let mut out = Vec::new();
    loop {
        let name = from_wide(&data.cFileName);
        if name != "." && name != ".." {
            let entry = Entry {
                attrs: data.dwFileAttributes,
                tag: data.dwReserved0,
                size: (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow),
                mtime: unix_time(data.ftLastWriteTime),
            };
            let meta = meta_from(&child(dir, &name), &entry, &volume);
            out.push((name, Some(meta)));
        }
        // SAFETY: find is the open search handle; FindNextFileW writes one WIN32_FIND_DATAW into data.
        if unsafe { FindNextFileW(find, &mut data) }.is_err() {
            break;
        }
    }
    find_close(find);
    Ok(out)
}

pub fn meta_at(path: &Path) -> Option<Meta> {
    let name = wide(path);
    let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
    // SAFETY: GetFileAttributesExW reads the NUL-terminated name and writes one WIN32_FILE_ATTRIBUTE_DATA into data; it never opens the file.
    unsafe {
        GetFileAttributesExW(
            PCWSTR(name.as_ptr()),
            GetFileExInfoStandard,
            (&mut data as *mut WIN32_FILE_ATTRIBUTE_DATA).cast::<c_void>(),
        )
        .ok()?;
    }
    let tag = if data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        && data.dwFileAttributes & NO_OPEN == 0
    {
        let handle = open_attributes(&name)?;
        let tag: Option<FILE_ATTRIBUTE_TAG_INFO> = info(handle, FileAttributeTagInfo);
        close(handle);
        tag?.ReparseTag
    } else {
        0
    };
    let entry = Entry {
        attrs: data.dwFileAttributes,
        tag,
        size: (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow),
        mtime: unix_time(data.ftLastWriteTime),
    };
    let volume = if entry.attrs & NO_OPEN == 0 {
        volume_of(&name)?
    } else {
        volume_of(&wide(path.parent()?))?
    };
    Some(meta_from(&name, &entry, &volume))
}

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
    let ticks = m.last_write_time() as i64;
    Meta {
        dev: 0,
        ino: 0,
        nlink: 1,
        blocks: m.file_size().div_ceil(512),
        size: m.file_size(),
        mtime: (ticks - EPOCH_AS_FILETIME).div_euclid(TICKS_PER_SECOND),
        kind,
    }
}
