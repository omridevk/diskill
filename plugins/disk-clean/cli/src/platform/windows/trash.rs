use std::cell::RefCell;
use std::fs;
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{
    ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, ERROR_SUCCESS, HANDLE, HLOCAL, LocalFree,
};
use windows::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FileIdInfo, GetDriveTypeW, GetFileInformationByHandleEx, GetVolumeInformationW,
    GetVolumePathNameW, MOVE_FILE_FLAGS, MoveFileExW, SetFileAttributesW,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::RestartManager::{
    CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmEndSession, RmGetList, RmRegisterResources,
    RmStartSession,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::{
    COPYENGINE_E_SHARING_VIOLATION_SRC, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    FOF_WANTNUKEWARNING, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
    IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
    SHCreateItemFromParsingName, SHQUERYRBINFO, SHQueryRecycleBinW, SIGDN_FILESYSPATH,
};
use windows::core::{ComObject, HRESULT, HSTRING, PCWSTR, PWSTR, Ref, implement};

pub const RESTORE_BY_HAND: &str = "Restore in the Recycle Bin";

const RECYCLE_BIN: &str = "$Recycle.Bin";
const DRIVE_FIXED: u32 = 3;
const NO_BIN: &str = "this drive has no Recycle Bin";
const DELETED_FOR_GOOD: &str = "deleted for good: the Recycle Bin did not keep it";

#[derive(Clone)]
pub struct Checked {
    pub path: String,
    pub dev: u64,
    pub ino: u64,
    pub ino_hi: u64,
}

fn long(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if text.starts_with(r"\\?\") || !path.is_absolute() {
        return path.to_path_buf();
    }
    PathBuf::from(format!(r"\\?\{}", text.replace('/', "\\")))
}

fn shell_form(path: &str) -> String {
    path.replace('/', "\\")
}

fn record_form(path: &str) -> String {
    let path = path
        .strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace('\\', "/");
    match path.as_bytes() {
        [drive, b':', ..] => format!("{}{}", char::from(*drive).to_ascii_uppercase(), &path[1..]),
        _ => path,
    }
}

fn io_error(e: windows::core::Error) -> io::Error {
    let code = e.code().0 as u32;
    if code >> 16 == 0x8007 {
        io::Error::from_raw_os_error((code & 0xFFFF) as i32)
    } else {
        io::Error::other(e)
    }
}

fn same_name(a: &str, b: &str) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    // SAFETY: CompareStringOrdinal only reads the two slices it is given with their lengths.
    unsafe { CompareStringOrdinal(&a, &b, true) == CSTR_EQUAL }
}

fn user_sid() -> Option<String> {
    let mut token = HANDLE::default();
    // SAFETY: the pseudo handle of this process needs no closing; token receives a new handle.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.ok()?;
    // SAFETY: OpenProcessToken succeeded, so token is an open handle owned by nobody else.
    let owned = unsafe { OwnedHandle::from_raw_handle(token.0) };
    let token = HANDLE(owned.as_raw_handle());
    let mut len = 0u32;
    // SAFETY: a null buffer of length 0 only asks for the needed length.
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut len) };
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: buf is 8-byte aligned and at least len bytes long.
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            len,
            &mut len,
        )
    }
    .ok()?;
    // SAFETY: GetTokenInformation(TokenUser) filled buf with a TOKEN_USER whose SID lives in buf.
    let user = unsafe { &*buf.as_ptr().cast::<TOKEN_USER>() };
    let mut text = PWSTR::null();
    // SAFETY: the SID is valid while buf lives; text receives a LocalAlloc'd string.
    unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) }.ok()?;
    // SAFETY: text is a NUL-terminated string from ConvertSidToStringSidW, freed once with LocalFree.
    unsafe {
        let sid = text.to_string().ok();
        LocalFree(Some(HLOCAL(text.0.cast())));
        sid
    }
}

fn is_fixed_drive(root: &str) -> bool {
    // SAFETY: GetDriveTypeW only reads the NUL-terminated root path.
    unsafe { GetDriveTypeW(&HSTRING::from(root)) == DRIVE_FIXED }
}

fn is_plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(long(path))
        .is_ok_and(|m| m.is_dir() && m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0)
}

pub fn no_follow() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
    options
}

pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(long(dir))
}

pub fn uid() -> u32 {
    0
}

pub fn dev_and_ino(path: &str) -> io::Result<(u64, u64, u64)> {
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
        .open(long(Path::new(path)))?;
    let mut info = FILE_ID_INFO::default();
    // SAFETY: file is an open handle and info is a FILE_ID_INFO of the size passed.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(io_error)?;
    let id = u128::from_le_bytes(info.FileId.Identifier);
    Ok((info.VolumeSerialNumber, id as u64, (id >> 64) as u64))
}

pub fn same_item(path: &str, dev: u64, ino: u64, ino_hi: u64) -> Option<bool> {
    dev_and_ino(path).ok().map(|id| id == (dev, ino, ino_hi))
}

pub fn is_trash_dir(dir: &Path, _home: &str) -> bool {
    let text = dir.to_string_lossy();
    let [drive, bin, sid] = text.split('/').collect::<Vec<_>>()[..] else {
        return false;
    };
    let drive_letter = matches!(drive.as_bytes(), [letter, b':'] if letter.is_ascii_alphabetic());
    drive_letter
        && same_name(bin, RECYCLE_BIN)
        && user_sid().is_some_and(|me| same_name(sid, &me))
        && is_fixed_drive(&format!("{drive}\\"))
        && is_plain_dir(Path::new(&format!("{drive}/{bin}")))
        && is_plain_dir(dir)
}

fn until_nul(text: &[u16]) -> String {
    let len = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    String::from_utf16_lossy(&text[..len])
}

fn recycle_bin(path: &Path) -> Option<()> {
    let mut root = vec![0u16; 1024];
    // SAFETY: GetVolumePathNameW reads the NUL-terminated path and writes at most root.len() units.
    unsafe { GetVolumePathNameW(&HSTRING::from(long(path).as_path()), &mut root) }.ok()?;
    let root = until_nul(&root);
    let root = root.strip_prefix(r"\\?\").unwrap_or(&root);
    let drive_root =
        matches!(root.as_bytes(), [letter, b':', b'\\'] if letter.is_ascii_alphabetic());
    if !drive_root || !is_fixed_drive(root) {
        return None;
    }
    let root = HSTRING::from(root);
    let mut fs_name = [0u16; 261];
    // SAFETY: GetVolumeInformationW reads the NUL-terminated root and writes into fs_name only.
    unsafe { GetVolumeInformationW(&root, None, None, None, None, Some(&mut fs_name)) }.ok()?;
    if !["NTFS", "ReFS"].contains(&until_nul(&fs_name).as_str()) {
        return None;
    }
    let mut info = SHQUERYRBINFO {
        cbSize: size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: SHQueryRecycleBinW reads the NUL-terminated root and fills info, whose cbSize is set.
    unsafe { SHQueryRecycleBinW(&root, &mut info) }.ok()
}

fn holders(path: &str) -> Vec<String> {
    let mut session = 0u32;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    // SAFETY: key has room for CCH_RM_SESSION_KEY characters and the NUL.
    if unsafe { RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let names = holders_in(session, path);
    // SAFETY: session was started above and is ended once.
    let _ = unsafe { RmEndSession(session) };
    names
}

fn holders_in(session: u32, path: &str) -> Vec<String> {
    let file = HSTRING::from(path);
    // SAFETY: the one file name stays alive for the call.
    let registered =
        unsafe { RmRegisterResources(session, Some(&[PCWSTR(file.as_ptr())]), None, None) };
    if registered != ERROR_SUCCESS {
        return Vec::new();
    }
    let (mut needed, mut count, mut reasons) = (0u32, 0u32, 0u32);
    // SAFETY: a null list of length 0 only asks for the needed length.
    let _ = unsafe { RmGetList(session, &mut needed, &mut count, None, &mut reasons) };
    let mut list = vec![RM_PROCESS_INFO::default(); needed as usize];
    count = needed;
    // SAFETY: list holds count entries.
    let listed = unsafe {
        RmGetList(
            session,
            &mut needed,
            &mut count,
            Some(list.as_mut_ptr()),
            &mut reasons,
        )
    };
    if listed != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut names: Vec<String> = list
        .iter()
        .take(count as usize)
        .map(|p| until_nul(&p.strAppName))
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}

fn in_use(path: &str) -> String {
    let names = holders(path);
    if names.is_empty() {
        "in use by another program".to_string()
    } else {
        format!("in use: close {} and retry", names.join(", "))
    }
}

fn is_in_use(hr: HRESULT) -> bool {
    hr == HRESULT::from_win32(ERROR_SHARING_VIOLATION.0)
        || hr == HRESULT::from_win32(ERROR_LOCK_VIOLATION.0)
        || hr == COPYENGINE_E_SHARING_VIOLATION_SRC
}

fn path_of(item: &IShellItem) -> Option<String> {
    // SAFETY: GetDisplayName returns a CoTaskMemAlloc'd string, copied here and freed once.
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = name.to_string().ok();
        CoTaskMemFree(Some(name.0.cast_const().cast()));
        text
    }
}

#[implement(IFileOperationProgressSink)]
struct Sink {
    path: String,
    seen: RefCell<Option<(HRESULT, Option<String>)>>,
}

impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, _: u32, _: Ref<IShellItem>) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _: u32,
        item: Ref<IShellItem>,
        hr: HRESULT,
        created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        let ours = item
            .as_ref()
            .and_then(path_of)
            .is_some_and(|p| same_name(&p, &self.path));
        if ours {
            self.seen
                .replace(Some((hr, created.as_ref().and_then(path_of))));
        }
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

fn recycle(path: &str) -> Result<String, String> {
    let refused = |e: windows::core::Error| e.message();
    let sink = ComObject::new(Sink {
        path: path.to_string(),
        seen: RefCell::new(None),
    });
    // SAFETY: call_trash initialised COM apartment-threaded on this thread; every object made
    // here is released before this function returns.
    let done = unsafe {
        let op: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(refused)?;
        let item: IShellItem =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(refused)?;
        op.SetOperationFlags(
            FOFX_RECYCLEONDELETE
                | FOF_NOCONFIRMATION
                | FOF_SILENT
                | FOF_NOERRORUI
                | FOF_WANTNUKEWARNING,
        )
        .map_err(refused)?;
        op.DeleteItem(&item, &sink.to_interface::<IFileOperationProgressSink>())
            .map_err(refused)?;
        op.PerformOperations()
    };
    let seen = sink.seen.take();
    let hr = match (&seen, &done) {
        (Some((hr, _)), _) => *hr,
        (None, Err(e)) => e.code(),
        (None, Ok(())) => HRESULT(0),
    };
    if is_in_use(hr) {
        return Err(in_use(path));
    }
    hr.ok().map_err(refused)?;
    match seen {
        Some((_, Some(landed))) => Ok(record_form(&landed)),
        Some((_, None)) => Err(DELETED_FOR_GOOD.to_string()),
        None => Err("the Recycle Bin did not report the move".to_string()),
    }
}

fn trash_one(item: &Checked) -> Result<String, String> {
    if same_item(&item.path, item.dev, item.ino, item.ino_hi) != Some(true) {
        return Err("it changed after the check".to_string());
    }
    if recycle_bin(Path::new(&item.path)).is_none() {
        return Err(NO_BIN.to_string());
    }
    recycle(&shell_form(&item.path))
}

pub fn call_trash(paths: &[Checked]) -> Vec<Result<String, String>> {
    // SAFETY: no reserved pointer; a success is balanced by CoUninitialize below on this thread.
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if init.is_err() {
        let why = format!("the Recycle Bin could not be reached: {}", init.message());
        return paths.iter().map(|_| Err(why.clone())).collect();
    }
    let landed = paths.iter().map(trash_one).collect();
    // SAFETY: balances the successful CoInitializeEx above; trash_one released every COM object.
    unsafe { CoUninitialize() };
    landed
}

pub fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (
        HSTRING::from(long(from).as_path()),
        HSTRING::from(long(to).as_path()),
    );
    // SAFETY: MoveFileExW only reads the two NUL-terminated paths; no flag replaces or copies.
    unsafe { MoveFileExW(&from, &to, MOVE_FILE_FLAGS(0)) }.map_err(io_error)
}

pub fn make_removable(path: &Path) {
    let path = long(path);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return;
    };
    let attrs = meta.file_attributes();
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return;
    }
    if attrs & FILE_ATTRIBUTE_READONLY.0 != 0 {
        let cleared = match attrs & !FILE_ATTRIBUTE_READONLY.0 {
            0 => FILE_ATTRIBUTE_NORMAL,
            rest => FILE_FLAGS_AND_ATTRIBUTES(rest),
        };
        // SAFETY: SetFileAttributesW only reads the NUL-terminated path; the entry is no reparse point.
        let _ = unsafe { SetFileAttributesW(&HSTRING::from(path.as_path()), cleared) };
    }
    if !meta.is_dir() {
        return;
    }
    let Ok(list) = fs::read_dir(&path) else {
        return;
    };
    for entry in list.flatten() {
        make_removable(&entry.path());
    }
}

pub fn drop_trash_info(trashed: &Path) {
    let (Some(dir), Some(name)) = (
        trashed.parent(),
        trashed.file_name().and_then(|n| n.to_str()),
    ) else {
        return;
    };
    if let Some(rest) = name.strip_prefix("$R") {
        let _ = fs::remove_file(long(&dir.join(format!("$I{rest}"))));
    }
}
