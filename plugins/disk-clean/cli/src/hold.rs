use crate::clean;
use crate::util;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ffi::CString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

const MANIFEST: &str = "manifest.jsonl";
const LOCK: &str = "lock";
const DAY: i64 = 86_400;
const LOCK_TRIES: usize = 50;
const RENAME_NOFOLLOW_ANY: libc::c_uint = 0x10;
pub const STILL_THERE: &str = "the original path exists again, so the held copy stays held";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    pub original: String,
    pub held: String,
    pub bytes: i64,
    pub held_at: i64,
    pub dev: u64,
    pub ino: u64,
}

pub type Emit<'a> = &'a (dyn Fn(&str, Value) + Sync);

pub fn hold_days() -> i64 {
    util::env_num("DISK_CLEAN_HOLD_DAYS", 7i64).max(0)
}

pub fn root(home: &str) -> PathBuf {
    PathBuf::from(format!("{home}/.cache/disk-clean/held"))
}

fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

pub fn run_id(run_dir: &Path) -> String {
    let real = util::realpath(run_dir);
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| {
            n.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .unwrap_or_else(|| "run".to_string());
    format!("{name}-{:08x}", fnv(&real.to_string_lossy()) as u32)
}

pub fn dir_of(home: &str, run_dir: &Path) -> PathBuf {
    root(home).join(run_id(run_dir))
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
        && fs::canonicalize(path).is_ok_and(|real| real == path)
}

fn checked_dir(dir: &Path) -> io::Result<()> {
    if is_real_dir(dir) {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} is not a plain folder (a symlink or moved), not touched",
            dir.display()
        )))
    }
}

fn make_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    checked_dir(dir)
}

pub fn read(dir: &Path) -> Vec<Entry> {
    util::read_lines(&dir.join(MANIFEST))
        .iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn write_all(dir: &Path, entries: &[Entry]) -> io::Result<()> {
    let path = dir.join(MANIFEST);
    if entries.is_empty() {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let text: String = entries
        .iter()
        .filter_map(|e| serde_json::to_string(e).ok())
        .map(|line| line + "\n")
        .collect();
    let tmp = dir.join(format!("{MANIFEST}.tmp"));
    let _ = fs::remove_file(&tmp);
    no_follow()
        .create_new(true)
        .write(true)
        .open(&tmp)?
        .write_all(text.as_bytes())?;
    fs::rename(tmp, path)
}

fn no_follow() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.custom_flags(libc::O_NOFOLLOW);
    options
}

fn append(dir: &Path, entry: &Entry) -> io::Result<()> {
    let path = dir.join(MANIFEST);
    let mut file = no_follow().create(true).append(true).open(&path)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(entry).map_err(io::Error::other)?
    )
}

fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: renamex_np only reads the two NUL-terminated paths.
    let rc = unsafe {
        libc::renamex_np(
            from.as_ptr(),
            to.as_ptr(),
            libc::RENAME_EXCL | RENAME_NOFOLLOW_ANY,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn why_not_moved(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::EXDEV) => "on another volume than the holding folder".to_string(),
        Some(libc::EACCES | libc::EPERM) => "permission denied".to_string(),
        Some(libc::EEXIST | libc::ENOTEMPTY) => "the destination already exists".to_string(),
        _ => e.to_string(),
    }
}

pub fn lock(dir: &Path, tries: usize) -> io::Result<Option<fs::File>> {
    let path = dir.join(LOCK);
    let file = no_follow()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)?;
    for attempt in 0..tries.max(1) {
        if file.try_lock().is_ok() {
            return Ok(Some(file));
        }
        if attempt + 1 < tries {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(None)
}

pub struct Holder {
    dir: PathBuf,
    next: usize,
    entries: Vec<Entry>,
    _lock: fs::File,
}

fn next_number(dir: &Path, entries: &[Entry]) -> usize {
    let used = entries
        .iter()
        .filter_map(|e| {
            Path::new(&e.held)
                .file_name()?
                .to_str()?
                .parse::<usize>()
                .ok()
        })
        .max()
        .map_or(1, |n| n + 1);
    (used..)
        .find(|n| fs::symlink_metadata(dir.join(n.to_string())).is_err())
        .unwrap_or(used)
}

pub fn planned_targets(home: &str, run_dir: &Path, count: usize) -> Vec<String> {
    let dir = dir_of(home, run_dir);
    let first = next_number(&dir, &read(&dir));
    (first..first + count)
        .map(|n| dir.join(n.to_string()).to_string_lossy().into_owned())
        .collect()
}

impl Holder {
    pub fn open(home: &str, run_dir: &Path) -> io::Result<Holder> {
        let dir = dir_of(home, run_dir);
        make_dir(&dir)?;
        let lock = lock(&dir, LOCK_TRIES)?
            .ok_or_else(|| io::Error::other("the held items of this run are busy"))?;
        let entries = read(&dir);
        let next = next_number(&dir, &entries);
        Ok(Holder {
            dir,
            next,
            entries,
            _lock: lock,
        })
    }

    pub fn hold(&mut self, original: &str, bytes: i64) -> Result<String, String> {
        let meta = fs::symlink_metadata(original).map_err(|e| e.kind().to_string())?;
        while fs::symlink_metadata(self.dir.join(self.next.to_string())).is_ok() {
            self.next += 1;
        }
        let held = self.dir.join(self.next.to_string());
        let entry = Entry {
            original: original.to_string(),
            held: held.to_string_lossy().into_owned(),
            bytes,
            held_at: util::now(),
            dev: meta.dev(),
            ino: meta.ino(),
        };
        append(&self.dir, &entry).map_err(|e| format!("the manifest could not be written: {e}"))?;
        self.entries.push(entry);
        match rename_excl(Path::new(original), &held) {
            Ok(()) => {
                self.next += 1;
                Ok(held.to_string_lossy().into_owned())
            }
            Err(e) => {
                self.entries.pop();
                let _ = write_all(&self.dir, &self.entries);
                Err(why_not_moved(&e))
            }
        }
    }

    pub fn until(&self) -> Option<i64> {
        until_of(&self.entries)
    }
}

fn until_of(entries: &[Entry]) -> Option<i64> {
    entries
        .iter()
        .map(|e| e.held_at)
        .max()
        .map(|newest| newest + hold_days() * DAY)
}

fn held_copy_problem(dir: &Path, entry: &Entry) -> Option<&'static str> {
    let held = Path::new(&entry.held);
    let numbered = held
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if held.parent() != Some(dir) || !numbered {
        return Some("the manifest names a path outside its holding folder, not touched");
    }
    if !is_real_dir(dir) {
        return Some("the holding folder was moved or replaced, not touched");
    }
    match fs::symlink_metadata(held) {
        Err(_) => Some("gone"),
        Ok(m) if m.dev() != entry.dev || m.ino() != entry.ino => {
            Some("the held copy was replaced after it was held, not touched")
        }
        Ok(_) => None,
    }
}

fn restore_problem(entry: &Entry, home: &str, tmp_base: Option<&str>) -> Option<&'static str> {
    if !clean::is_allowed(&entry.original, home, tmp_base) {
        return Some("the original path is protected, not restored");
    }
    let original = Path::new(&entry.original);
    let (Some(parent), Some(name)) = (original.parent(), original.file_name()) else {
        return Some("not a canonical path");
    };
    match fs::canonicalize(parent) {
        Ok(real) if real.join(name) == original => None,
        Ok(_) => Some("the original folder now resolves elsewhere, the held copy stays held"),
        Err(_) => Some("the original folder is gone, the held copy stays held"),
    }
}

pub struct Report {
    pub done: usize,
    pub done_bytes: i64,
    pub kept: usize,
    pub left: usize,
}

fn job_id() -> String {
    format!("{}-{}", util::now(), std::process::id())
}

fn item(entry: &Entry, job: &str, outcome: &str, reason: &str) -> Value {
    json!({
        "job": job,
        "path": entry.original,
        "held_path": entry.held,
        "bytes": entry.bytes,
        "outcome": outcome,
        "reason": reason,
    })
}

fn finish(dir: &Path, left: &[Entry]) -> io::Result<()> {
    write_all(dir, left)?;
    if left.is_empty() {
        let _ = fs::remove_file(dir.join(LOCK));
        let _ = fs::remove_dir(dir);
    }
    Ok(())
}

pub fn undo(dir: &Path, home: &str, emit: Emit) -> io::Result<Report> {
    checked_dir(dir)?;
    let tmp_base = util::user_tmp_base();
    let entries = read(dir);
    let job = job_id();
    emit(
        "undo_started",
        json!({"job": job, "count": entries.len(), "bytes": entries.iter().map(|e| e.bytes).sum::<i64>()}),
    );
    let mut left = Vec::new();
    let (mut done, mut done_bytes, mut kept) = (0, 0, 0);
    for entry in entries {
        if let Some(problem) = held_copy_problem(dir, &entry) {
            if problem == "gone" {
                emit("undone", item(&entry, &job, "gone", "already freed"));
                continue;
            }
            emit("undone", item(&entry, &job, "kept", problem));
            kept += 1;
            left.push(entry);
            continue;
        }
        let moved = match restore_problem(&entry, home, tmp_base.as_deref()) {
            Some(problem) => Err(problem.to_string()),
            None => {
                rename_excl(Path::new(&entry.held), Path::new(&entry.original)).map_err(|e| match e
                    .raw_os_error()
                {
                    Some(libc::EEXIST | libc::ENOTEMPTY) => STILL_THERE.to_string(),
                    _ => format!("{}, the held copy stays held", why_not_moved(&e)),
                })
            }
        };
        match moved {
            Ok(()) => {
                emit("undone", item(&entry, &job, "restored", ""));
                done += 1;
                done_bytes += entry.bytes;
            }
            Err(reason) => {
                emit("undone", item(&entry, &job, "kept", &reason));
                kept += 1;
                left.push(entry);
            }
        }
    }
    finish(dir, &left)?;
    let report = Report {
        done,
        done_bytes,
        kept,
        left: left.len(),
    };
    emit(
        "undo_done",
        json!({"job": job, "restored": done, "restored_bytes": done_bytes, "kept": kept, "held": left.len(), "held_bytes": left.iter().map(|e| e.bytes).sum::<i64>()}),
    );
    Ok(report)
}

pub fn free(dir: &Path, emit: Emit) -> io::Result<Report> {
    checked_dir(dir)?;
    let entries = read(dir);
    let job = job_id();
    let parallel = util::env_num("DISK_CLEAN_PARALLEL", 4usize).max(1);
    let free_before = util::free_bytes() as i64;
    emit(
        "free_started",
        json!({"job": job, "count": entries.len(), "bytes": entries.iter().map(|e| e.bytes).sum::<i64>(), "free": free_before}),
    );
    let left = Mutex::new(Vec::new());
    let (done, done_bytes, kept) = (AtomicUsize::new(0), AtomicI64::new(0), AtomicUsize::new(0));
    util::in_parallel(&entries, parallel, |entry| {
        let outcome = match held_copy_problem(dir, entry) {
            Some("gone") => Ok(()),
            Some(problem) => Err(problem.to_string()),
            None => {
                let result = clean::remove_path(Path::new(&entry.held));
                match (fs::symlink_metadata(&entry.held).is_ok(), result) {
                    (false, _) => Ok(()),
                    (true, Err(e)) => Err(format!("could not delete: {}", e.kind())),
                    (true, Ok(())) => Err("still present after removal".to_string()),
                }
            }
        };
        match outcome {
            Ok(()) => {
                done.fetch_add(1, Ordering::SeqCst);
                done_bytes.fetch_add(entry.bytes, Ordering::SeqCst);
                emit("freed", item(entry, &job, "freed", ""));
            }
            Err(reason) => {
                kept.fetch_add(1, Ordering::SeqCst);
                emit("freed", item(entry, &job, "kept", &reason));
                if let Ok(mut left) = left.lock() {
                    left.push(entry.clone());
                }
            }
        }
    });
    let left = left.into_inner().unwrap_or_default();
    finish(dir, &left)?;
    let report = Report {
        done: done.into_inner(),
        done_bytes: done_bytes.into_inner(),
        kept: kept.into_inner(),
        left: left.len(),
    };
    emit(
        "free_done",
        json!({
            "job": job,
            "freed": report.done,
            "freed_bytes": report.done_bytes,
            "kept": report.kept,
            "held": report.left,
            "held_bytes": left.iter().map(|e| e.bytes).sum::<i64>(),
            "free_before": free_before,
            "free_after": util::free_bytes() as i64,
        }),
    );
    Ok(report)
}

pub fn runs(home: &str) -> Vec<(PathBuf, Vec<Entry>)> {
    let Ok(list) = fs::read_dir(root(home)) else {
        return Vec::new();
    };
    let mut runs: Vec<(PathBuf, Vec<Entry>)> = list
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_real_dir(p))
        .map(|p| {
            let entries = read(&p);
            (p, entries)
        })
        .filter(|(_, entries)| !entries.is_empty())
        .collect();
    runs.sort_by(|a, b| a.0.cmp(&b.0));
    runs
}

pub fn held_dir(home: &str, run_dir: &Path) -> Option<PathBuf> {
    let dir = dir_of(home, run_dir);
    (is_real_dir(&dir) && !read(&dir).is_empty()).then_some(dir)
}

pub fn is_held_run(path: &str, home: &str) -> bool {
    let path = Path::new(path);
    path.parent() == Some(root(home).as_path()) && is_real_dir(path) && !read(path).is_empty()
}

pub fn expire(home: &str) {
    let days = hold_days();
    let now = util::now();
    for (dir, entries) in runs(home) {
        let Some(until) = until_of(&entries) else {
            continue;
        };
        if now < until {
            continue;
        }
        let Ok(Some(_lock)) = lock(&dir, 1) else {
            continue;
        };
        match free(&dir, &|_, _| {}) {
            Ok(r) => eprintln!(
                "disk-clean: freed {} held items ({} bytes) held more than {days} days in {}{}",
                r.done,
                r.done_bytes,
                dir.display(),
                if r.kept > 0 {
                    format!(", {} could not be freed", r.kept)
                } else {
                    String::new()
                }
            ),
            Err(e) => eprintln!("disk-clean: could not free {}: {e}", dir.display()),
        }
    }
}

pub fn date(epoch: i64) -> String {
    let mut buf = [0u8; 64];
    let t: libc::time_t = epoch;
    // SAFETY: localtime_r/strftime write only into the locals passed to them.
    let len = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        libc::strftime(
            buf.as_mut_ptr().cast(),
            buf.len(),
            c"%Y-%m-%d %H:%M".as_ptr(),
            &tm,
        )
    };
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

fn job(name: &str, run_dir: Option<String>) -> io::Result<i32> {
    let Some(run_dir) = run_dir.filter(|d| !d.is_empty()) else {
        eprintln!("usage: disk-clean {name} RUN_DIR");
        return Ok(2);
    };
    let run = Path::new(&run_dir);
    if !run.is_dir() {
        eprintln!("no run directory at {run_dir}");
        return Ok(2);
    }
    let home = util::home();
    let Some(dir) = held_dir(&home, run) else {
        eprintln!("nothing is held for {run_dir}");
        return Ok(3);
    };
    let Some(_lock) = lock(&dir, LOCK_TRIES)? else {
        eprintln!("the held items of {run_dir} are busy (another undo, free or clean)");
        return Ok(4);
    };
    let r = run_job(name, run, &dir, &home)?;
    let verb = if name == "undo" { "restored" } else { "freed" };
    println!("{verb}: {} items, {} bytes", r.done, r.done_bytes);
    println!("still held: {}", r.left);
    Ok(0)
}

pub fn run_job(name: &str, run_dir: &Path, dir: &Path, home: &str) -> io::Result<Report> {
    let events = clean::Events::append(run_dir);
    let emit = |event: &str, data: Value| events.emit(event, data);
    if name == "undo" {
        undo(dir, home, &emit)
    } else {
        free(dir, &emit)
    }
}

pub fn run_undo(run_dir: Option<String>) -> io::Result<i32> {
    job("undo", run_dir)
}

pub fn run_free(run_dir: Option<String>) -> io::Result<i32> {
    job("free", run_dir)
}
