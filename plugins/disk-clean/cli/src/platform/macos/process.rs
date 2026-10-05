use crate::util::{self, spawn};
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus};

const LOCK_FD: &str = "DISK_CLEAN_LOCK_FD";

pub fn utility_qos() {
    // SAFETY: pthread_set_qos_class_self_np only changes the calling thread's scheduling class.
    unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0) };
}

pub fn efficiency_cores() -> usize {
    let mut cores: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    // SAFETY: sysctlbyname writes at most len bytes into cores and updates len.
    let read = unsafe {
        libc::sysctlbyname(
            c"hw.perflevel1.logicalcpu".as_ptr(),
            (&mut cores as *mut libc::c_int).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    match usize::try_from(cores) {
        Ok(n) if read == 0 && n > 0 => n,
        _ => std::thread::available_parallelism().map_or(4, |n| (n.get() / 2).max(2)),
    }
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
    spawn(cmd)
}

pub fn pass_lock(cmd: &mut Command, lock: &fs::File) {
    let fd = lock.as_raw_fd();
    cmd.env(LOCK_FD, fd.to_string());
    // SAFETY: in the forked child, fcntl only clears close-on-exec on the lock fd so the worker inherits the lock.
    unsafe {
        cmd.pre_exec(move || match libc::fcntl(fd, libc::F_SETFD, 0) {
            -1 => Err(io::Error::last_os_error()),
            _ => Ok(()),
        });
    }
}

pub fn keep_lock_from_commands() {
    if let Some(fd) = std::env::var(LOCK_FD)
        .ok()
        .and_then(|v| v.parse::<RawFd>().ok())
    {
        // SAFETY: only sets close-on-exec on the inherited lock fd, so commands the worker runs never hold the lock.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}

pub fn open_in_browser(url: &str) -> io::Result<ExitStatus> {
    spawn(Command::new("open").arg(url)).and_then(|mut c| c.wait())
}

pub fn fill_random(buf: &mut [u8]) {
    // SAFETY: arc4random_buf fills exactly buf.len() bytes of the buffer.
    unsafe { libc::arc4random_buf(buf.as_mut_ptr().cast(), buf.len()) };
}

pub fn process_cwds() -> Vec<String> {
    let uid = crate::platform::uid().to_string();
    util::output("lsof", &["-a", "-d", "cwd", "-u", &uid, "-Fn"])
        .map(|(_, out)| {
            out.lines()
                .filter_map(|l| l.strip_prefix('n'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
