use crate::util::{self, spawn};
use std::io;
use std::process::{Command, ExitStatus};

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
