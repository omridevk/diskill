use crate::trash;
use crate::util;
use crate::worktrees;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

const FREE_EVERY: Duration = Duration::from_millis(500);
const EVENTS: &str = "clean.events";
const STATUS: &str = "status";
const LOCK: &str = "clean.lock";
const LOCK_FD: &str = "DISK_CLEAN_LOCK_FD";
const LOCK_TRIES: usize = 50;
const RECORD_TRIES: usize = 1500;
const ALREADY_RUNNING: i32 = 4;
pub const PATH_CHANGED: &str = "path changed since the scan";

const PERSONAL: &[&str] = &[
    "documents",
    "desktop",
    "pictures",
    "movies",
    "music",
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".claude",
    "library/mail",
    "library/messages",
];
const SYSTEM: &[&str] = &[
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var",
    "/private",
    "/opt",
];

const COMMANDS: &[(&str, &str, &[&str])] = &[
    (
        "xcode-unavailable-sims",
        "xcrun",
        &["simctl", "delete", "unavailable"],
    ),
    ("docker-prune", "docker", &["system", "prune", "-f"]),
    ("brew-cleanup", "brew", &["cleanup", "--prune=all", "-s"]),
];

fn command(id: &str) -> Option<(&'static str, &'static [&'static str])> {
    COMMANDS
        .iter()
        .find(|(known, _, _)| *known == id)
        .map(|(_, program, args)| (*program, *args))
}

fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-+=:@%,".contains(&b))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn shell_line(program: &str, args: &[&str]) -> String {
    std::iter::once(program)
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Trash,
    Now,
}

impl Mode {
    pub fn of(selection: &Value) -> Mode {
        match selection.get("mode").and_then(Value::as_str) {
            Some("now") => Mode::Now,
            _ => Mode::Trash,
        }
    }
}

pub fn already_trashed(path: &str, home: &str) -> bool {
    Path::new(path)
        .ancestors()
        .skip(1)
        .any(|dir| trash::is_trash_dir(dir, home))
}

#[derive(Default)]
pub struct Plan {
    pub rm: Vec<String>,
    pub worktrees: Vec<String>,
    pub cmds: Vec<String>,
    pub rejected: Vec<(String, String)>,
    pub bytes: i64,
    pub sizes: HashMap<String, i64>,
}

impl Plan {
    pub fn count(&self) -> usize {
        self.rm.len() + self.worktrees.len() + self.cmds.len()
    }

    pub fn size_of(&self, key: &str) -> i64 {
        self.sizes.get(key).copied().unwrap_or(0)
    }

    pub fn split(&self, mode: Mode, home: &str) -> (Vec<String>, Vec<String>) {
        self.rm
            .iter()
            .cloned()
            .partition(|path| mode == Mode::Trash && !already_trashed(path, home))
    }

    pub fn final_steps(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut repos: Vec<String> = Vec::new();
        for path in &self.worktrees {
            match worktrees::owning_repo(Path::new(path)) {
                Some(repo) => {
                    let repo = repo.to_string_lossy().into_owned();
                    out.push(shell_line(
                        "git",
                        &["-C", &repo, "worktree", "remove", path],
                    ));
                    if !repos.contains(&repo) {
                        repos.push(repo);
                    }
                }
                None => out.push(format!(
                    "# kept, not a registered worktree: {}",
                    shell_quote(path)
                )),
            }
        }
        out.extend(
            repos
                .iter()
                .map(|repo| shell_line("git", &["-C", repo, "worktree", "prune"])),
        );
        out.extend(
            self.cmds
                .iter()
                .filter_map(|id| command(id))
                .map(|(program, args)| shell_line(program, args)),
        );
        out
    }
}

pub type ScanIndex = HashMap<String, Vec<String>>;

pub fn index_scan(lines: &[String]) -> ScanIndex {
    let mut index = ScanIndex::new();
    for line in lines {
        let cols: Vec<&str> = line.split('\t').collect();
        if let [_, _, _, _, _, action, _, _, path, _, _, _, _] = cols.as_slice() {
            index
                .entry(path.to_string())
                .or_default()
                .push(action.to_string());
        }
    }
    index
}

pub fn plan(index: &ScanIndex, items: &[Value]) -> Plan {
    plan_in(index, items, &util::home())
}

pub fn plan_in(index: &ScanIndex, items: &[Value], home: &str) -> Plan {
    let home = home.to_string();
    let tmp_base = util::user_tmp_base();
    let mut plan = Plan::default();
    let mut seen = HashSet::new();
    for item in items {
        let action = item.get("action").and_then(Value::as_str).unwrap_or("rm");
        let key = if action == "cmd" { "cmd_id" } else { "path" };
        let Some(value) = item
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        if !seen.insert((action.to_string(), value.to_string())) {
            continue;
        }
        let bytes = int_of(item.get("bytes"));
        let reason = if action == "cmd" {
            command(value).is_none().then_some("unknown command id")
        } else {
            rm_rejection(index, action, value, &home, tmp_base.as_deref())
        };
        if let Some(reason) = reason {
            plan.rejected.push((reason.to_string(), value.to_string()));
            continue;
        }
        match action {
            "cmd" => plan.cmds.push(value.to_string()),
            "worktree" => plan.worktrees.push(value.to_string()),
            _ => plan.rm.push(value.to_string()),
        }
        plan.sizes.insert(value.to_string(), bytes);
        plan.bytes += bytes;
    }
    plan
}

fn rm_rejection(
    index: &ScanIndex,
    action: &str,
    value: &str,
    home: &str,
    tmp_base: Option<&str>,
) -> Option<&'static str> {
    if value.contains('\n') {
        return Some("newline in path");
    }
    if !is_canonical(value) {
        return Some("not a canonical path");
    }
    let Some(scanned_actions) = index.get(value) else {
        return Some("not in scan");
    };
    if !scanned_actions.iter().any(|a| a == action) {
        return Some("action does not match scan");
    }
    if !is_allowed(value, home, tmp_base) {
        return Some("protected path");
    }
    if fs::symlink_metadata(value).is_err() {
        return Some("already gone");
    }
    safe_to_remove(action, value, home, tmp_base).err()
}

pub fn is_canonical(p: &str) -> bool {
    p.strip_prefix('/').is_some_and(|rest| {
        rest.split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
    })
}

fn inside(p: &str, root: &str) -> bool {
    p.strip_prefix(root)
        .is_some_and(|rest| rest.starts_with('/'))
}

fn is_protected(p: &str, home: &str) -> bool {
    let (p, home) = (p.to_ascii_lowercase(), home.to_ascii_lowercase());
    if p == home || inside(&home, &p) {
        return true;
    }
    let Some(rest) = p.strip_prefix(&format!("{home}/")) else {
        return false;
    };
    let personal = PERSONAL
        .iter()
        .any(|name| rest == *name || inside(rest, name));
    let keychains = rest == "library"
        || rest
            .strip_prefix("library/")
            .is_some_and(|r| r.contains("keychains"));
    personal || keychains
}

fn in_allowed_root(p: &str, home: &str, tmp_base: Option<&str>) -> bool {
    let in_user_temp = tmp_base.filter(|b| !b.is_empty()).is_some_and(|base| {
        ["T", "C", "X"]
            .iter()
            .any(|sub| inside(p, &format!("{base}/{sub}")))
    });
    if inside(p, "/private/tmp") || in_user_temp {
        return true;
    }
    inside(p, home) && !SYSTEM.iter().any(|s| p == *s || inside(p, s))
}

pub fn is_allowed(p: &str, home: &str, tmp_base: Option<&str>) -> bool {
    is_canonical(p)
        && is_canonical(home)
        && !is_protected(p, home)
        && in_allowed_root(p, home, tmp_base)
}

pub fn safe_to_remove(
    action: &str,
    target: &str,
    home: &str,
    tmp_base: Option<&str>,
) -> Result<(), &'static str> {
    if !is_allowed(target, home, tmp_base) {
        return Err("protected path");
    }
    let path = Path::new(target);
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err("not a canonical path");
    };
    let Ok(real_parent) = fs::canonicalize(parent) else {
        return Err("its folder is gone");
    };
    if real_parent.join(name) != path {
        return Err(PATH_CHANGED);
    }
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if action == "worktree" && is_link {
        return Err("the worktree folder is now a symlink");
    }
    Ok(())
}

fn int_of(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        Some(Value::Bool(b)) => i64::from(*b),
        _ => 0,
    }
}

fn lines(items: &[String]) -> String {
    items.iter().map(|s| format!("{s}\n")).collect()
}

fn print_dry_run(plan: &Plan, mode: Mode) {
    let home = util::home();
    let (to_trash, to_remove) = plan.split(mode, &home);
    println!("# dry run: nothing is deleted. These are the steps clean would take.");
    println!(
        "# right before each step the path is resolved again; it is kept if a parent folder now resolves"
    );
    println!(
        "# elsewhere or it became protected, and a symlink is moved or removed itself, never followed."
    );
    if !to_trash.is_empty() {
        println!(
            "# moved to the Trash (undo in the page, with disk-clean undo RUN_DIR, or Finder's Put Back):"
        );
        for path in &to_trash {
            println!("trash -- {}", shell_quote(path));
        }
    }
    if !to_remove.is_empty() {
        println!("# deleted immediately, skipping the Trash (can't be undone):");
        for path in &to_remove {
            println!("rm -rf -- {}", shell_quote(path));
        }
    }
    let steps = plan.final_steps();
    if !steps.is_empty() {
        println!("# can't be undone:");
        for line in steps {
            println!("{line}");
        }
    }
    for (reason, value) in &plan.rejected {
        println!("# rejected ({reason}): {}", shell_quote(value));
    }
    println!("# {} items, {} bytes", plan.count(), plan.bytes);
}

fn take_lock(dir: &Path) -> io::Result<Option<fs::File>> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK))?;
    for _ in 0..LOCK_TRIES {
        if file.try_lock().is_ok() {
            return Ok(Some(file));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(None)
}

fn lock_is_free(dir: &Path) -> bool {
    match fs::File::open(dir.join(LOCK)) {
        Ok(file) => file.try_lock_shared().is_ok(),
        Err(_) => true,
    }
}

fn pass_lock(cmd: &mut Command, fd: RawFd) {
    cmd.env(LOCK_FD, fd.to_string());
    // SAFETY: in the forked child, fcntl only clears close-on-exec on the lock fd so the worker inherits the lock.
    unsafe {
        cmd.pre_exec(move || match libc::fcntl(fd, libc::F_SETFD, 0) {
            -1 => Err(io::Error::last_os_error()),
            _ => Ok(()),
        });
    }
}

fn keep_lock_from_commands() {
    if let Some(fd) = std::env::var(LOCK_FD)
        .ok()
        .and_then(|v| v.parse::<RawFd>().ok())
    {
        // SAFETY: only sets close-on-exec on the inherited lock fd, so commands the worker runs never hold the lock.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn fresh_events(dir: &Path) -> io::Result<fs::File> {
    let path = dir.join(EVENTS);
    remove_if_present(&path)?;
    fs::OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(path)
}

pub fn abandon(dir: &Path, status: &str, reason: &str) -> io::Result<()> {
    let mut events = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(EVENTS))?;
    writeln!(
        events,
        "{}",
        json!({"event": "abandoned", "reason": reason})
    )?;
    fs::write(dir.join(STATUS), format!("{status}\n"))
}

pub fn run_status(dir: &Path) -> String {
    let status = fs::read_to_string(dir.join(STATUS)).unwrap_or_default();
    let status = status.trim();
    if status == "pending" && lock_is_free(dir) {
        let _ = abandon(
            dir,
            "interrupted",
            "the cleanup process exited before it finished",
        );
        return "interrupted".to_string();
    }
    status.to_string()
}

pub fn clear_previous_run(dir: &Path) -> io::Result<()> {
    if !lock_is_free(dir) {
        return Ok(());
    }
    remove_if_present(&dir.join(EVENTS))?;
    remove_if_present(&dir.join(STATUS))
}

pub fn queue(run_dir: &str, dry_run: bool) -> io::Result<i32> {
    let dir = Path::new(run_dir);
    if run_dir.is_empty() {
        eprintln!("usage: disk-clean clean [--dry-run] <run_dir>");
        return Ok(2);
    }
    if !dir.is_dir() {
        eprintln!("no run directory at {run_dir}");
        return Ok(2);
    }
    if !dir.join("selection.json").is_file() {
        eprintln!("no selection.json in {run_dir}: approve a selection in the review page first");
        return Ok(2);
    }
    let scan_path = dir.join("scan.tsv");
    if !scan_path.is_file() {
        eprintln!("missing scan.tsv in {run_dir}");
        return Ok(2);
    }
    let selection: Value =
        match fs::read(dir.join("selection.json")).map(|b| serde_json::from_slice(&b)) {
            Ok(Ok(v)) => v,
            _ => {
                eprintln!("selection.json is not valid JSON");
                Value::Null
            }
        };
    let items = selection
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let plan = plan(&index_scan(&util::complete_lines(&scan_path)), &items);
    let mode = Mode::of(&selection);

    if dry_run {
        print_dry_run(&plan, mode);
        return Ok(if plan.count() == 0 { 3 } else { 0 });
    }

    let Some(lock) = take_lock(dir)? else {
        eprintln!("another clean is already running for {run_dir}");
        return Ok(ALREADY_RUNNING);
    };
    let rejected: String = plan
        .rejected
        .iter()
        .map(|(reason, value)| format!("{reason}\t{value}\n"))
        .collect();
    let (to_trash, to_remove) = plan.split(mode, &util::home());
    fs::write(dir.join("rm-list"), lines(&to_trash))?;
    fs::write(dir.join("now-list"), lines(&to_remove))?;
    fs::write(dir.join("cmd-list"), lines(&plan.cmds))?;
    fs::write(dir.join("wt-list"), lines(&plan.worktrees))?;
    fs::write(dir.join("rejected"), &rejected)?;

    let (kept, total_bytes) = (plan.count(), plan.bytes);
    if kept == 0 {
        eprintln!("nothing passed validation. see {run_dir}/rejected");
        drop(fresh_events(dir)?);
        abandon(
            dir,
            "abandoned",
            "nothing passed the safety checks, so nothing was deleted",
        )?;
        return Ok(3);
    }

    fs::write(dir.join(STATUS), "pending\n")?;
    let log_path = dir.join("clean.log");
    let log = fs::File::create(&log_path)?;
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.args(["clean", "--worker", run_dir])
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    pass_lock(&mut cmd, lock.as_raw_fd());
    let child = util::spawn_detached(&mut cmd)?;
    let pid = child.id();
    fs::write(dir.join("worker.pid"), format!("{pid}\n"))?;

    println!("queued  : {kept} items ({total_bytes} bytes)");
    println!("rejected: {}", rejected.lines().count());
    println!("pid     : {pid}");
    println!("log     : {}", log_path.display());
    Ok(0)
}

pub struct Events {
    file: Option<Mutex<fs::File>>,
    start: Instant,
}

impl Events {
    fn open(dir: &Path) -> Events {
        Events {
            file: fresh_events(dir).ok().map(Mutex::new),
            start: Instant::now(),
        }
    }

    pub fn append(dir: &Path) -> Events {
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(EVENTS));
        Events {
            file: file.ok().map(Mutex::new),
            start: Instant::now(),
        }
    }

    pub fn emit(&self, event: &str, mut data: Value) {
        data["event"] = json!(event);
        data["elapsed_ms"] = json!(self.start.elapsed().as_millis() as u64);
        if let Some(Ok(mut f)) = self.file.as_ref().map(Mutex::lock) {
            let _ = f.write_all(format!("{data}\n").as_bytes());
        }
    }
}

fn planned_bytes(dir: &Path) -> HashMap<String, i64> {
    let selection: Value = fs::read(dir.join("selection.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    selection
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let key = if item.get("action").and_then(Value::as_str) == Some("cmd") {
                "cmd_id"
            } else {
                "path"
            };
            let value = item.get(key)?.as_str()?;
            Some((value.to_string(), int_of(item.get("bytes"))))
        })
        .collect()
}

pub fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

type Check<'a> = &'a (dyn Fn(&str) -> Result<(), &'static str> + Sync);

fn remove_one(target: &str, bytes: i64, events: &Events, check: Check) -> (String, bool) {
    if let Err(reason) = check(target) {
        events.emit(
            "kept",
            json!({"path": target, "bytes": bytes, "reason": reason}),
        );
        return (format!("KEPT    {target} ({reason})"), false);
    }
    let start = Instant::now();
    let result = remove_path(Path::new(target));
    if fs::symlink_metadata(target).is_ok() {
        let reason = match &result {
            Err(e) => format!("still present after removal: {}", e.kind()),
            Ok(()) => "still present after removal".to_string(),
        };
        events.emit(
            "failed",
            json!({"path": target, "bytes": bytes, "reason": reason}),
        );
        return (format!("FAILED  {target} ({reason})"), false);
    }
    let secs = start.elapsed().as_secs_f64();
    events.emit(
        "removed",
        json!({"path": target, "bytes": bytes, "secs": secs}),
    );
    (format!("removed {target}  ({secs:.1}s)"), true)
}

fn trashed_line(moved: &trash::Moved, events: &Events) -> (String, i64) {
    match moved {
        trash::Moved::Trashed(e) => {
            events.emit(
                "trashed",
                json!({"id": e.id, "path": e.original, "bytes": e.bytes, "trashed_path": e.trashed}),
            );
            (format!("trashed {} -> {}", e.original, e.trashed), e.bytes)
        }
        trash::Moved::Failed(e) => {
            let event = if e.id.is_empty() && e.dev == 0 {
                "kept"
            } else {
                "failed"
            };
            events.emit(
                event,
                json!({"path": e.original, "bytes": e.bytes, "reason": e.reason}),
            );
            let label = if event == "kept" {
                "KEPT    "
            } else {
                "NOT TRASHED "
            };
            (format!("{label}{} ({})", e.original, e.reason), -1)
        }
    }
}

struct Trashed {
    count: usize,
    bytes: i64,
}

fn move_all(
    run_dir: &Path,
    home: &str,
    list: &[String],
    bytes_of: &dyn Fn(&str) -> i64,
    events: &Events,
    check: Check,
) -> Trashed {
    let mut out = Trashed { count: 0, bytes: 0 };
    if list.is_empty() {
        return out;
    }
    println!("moving {} paths to the Trash (undo available)", list.len());
    let mut record = match trash::Record::open(home, RECORD_TRIES) {
        Ok(Some(record)) => record,
        other => {
            let reason = match other {
                Err(e) => format!("not moved to the Trash: {e}"),
                _ => "not moved to the Trash: another undo or empty kept the Trash record busy"
                    .to_string(),
            };
            for target in list {
                events.emit(
                    "failed",
                    json!({"path": target, "bytes": bytes_of(target), "reason": reason}),
                );
                println!("NOT TRASHED {target} ({reason})");
            }
            return out;
        }
    };
    let run = trash::run_id(run_dir);
    let check = |target: &str| check(target).map_err(str::to_string);
    for batch in list.chunks(trash::BATCH) {
        let wanted: Vec<trash::Wanted> = batch
            .iter()
            .map(|t| trash::Wanted {
                original: t.clone(),
                bytes: bytes_of(t),
            })
            .collect();
        let moved = record.move_to_trash(&run, &wanted, &check);
        let rows: Vec<trash::Entry> = moved
            .iter()
            .filter_map(|m| match m {
                trash::Moved::Trashed(e) => Some(e.clone()),
                trash::Moved::Failed(e) if !e.id.is_empty() => Some(e.clone()),
                trash::Moved::Failed(_) => None,
            })
            .collect();
        for m in &moved {
            let (line, bytes) = trashed_line(m, events);
            if bytes >= 0 {
                out.count += 1;
                out.bytes += bytes;
            }
            println!("{line}");
        }
        if !rows.is_empty() {
            events.emit("trash", trash::rows(&rows));
        }
    }
    out
}

fn run_logged(label: &str, program: &str, args: &[&str]) -> bool {
    println!("running {label}");
    match util::spawn(Command::new(program).args(args).stdin(Stdio::null()))
        .and_then(|mut c| c.wait())
    {
        Ok(status) => status.success(),
        Err(e) => {
            println!("{program}: {e}");
            false
        }
    }
}

fn sample_free(events: &Events, stop: mpsc::Receiver<()>) {
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop.recv_timeout(FREE_EVERY) {
        events.emit("free", json!({"free": util::free_bytes()}));
    }
}

fn listed(dir: &Path, name: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    util::read_lines(&dir.join(name))
        .into_iter()
        .filter(|l| !l.trim().is_empty() && seen.insert(l.clone()))
        .collect()
}

pub fn worker(run_dir: &str) -> io::Result<i32> {
    keep_lock_from_commands();
    let dir = Path::new(run_dir);
    let events = Events::open(dir);
    let run = format!("{}-{}", util::now(), std::process::id());
    println!("started {}", util::local_time(c"%Y-%m-%d %H:%M:%S"));

    let rm_list = listed(dir, "rm-list");
    let now_list = listed(dir, "now-list");
    let wt_list = listed(dir, "wt-list");
    let cmd_list = listed(dir, "cmd-list");
    let planned = planned_bytes(dir);
    let bytes_of = |key: &str| planned.get(key).copied().unwrap_or(0);
    let home = util::home();
    let tmp_base = util::user_tmp_base();
    trash::synced(&home, &|event, data| events.emit(event, data));
    let rm_check = |target: &str| safe_to_remove("rm", target, &home, tmp_base.as_deref());
    let worktree_check = |target: &str| {
        safe_to_remove("worktree", target, &home, tmp_base.as_deref()).map_err(str::to_string)
    };
    let free_at_start = util::free_bytes() as i64;
    events.emit(
        "started",
        json!({
            "run": run,
            "free": free_at_start,
            "paths": rm_list.len() + now_list.len(),
            "trash": rm_list.len(),
            "worktrees": wt_list.len(),
            "commands": cmd_list.len(),
            "bytes": rm_list.iter().chain(&now_list).chain(&wt_list).chain(&cmd_list).map(|k| bytes_of(k)).sum::<i64>(),
        }),
    );
    let removed = AtomicUsize::new(0);
    let removed_bytes = AtomicI64::new(0);
    let tally = |count: usize, bytes: i64| {
        removed.fetch_add(count, Ordering::SeqCst);
        removed_bytes.fetch_add(bytes, Ordering::SeqCst);
    };

    let (working, stop) = mpsc::channel::<()>();
    let trashed = std::thread::scope(|s| -> io::Result<Trashed> {
        let sampler = &events;
        s.spawn(move || sample_free(sampler, stop));
        let trashed = move_all(dir, &home, &rm_list, &bytes_of, &events, &rm_check);

        if !now_list.is_empty() {
            println!(
                "deleting {} paths immediately (skipping the Trash, can't be undone)",
                now_list.len()
            );
            let parallel = util::env_num("DISK_CLEAN_PARALLEL", 4usize).max(1);
            let lines = Mutex::new(Vec::new());
            util::in_parallel(&now_list, parallel, |target| {
                let bytes = bytes_of(target);
                let (line, ok) = remove_one(target, bytes, &events, &rm_check);
                if ok {
                    tally(1, bytes);
                }
                if let Ok(mut lines) = lines.lock() {
                    lines.push(line);
                }
            });
            for line in lines.into_inner().unwrap_or_default() {
                println!("{line}");
            }
        }

        if !wt_list.is_empty() {
            println!(
                "removing {} worktrees (each re-checked first, can't be undone)",
                wt_list.len()
            );
            worktrees::remove(
                &wt_list,
                &mut io::stdout(),
                &worktree_check,
                &mut |path, kept| {
                    if kept.is_none() {
                        tally(1, bytes_of(path));
                    }
                    events.emit(
                        "worktree",
                        json!({
                            "path": path,
                            "bytes": bytes_of(path),
                            "outcome": if kept.is_some() { "kept" } else { "removed" },
                            "reason": kept.unwrap_or(""),
                        }),
                    );
                },
            )?;
        }

        for cmd_id in &cmd_list {
            match command(cmd_id) {
                Some((program, args)) => {
                    let label = shell_line(program, args);
                    let ok = run_logged(&label, program, args);
                    events.emit(
                        "command",
                        json!({"id": cmd_id, "label": label, "status": if ok { "ok" } else { "failed" }}),
                    );
                }
                None => println!("skipped unknown command id: {cmd_id}"),
            }
        }
        drop(working);
        Ok(trashed)
    })?;

    let after = util::free_bytes() as i64;
    let (count, bytes) = (
        removed.load(Ordering::SeqCst),
        removed_bytes.load(Ordering::SeqCst),
    );
    println!("removed: {count} items, {bytes} bytes");
    if trashed.count > 0 {
        println!(
            "trashed: {} items, {} bytes, in the Trash until it is emptied (undo: disk-clean undo {run_dir}; empty them: disk-clean empty {run_dir})",
            trashed.count, trashed.bytes
        );
    }
    println!(
        "free space changed by {} bytes since the cleanup started ({free_at_start} -> {after})",
        after - free_at_start
    );
    println!("finished {}", util::local_time(c"%Y-%m-%d %H:%M:%S"));
    events.emit(
        "done",
        json!({
            "removed": count,
            "removed_bytes": bytes,
            "trashed": trashed.count,
            "trashed_bytes": trashed.bytes,
            "free_before": free_at_start,
            "free_after": after,
        }),
    );
    fs::write(dir.join(STATUS), "done\n")?;
    Ok(0)
}
