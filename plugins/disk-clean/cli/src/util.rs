use std::ffi::{CStr, CString};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;

static HOME: OnceLock<Result<String, String>> = OnceLock::new();

fn resolve_home(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("HOME is empty".to_string());
    }
    if !raw.starts_with('/') {
        return Err(format!("HOME is not an absolute path: {raw}"));
    }
    let real = fs::canonicalize(raw).map_err(|e| format!("HOME {raw} cannot be resolved: {e}"))?;
    match real.to_str() {
        Some(s) if real.is_dir() && s != "/" => Ok(s.to_string()),
        _ => Err(format!("HOME {raw} is not a usable home folder")),
    }
}

pub fn checked_home() -> Result<String, String> {
    HOME.get_or_init(|| resolve_home(&std::env::var("HOME").unwrap_or_default()))
        .clone()
}

pub fn home() -> String {
    checked_home().unwrap_or_default()
}

pub fn env_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v.trim().parse().unwrap_or(default),
        _ => default,
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn local_time(fmt: &CStr) -> String {
    let mut buf = [0u8; 64];
    // SAFETY: time/localtime_r/strftime write only into the locals passed to them.
    let len = unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        libc::strftime(buf.as_mut_ptr().cast(), buf.len(), fmt.as_ptr(), &tm)
    };
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

pub struct VolumeStats {
    pub total: u64,
    pub used: u64,
    pub avail: u64,
}

pub fn volume_stats(path: &Path) -> Option<VolumeStats> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statfs fills the zeroed struct; we read it only on success.
    let s = unsafe {
        let mut s: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        s
    };
    let bsize = s.f_bsize as u64;
    let kb = |n: u64| n * bsize / 1024 * 1024;
    let used = match space_used(&c) {
        Some(bytes) => bytes / 1024 * 1024,
        None => kb(s.f_blocks.saturating_sub(s.f_bfree)),
    };
    Some(VolumeStats {
        total: kb(s.f_blocks),
        used,
        avail: kb(s.f_bavail),
    })
}

fn space_used(path: &CStr) -> Option<u64> {
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_SPACEUSED,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buf = [0u8; 16];
    // SAFETY: getattrlist writes at most buf.len() bytes into buf.
    let rc = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            (&mut list as *mut libc::attrlist).cast(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
        )
    };
    let bytes: [u8; 8] = buf[4..12].try_into().ok()?;
    (rc == 0).then(|| i64::from_ne_bytes(bytes).max(0) as u64)
}

pub fn data_mount() -> PathBuf {
    let data = Path::new("/System/Volumes/Data");
    if data.is_dir() && volume_stats(data).is_some() {
        data.to_path_buf()
    } else {
        PathBuf::from("/")
    }
}

pub fn free_bytes() -> u64 {
    volume_stats(&data_mount()).map(|s| s.avail).unwrap_or(0)
}

pub fn which(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            fs::metadata(dir.join(name)).is_ok_and(|m| {
                m.is_file()
                    && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0
            })
        })
    })
}

pub fn output(program: &str, args: &[&str]) -> Option<(bool, String)> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

pub fn user_tmp_base() -> Option<String> {
    let (ok, out) = output("getconf", &["DARWIN_USER_TEMP_DIR"])?;
    let d = out.trim_end_matches('\n');
    if !ok || d.is_empty() {
        return None;
    }
    let d = d.strip_suffix('/').unwrap_or(d);
    let parent = Path::new(d).parent()?.to_str()?.to_string();
    if parent.starts_with("/var/folders/") {
        Some(format!("/private{parent}"))
    } else if parent.starts_with("/private/var/folders/") {
        Some(parent)
    } else {
        None
    }
}

pub fn tilde(path: &str, home: &str) -> String {
    match path.strip_prefix(home) {
        Some(rest) if !home.is_empty() => format!("~{rest}"),
        _ => path.to_string(),
    }
}

pub fn realpath(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => realpath(parent).join(name),
        _ => path.to_path_buf(),
    }
}

pub fn read_lines(path: &Path) -> Vec<String> {
    fs::read(path)
        .map(|b| {
            String::from_utf8_lossy(&b)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn complete_lines(path: &Path) -> Vec<String> {
    let bytes = fs::read(path).unwrap_or_default();
    let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    String::from_utf8_lossy(&bytes[..end])
        .lines()
        .map(str::to_string)
        .collect()
}

pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&staged, contents)?;
    fs::rename(&staged, path)
}

pub fn spawn_detached(cmd: &mut Command) -> io::Result<Child> {
    // SAFETY: setsid is async-signal-safe and only detaches the child into its own session.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn()
}

pub fn in_parallel<T: Sync>(items: &[T], workers: usize, each: impl Fn(&T) + Sync) {
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..workers.max(1) {
            s.spawn(|| {
                while let Some(item) =
                    items.get(next.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
                {
                    each(item);
                }
            });
        }
    });
}
