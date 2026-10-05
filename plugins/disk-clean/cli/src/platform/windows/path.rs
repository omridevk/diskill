use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use windows::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{FOLDERID_Profile, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
use windows::core::GUID;

const VERBATIM: &str = r"\\?\";

pub fn raw_home() -> String {
    match std::env::var("USERPROFILE") {
        Ok(home) => home.replace('\\', "/"),
        Err(std::env::VarError::NotPresent) => known_folder(&FOLDERID_Profile).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

pub fn path_text(p: &Path) -> Option<String> {
    let s = p.to_str()?;
    let s = s.strip_prefix(VERBATIM).unwrap_or(s).replace('\\', "/");
    let b = s.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
        .then(|| format!("{}{}", s[..1].to_ascii_uppercase(), &s[1..]))
}

pub fn split_root(p: &str) -> Option<(&str, &str)> {
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_uppercase() && b[1] == b':' && b[2] == b'/')
        .then(|| p.split_at(3))
}

pub(super) fn wide(p: &Path) -> Vec<u16> {
    let raw: Vec<u16> = p
        .as_os_str()
        .encode_wide()
        .map(|c| {
            if c == u16::from(b'/') {
                u16::from(b'\\')
            } else {
                c
            }
        })
        .collect();
    let mut out: Vec<u16> = if raw.starts_with(&[92, 92]) || raw.get(1).is_none_or(|c| *c != 58) {
        raw
    } else {
        VERBATIM.encode_utf16().chain(raw).collect()
    };
    out.push(0);
    out
}

pub(super) fn from_wide(buf: &[u16]) -> OsString {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..end])
}

pub(super) fn known_folder(id: &GUID) -> Option<String> {
    static RESOLVED: Mutex<Vec<(GUID, Option<String>)>> = Mutex::new(Vec::new());
    let mut resolved = RESOLVED.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((_, path)) = resolved.iter().find(|(known, _)| known == id) {
        return path.clone();
    }
    let path = resolve_known_folder(id);
    resolved.push((*id, path.clone()));
    path
}

fn resolve_known_folder(id: &GUID) -> Option<String> {
    // SAFETY: SHGetKnownFolderPath returns a NUL-terminated string we read once and free with CoTaskMemFree.
    let text = unsafe {
        let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let text = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        text?
    };
    path_text(Path::new(&text))
}

pub(super) fn user_folder(var: &str, id: &GUID) -> Option<String> {
    match std::env::var_os(var) {
        Some(v) => path_text(Path::new(&v)),
        None => known_folder(id),
    }
}

pub(super) fn same_text(a: &str, b: &str) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    // SAFETY: CompareStringOrdinal only reads the two slices.
    unsafe { CompareStringOrdinal(&a, &b, true) == CSTR_EQUAL }
}

pub(super) fn within(p: &str, root: &str) -> bool {
    let (p16, root16): (Vec<u16>, Vec<u16>) =
        (p.encode_utf16().collect(), root.encode_utf16().collect());
    p16.len() > root16.len()
        && p16[root16.len()] == u16::from(b'/')
        // SAFETY: CompareStringOrdinal only reads the two slices.
        && unsafe { CompareStringOrdinal(&p16[..root16.len()], &root16, true) == CSTR_EQUAL }
}

pub(super) fn rel_of(p: &str, root: &str) -> Option<String> {
    let skip = root.encode_utf16().count() + 1;
    within(p, root)
        .then(|| String::from_utf16(&p.encode_utf16().skip(skip).collect::<Vec<u16>>()).ok())?
}

pub(super) fn at_or_within(p: &str, root: &str) -> bool {
    same_text(p, root) || within(p, root)
}
