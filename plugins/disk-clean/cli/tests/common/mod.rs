#![allow(dead_code)]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

static OPENING_INHERITABLE_FDS: Mutex<()> = Mutex::new(());

pub fn with_fd_lock<T>(open: impl FnOnce() -> T) -> T {
    let _alone = OPENING_INHERITABLE_FDS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    open()
}

pub fn spawn(cmd: &mut Command) -> Child {
    with_fd_lock(|| cmd.spawn()).unwrap()
}

pub fn output(cmd: &mut Command) -> Output {
    spawn(
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .wait_with_output()
    .unwrap()
}

pub fn status(cmd: &mut Command) -> std::process::ExitStatus {
    spawn(cmd).wait().unwrap()
}

pub fn free_port() -> u16 {
    with_fd_lock(|| TcpListener::bind("127.0.0.1:0"))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

pub fn connect(port: u16) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match with_fd_lock(|| TcpStream::connect(("127.0.0.1", port))) {
            Ok(stream) => return stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("nothing listened on {port}: {e}"),
        }
    }
}

#[cfg(target_os = "macos")]
struct RamDisk {
    device: String,
    mount: PathBuf,
}

#[cfg(target_os = "linux")]
struct RamDisk {
    mount: PathBuf,
}

static RAM: OnceLock<RamDisk> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" fn detach_ram_disk() {
    if let Some(disk) = RAM.get() {
        let _ = Command::new("hdiutil")
            .args(["detach", "-force", &disk.device])
            .output();
    }
}

#[cfg(target_os = "macos")]
fn attach_ram_disk() -> RamDisk {
    let attach = output(Command::new("hdiutil").args(["attach", "-nomount", "ram://2097152"]));
    assert!(attach.status.success(), "hdiutil attach failed");
    let device = String::from_utf8_lossy(&attach.stdout).trim().to_string();
    assert!(
        device.starts_with("/dev/disk"),
        "unexpected device {device:?}"
    );
    let name = format!("dc-test-{}", std::process::id());
    let erased = output(Command::new("diskutil").args(["erasevolume", "APFS", &name, &device]));
    if !erased.status.success() {
        output(Command::new("hdiutil").args(["detach", "-force", &device]));
        panic!(
            "diskutil erasevolume failed: {}",
            String::from_utf8_lossy(&erased.stderr)
        );
    }
    let mount = std::fs::canonicalize(format!("/Volumes/{name}")).unwrap();
    std::fs::write(mount.join(".metadata_never_index"), b"").unwrap();
    RamDisk { device, mount }
}

#[cfg(target_os = "linux")]
fn as_root(program: &str) -> Command {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        return Command::new(program);
    }
    let mut sudo = Command::new("sudo");
    sudo.args(["-n", program]);
    sudo
}

#[cfg(target_os = "linux")]
fn mount_tmpfs(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let mounted = output(
        as_root("mount")
            .args(["-t", "tmpfs", "-o", "size=1g,mode=0777", "tmpfs"])
            .arg(dir),
    );
    assert!(
        mounted.status.success(),
        "mount -t tmpfs {} failed (needs root or passwordless sudo): {}",
        dir.display(),
        String::from_utf8_lossy(&mounted.stderr)
    );
}

#[cfg(target_os = "linux")]
fn unmount(dir: &Path) {
    let _ = as_root("umount").arg(dir).output();
    let _ = std::fs::remove_dir(dir);
}

#[cfg(target_os = "linux")]
extern "C" fn detach_ram_disk() {
    if let Some(disk) = RAM.get() {
        unmount(&disk.mount);
    }
}

#[cfg(target_os = "linux")]
fn attach_ram_disk() -> RamDisk {
    let dir =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("dc-test-{}", std::process::id()));
    mount_tmpfs(&dir);
    RamDisk {
        mount: std::fs::canonicalize(dir).unwrap(),
    }
}

#[cfg(target_os = "linux")]
pub struct OtherVolume(pub PathBuf);

#[cfg(target_os = "linux")]
impl Drop for OtherVolume {
    fn drop(&mut self) {
        unmount(&self.0);
    }
}

#[cfg(target_os = "linux")]
pub fn other_volume(dir: &Path) -> OtherVolume {
    assert_inside_ram_disk(dir.parent().unwrap());
    mount_tmpfs(dir);
    OtherVolume(std::fs::canonicalize(dir).unwrap())
}

pub fn ram_root() -> &'static Path {
    &RAM.get_or_init(|| {
        let disk = attach_ram_disk();
        // SAFETY: registers a plain extern "C" function to run at process exit.
        unsafe { libc::atexit(detach_ram_disk) };
        disk
    })
    .mount
}

pub fn assert_inside_ram_disk(path: &Path) {
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    assert!(
        real.starts_with(ram_root()),
        "{} is outside the test RAM disk {}",
        real.display(),
        ram_root().display()
    );
}

pub fn assert_record_inside_ram_disk(home: &Path) {
    let record =
        std::fs::read_to_string(home.join(".cache/disk-clean/trashed.jsonl")).unwrap_or_default();
    for line in record.lines() {
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        for key in ["original", "trashed"] {
            let path = entry[key].as_str().unwrap_or("");
            if !path.is_empty() {
                assert_inside_ram_disk(Path::new(path));
            }
        }
    }
}

pub fn bin(home: &Path) -> Command {
    assert_inside_ram_disk(home);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_disk-clean"));
    cmd.env("HOME", home)
        .env("TMPDIR", home)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    #[cfg(target_os = "linux")]
    cmd.env_remove("XDG_CACHE_HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME");
    cmd
}

pub struct TempDir(pub PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Reaped(pub std::process::Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl std::ops::Deref for Reaped {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Reaped {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

pub fn reaped(cmd: &mut Command) -> Reaped {
    Reaped(spawn(cmd))
}

pub fn temp_dir(tag: &str) -> TempDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = ram_root().join(format!("disk-clean-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(std::fs::canonicalize(&dir).unwrap())
}

pub fn sh(cwd: &Path, script: &str) {
    let status = status(
        Command::new("bash")
            .arg("-ec")
            .arg(script)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1"),
    );
    assert!(status.success(), "script failed: {script}");
}

pub fn cli(args: &[&str], home: &Path, env: &[(&str, &str)]) -> std::process::Output {
    output(bin(home).args(args).envs(env.iter().copied()))
}

pub fn wait_for(what: &str, limit: std::time::Duration, mut ready: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + limit;
    while !ready() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

pub fn events_of(run: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(run.join("clean.events"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[cfg(target_os = "macos")]
pub fn trash_dir(_home: &Path) -> PathBuf {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    ram_root().join(".Trashes").join(uid.to_string())
}

#[cfg(target_os = "linux")]
pub fn trash_dir(home: &Path) -> PathBuf {
    home.join(".local/share/Trash/files")
}

#[cfg(target_os = "macos")]
pub fn app_caches(home: &Path) -> PathBuf {
    home.join("Library/Caches")
}

#[cfg(target_os = "linux")]
pub fn app_caches(home: &Path) -> PathBuf {
    home.join(".cache")
}

#[cfg(target_os = "macos")]
pub fn local_day(secs: u64) -> String {
    let date = output(Command::new("date").args(["-r", &secs.to_string(), "+%Y-%m-%d"]));
    String::from_utf8(date.stdout).unwrap().trim().to_string()
}

#[cfg(target_os = "linux")]
pub fn local_day(secs: u64) -> String {
    let date = output(Command::new("date").args(["-d", &format!("@{secs}"), "+%Y-%m-%d"]));
    String::from_utf8(date.stdout).unwrap().trim().to_string()
}
