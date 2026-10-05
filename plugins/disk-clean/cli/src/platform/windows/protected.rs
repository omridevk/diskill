use super::disk::is_fixed_drive;
use super::path::{at_or_within, known_folder, rel_of, same_text, user_folder, wide, within};
use super::walk::{CLOUD_ATTRS, find_one, is_cloud_tag};
use crate::platform::split_root;
use std::ffi::c_void;
use std::path::Path;
use std::sync::OnceLock;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows::Win32::Storage::FileSystem::GetLongPathNameW;
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_LocalAppData, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_RoamingAppData,
    FOLDERID_SkyDrive, FOLDERID_UserProfiles, FOLDERID_Videos, FOLDERID_Windows,
};
use windows::core::{GUID, PCWSTR, PWSTR};

const PERSONAL: &[(&GUID, &str)] = &[
    (&FOLDERID_Documents, "Documents"),
    (&FOLDERID_Desktop, "Desktop"),
    (&FOLDERID_Pictures, "Pictures"),
    (&FOLDERID_Music, "Music"),
    (&FOLDERID_Videos, "Videos"),
];
const IN_HOME: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".azure",
    ".claude",
    ".docker",
    ".cache/disk-clean",
    ".rustup",
    ".cargo/bin",
    ".pyenv/pyenv-win",
    ".vscode",
    ".vscode-shared",
];
const IN_ROAMING: &[&str] = &[
    "gnupg",
    "Microsoft/Protect",
    "Microsoft/Credentials",
    "Microsoft/Crypto",
    "Microsoft/SystemCertificates",
    "Mozilla/Firefox/Profiles",
    "Thunderbird/Profiles",
    "Bitwarden",
    "KeePass",
    "JetBrains",
    "npm",
    "nvm",
];
const IN_LOCAL: &[&str] = &[
    "Microsoft/Credentials",
    "Microsoft/Vault",
    "Microsoft/Outlook",
    "1Password",
    "Docker/wsl",
    "nvm",
    "Volta",
    "Android/Sdk",
    "Programs",
];
const ROOT_ENV: &[&str] = &[
    "OneDrive",
    "OneDriveConsumer",
    "OneDriveCommercial",
    "NVM_HOME",
    "NVM_SYMLINK",
    "VOLTA_HOME",
    "ANDROID_HOME",
];
const SCOOP_KEEP: &[&str] = &["apps", "persist", "shims", "buckets"];
const NEVER_EXTENSIONS: &[&str] = &["pst", "ost", "kdbx", "vhdx", "vhd"];
const BROWSER_CACHES: &[&str] = &[
    "*/Cache",
    "*/Code Cache",
    "*/GPUCache",
    "ShaderCache",
    "GrShaderCache",
];
const LOCAL_CACHES_ONLY: &[(&str, &[&str])] = &[
    ("Google/Chrome/User Data", BROWSER_CACHES),
    ("Microsoft/Edge/User Data", BROWSER_CACHES),
    ("Packages", &["*/TempState", "*/LocalCache"]),
    ("Microsoft/VisualStudio", &["*/ComponentModelCache"]),
];
const ROAMING_CACHES_ONLY: &[(&str, &[&str])] = &[
    (
        "Code",
        &["Cache", "CachedData", "Code Cache", "GPUCache", "logs"],
    ),
    (
        "Slack",
        &[
            "Cache",
            "Code Cache",
            "GPUCache",
            "Service Worker/CacheStorage",
        ],
    ),
    ("discord", &["Cache", "Code Cache", "GPUCache"]),
];
const SYSTEM: &[&GUID] = &[
    &FOLDERID_Windows,
    &FOLDERID_ProgramFiles,
    &FOLDERID_ProgramFilesX86,
    &FOLDERID_ProgramData,
];
pub(super) const RECYCLE_BIN: &str = "$Recycle.Bin";
const SYSTEM_VOLUME_INFORMATION: &str = "System Volume Information";

fn app_data(home: &str, var: &str, id: &GUID, default: &str) -> Vec<String> {
    let mut bases = vec![format!("{home}/{default}")];
    for base in [user_folder(var, id), known_folder(id)]
        .into_iter()
        .flatten()
    {
        if !bases.iter().any(|b| same_text(b, &base)) {
            bases.push(base);
        }
    }
    bases
}

fn local_bases(home: &str) -> Vec<String> {
    app_data(
        home,
        "LOCALAPPDATA",
        &FOLDERID_LocalAppData,
        "AppData/Local",
    )
}

fn roaming_bases(home: &str) -> Vec<String> {
    app_data(home, "APPDATA", &FOLDERID_RoamingAppData, "AppData/Roaming")
}

fn env_root(name: &str) -> Option<String> {
    std::env::var_os(name).and_then(|v| crate::platform::path_text(Path::new(&v)))
}

fn never_roots(home: &str) -> Vec<String> {
    let mut roots: Vec<String> = PERSONAL
        .iter()
        .flat_map(|(id, name)| [known_folder(id), Some(format!("{home}/{name}"))])
        .flatten()
        .collect();
    roots.extend(known_folder(&FOLDERID_SkyDrive));
    roots.push(format!("{home}/OneDrive"));
    roots.extend(ROOT_ENV.iter().filter_map(|name| env_root(name)));
    roots.extend(IN_HOME.iter().map(|rel| format!("{home}/{rel}")));
    let scoop = env_root("SCOOP").unwrap_or_else(|| format!("{home}/scoop"));
    roots.extend(SCOOP_KEEP.iter().map(|rel| format!("{scoop}/{rel}")));
    for base in roaming_bases(home) {
        roots.extend(IN_ROAMING.iter().map(|rel| format!("{base}/{rel}")));
    }
    for base in local_bases(home) {
        roots.extend(IN_LOCAL.iter().map(|rel| format!("{base}/{rel}")));
    }
    roots
}

fn matches(rel: &str, pattern: &str) -> bool {
    let (rel, pattern): (Vec<&str>, Vec<&str>) =
        (rel.split('/').collect(), pattern.split('/').collect());
    rel.len() >= pattern.len()
        && pattern
            .iter()
            .zip(&rel)
            .all(|(want, have)| *want == "*" || same_text(want, have))
}

fn outside_caches(p: &str, base: &str, rules: &[(&str, &[&str])]) -> bool {
    rules.iter().any(|(rel, caches)| {
        let root = format!("{base}/{rel}");
        same_text(p, &root)
            || rel_of(p, &root).is_some_and(|rel| !caches.iter().any(|c| matches(&rel, c)))
    })
}

fn short_name(p: &str) -> bool {
    let mut end = 0;
    for part in p.split('/') {
        end += part.len();
        if part.contains('~') {
            let prefix = wide(Path::new(&p[..end]));
            let mut long = vec![0u16; 32_768];
            // SAFETY: GetLongPathNameW reads the NUL-terminated prefix and writes at most long.len() characters into long.
            let len =
                unsafe { GetLongPathNameW(PCWSTR(prefix.as_ptr()), Some(&mut long)) } as usize;
            let resolved = (len > 0 && len < long.len())
                .then(|| {
                    crate::platform::path_text(Path::new(&super::path::from_wide(&long[..len])))
                })
                .flatten();
            if !resolved.is_some_and(|r| same_text(&r, &p[..end])) {
                return true;
            }
        }
        end += 1;
    }
    false
}

fn in_cloud(p: &str, home: &str) -> bool {
    let mut at = Path::new(p);
    loop {
        if find_one(at)
            .is_some_and(|(attrs, tag)| attrs & CLOUD_ATTRS != 0 || is_cloud_tag(attrs, tag))
        {
            return true;
        }
        match at.parent() {
            Some(up) if crate::platform::path_text(up).is_some_and(|u| within(&u, home)) => at = up,
            _ => return false,
        }
    }
}

pub fn is_protected(p: &str, home: &str) -> bool {
    if at_or_within(home, p) {
        return true;
    }
    let never_ext = Path::new(p)
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| NEVER_EXTENSIONS.iter().any(|n| x.eq_ignore_ascii_case(n)));
    let (local, roaming) = (local_bases(home), roaming_bases(home));
    let app_data_root = same_text(p, &format!("{home}/AppData"))
        || local.iter().chain(&roaming).any(|base| same_text(p, base));
    let caches_only = local
        .iter()
        .any(|base| outside_caches(p, base, LOCAL_CACHES_ONLY))
        || roaming
            .iter()
            .any(|base| outside_caches(p, base, ROAMING_CACHES_ONLY));
    never_ext
        || app_data_root
        || caches_only
        || never_roots(home).iter().any(|root| at_or_within(p, root))
        || short_name(p)
        || in_cloud(p, home)
}

fn in_own_recycle_bin(p: &str) -> bool {
    let (Some((root, rest)), Some(sid)) = (split_root(p), user_sid()) else {
        return false;
    };
    within(rest, &format!("{RECYCLE_BIN}/{sid}")) && is_fixed_drive(root)
}

fn in_system(p: &str, home: &str) -> bool {
    let Some((_, rest)) = split_root(p) else {
        return true;
    };
    let other_profile = known_folder(&FOLDERID_UserProfiles)
        .is_some_and(|users| within(p, &users) && !at_or_within(p, home));
    other_profile
        || at_or_within(rest, SYSTEM_VOLUME_INFORMATION)
        || (at_or_within(rest, RECYCLE_BIN) && !in_own_recycle_bin(p))
        || SYSTEM
            .iter()
            .filter_map(|id| known_folder(id))
            .any(|s| at_or_within(p, &s) && !at_or_within(home, &s))
}

pub fn in_allowed_root(p: &str, home: &str, tmp_base: Option<&str>) -> bool {
    let tmp_base = tmp_base.filter(|t| !t.is_empty());
    let temp_folder = local_bases(home)
        .iter()
        .map(|base| format!("{base}/Temp"))
        .chain(tmp_base.map(str::to_string))
        .any(|temp| at_or_within(p, &temp));
    let allowed = (within(p, home) && !temp_folder)
        || tmp_base.is_some_and(|t| within(p, t))
        || in_own_recycle_bin(p);
    allowed && !in_system(p, home)
}

fn token_user() -> Option<Vec<u64>> {
    let mut token = HANDLE::default();
    // SAFETY: OpenProcessToken writes the token handle of this process into the local.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()? };
    let mut len = 0u32;
    // SAFETY: the first call only reports the size the TOKEN_USER needs; the second writes at most len bytes into buf, which is 8-byte aligned for TOKEN_USER and at least len bytes long; the token is closed exactly once.
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let read = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast::<c_void>()),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        read.ok().map(|()| buf)
    }
}

fn user_sid_of(token_user: &[u64]) -> PSID {
    // SAFETY: token_user holds a TOKEN_USER written by GetTokenInformation, whose Sid points inside the same buffer.
    unsafe { (*token_user.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

pub(super) fn user_sid() -> Option<String> {
    static SID: OnceLock<Option<String>> = OnceLock::new();
    SID.get_or_init(|| {
        let user = token_user()?;
        let mut text = PWSTR::null();
        // SAFETY: ConvertSidToStringSidW reads the SID inside user and returns a LocalAlloc'd string we read once and free.
        unsafe {
            ConvertSidToStringSidW(user_sid_of(&user), &mut text).ok()?;
            let sid = text.to_string().ok();
            LocalFree(Some(HLOCAL(text.0.cast())));
            sid
        }
    })
    .clone()
}

pub(super) fn owned_by_user(path: &Path) -> bool {
    let Some(user) = token_user() else {
        return false;
    };
    let name = wide(path);
    let mut owner = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: GetNamedSecurityInfoW reads the NUL-terminated name and returns an owner SID pointing into a LocalAlloc'd descriptor, freed once after EqualSid reads both SIDs.
    unsafe {
        let read = GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut descriptor,
        );
        let same = read.is_ok() && EqualSid(owner, user_sid_of(&user)).is_ok();
        if !descriptor.0.is_null() {
            LocalFree(Some(HLOCAL(descriptor.0)));
        }
        same
    }
}
