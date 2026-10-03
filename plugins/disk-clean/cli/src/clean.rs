use crate::util;
use crate::worktrees;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

const FREE_EVERY: Duration = Duration::from_millis(500);

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

#[derive(Default)]
pub struct Plan {
    pub rm: Vec<String>,
    pub worktrees: Vec<String>,
    pub cmds: Vec<String>,
    pub rejected: Vec<(String, String)>,
    pub bytes: i64,
}

impl Plan {
    pub fn count(&self) -> usize {
        self.rm.len() + self.worktrees.len() + self.cmds.len()
    }

    pub fn commands(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .rm
            .iter()
            .map(|p| shell_line("rm", &["-rf", "--", p]))
            .collect();
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

pub fn plan(scan_lines: &[String], items: &[Value]) -> Plan {
    let home = util::home();
    let tmp_base = util::user_tmp_base();
    let mut plan = Plan::default();
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
        let bytes = int_of(item.get("bytes"));
        let reason = if action == "cmd" {
            command(value).is_none().then_some("unknown command id")
        } else {
            rm_rejection(scan_lines, action, value, &home, tmp_base.as_deref())
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
        plan.bytes += bytes;
    }
    plan
}

fn rm_rejection(
    scan_lines: &[String],
    action: &str,
    value: &str,
    home: &str,
    tmp_base: Option<&str>,
) -> Option<&'static str> {
    let scan_actions: Vec<&str> = scan_lines
        .iter()
        .map(|l| l.split('\t').collect::<Vec<_>>())
        .filter(|cols| cols.len() == 13 && cols[8] == value)
        .map(|cols| cols[5])
        .collect();
    if scan_actions.is_empty() {
        return Some("not in scan");
    }
    if !scan_actions.contains(&action) {
        return Some("action does not match scan");
    }
    if !is_allowed(value, home, tmp_base) {
        return Some("protected path");
    }
    if !Path::new(value).exists() {
        return Some("already gone");
    }
    if value.contains('\n') {
        return Some("newline in path");
    }
    None
}

fn rest_after<'a>(p: &'a str, prefix: &str) -> Option<&'a str> {
    p.strip_prefix(prefix).filter(|r| !r.is_empty())
}

fn dir_or_under(rest: &str, name: &str) -> bool {
    rest == name || rest.starts_with(&format!("{name}/"))
}

pub fn is_allowed(p: &str, home: &str, tmp_base: Option<&str>) -> bool {
    if p.contains("..") {
        return false;
    }
    if rest_after(p, "/private/tmp/").is_some() {
        return true;
    }
    if let Some(base) = tmp_base.filter(|b| !b.is_empty())
        && ["T", "C", "X"]
            .iter()
            .any(|s| rest_after(p, &format!("{base}/{s}/")).is_some())
    {
        return true;
    }
    if p == home || p == format!("{home}/") || p == "/" || p == "/Users" {
        return false;
    }
    let blocked = [
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
    if blocked.iter().any(|b| p.starts_with(b)) {
        return false;
    }
    let Some(rest) = p.strip_prefix(&format!("{home}/")) else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let personal = [
        "Documents",
        "Desktop",
        "Pictures",
        "Movies",
        "Music",
        ".ssh",
        ".gnupg",
        ".aws",
        ".kube",
        ".claude",
        "Library/Mail",
        "Library/Messages",
    ];
    if personal.iter().any(|n| dir_or_under(rest, n)) {
        return false;
    }
    if rest == "Library"
        || rest
            .strip_prefix("Library/")
            .is_some_and(|r| r.contains("Keychains"))
    {
        return false;
    }
    !p.contains("..")
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

pub fn queue(run_dir: &str, dry_run: bool) -> io::Result<i32> {
    let dir = Path::new(run_dir);
    if run_dir.is_empty() || !dir.join("selection.json").is_file() {
        eprintln!(
            "usage: disk-clean clean [--dry-run] <run_dir>  (run_dir must contain selection.json)"
        );
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
    let plan = plan(&util::read_lines(&scan_path), &items);
    let rejected: String = plan
        .rejected
        .iter()
        .map(|(reason, value)| format!("{reason}\t{value}\n"))
        .collect();

    if dry_run {
        println!("# dry run: nothing is deleted. These are the commands clean would run.");
        for line in plan.commands() {
            println!("{line}");
        }
        for (reason, value) in &plan.rejected {
            println!("# rejected ({reason}): {}", shell_quote(value));
        }
        println!("# {} items, {} bytes", plan.count(), plan.bytes);
        return Ok(0);
    }

    fs::write(dir.join("rm-list"), lines(&plan.rm))?;
    fs::write(dir.join("cmd-list"), lines(&plan.cmds))?;
    fs::write(dir.join("wt-list"), lines(&plan.worktrees))?;
    fs::write(dir.join("rejected"), &rejected)?;

    let (kept, total_bytes) = (plan.count(), plan.bytes);
    if kept == 0 {
        eprintln!("nothing passed validation. see {run_dir}/rejected");
        return Ok(3);
    }

    fs::write(dir.join("status"), "pending\n")?;
    let log_path = dir.join("clean.log");
    let log = fs::File::create(&log_path)?;
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.args(["clean", "--worker", run_dir])
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    let child = util::spawn_detached(&mut cmd)?;
    let pid = child.id();
    fs::write(dir.join("worker.pid"), format!("{pid}\n"))?;

    println!("queued  : {kept} items ({total_bytes} bytes)");
    println!("rejected: {}", rejected.lines().count());
    println!("pid     : {pid}");
    println!("log     : {}", log_path.display());
    Ok(0)
}

struct Events {
    file: Option<Mutex<fs::File>>,
    start: Instant,
}

impl Events {
    fn open(dir: &Path) -> Events {
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("clean.events"))
            .ok();
        Events {
            file: file.map(Mutex::new),
            start: Instant::now(),
        }
    }

    fn emit(&self, event: &str, mut data: Value) {
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

fn remove_tree(path: &Path) -> io::Result<()> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if !meta.is_dir() {
        return fs::remove_file(path);
    }
    let mut first = Ok(());
    match fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                let removed = entry.and_then(|e| remove_tree(&e.path()));
                first = first.and(removed);
            }
        }
        Err(e) => first = Err(e),
    }
    let removed = fs::remove_dir(path);
    first.and(removed)
}

fn rm_one(target: &str, bytes: i64, events: &Events) -> String {
    let start = Instant::now();
    let result = remove_tree(Path::new(target));
    if fs::symlink_metadata(target).is_ok() {
        let reason = match &result {
            Err(e) => format!("still present after removal: {}", e.kind()),
            Ok(()) => "still present after removal".to_string(),
        };
        events.emit(
            "failed",
            json!({"path": target, "bytes": bytes, "reason": reason}),
        );
        format!(
            "FAILED  {target} (still present, exit {})",
            if result.is_ok() { 0 } else { 1 }
        )
    } else {
        let secs = start.elapsed();
        events.emit(
            "removed",
            json!({"path": target, "bytes": bytes, "secs": secs.as_secs_f64()}),
        );
        format!("removed {target}  ({}s)", secs.as_secs())
    }
}

fn run_logged(label: &str, program: &str, args: &[&str]) -> bool {
    println!("running {label}");
    match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .status()
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

fn non_empty(dir: &Path, name: &str) -> Vec<String> {
    util::read_lines(&dir.join(name))
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .collect()
}

pub fn worker(run_dir: &str) -> io::Result<i32> {
    let dir = Path::new(run_dir);
    let parallel = util::env_num("DISK_CLEAN_PARALLEL", 4usize).max(1);
    let events = Events::open(dir);
    println!("started {}", util::local_time(c"%Y-%m-%d %H:%M:%S"));

    let rm_list = non_empty(dir, "rm-list");
    let wt_list = non_empty(dir, "wt-list");
    let cmd_list = non_empty(dir, "cmd-list");
    let planned = planned_bytes(dir);
    let bytes_of = |key: &str| planned.get(key).copied().unwrap_or(0);
    let free_at_start = util::free_bytes() as i64;
    events.emit(
        "started",
        json!({
            "free": free_at_start,
            "paths": rm_list.len(),
            "worktrees": wt_list.len(),
            "commands": cmd_list.len(),
            "bytes": rm_list.iter().chain(&wt_list).chain(&cmd_list).map(|k| bytes_of(k)).sum::<i64>(),
        }),
    );

    let (working, stop) = mpsc::channel::<()>();
    std::thread::scope(|s| -> io::Result<()> {
        let sampler = &events;
        s.spawn(move || sample_free(sampler, stop));
        if !rm_list.is_empty() {
            println!("deleting {} paths with {parallel} workers", rm_list.len());
            let next = AtomicUsize::new(0);
            let out = Mutex::new(io::stdout());
            std::thread::scope(|s| {
                for _ in 0..parallel {
                    s.spawn(|| {
                        while let Some(target) = rm_list.get(next.fetch_add(1, Ordering::SeqCst)) {
                            let line = rm_one(target, bytes_of(target), &events);
                            if let Ok(mut o) = out.lock() {
                                let _ = writeln!(o, "{line}");
                            }
                        }
                    });
                }
            });
        }

        if !wt_list.is_empty() {
            println!(
                "removing {} worktrees (each re-checked first)",
                wt_list.len()
            );
            worktrees::remove(&wt_list, &mut io::stdout(), &mut |path, kept| {
                events.emit(
                    "worktree",
                    json!({
                        "path": path,
                        "bytes": bytes_of(path),
                        "outcome": if kept.is_some() { "kept" } else { "removed" },
                        "reason": kept.unwrap_or(""),
                    }),
                );
            })?;
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
        Ok(())
    })?;

    let after = util::free_bytes() as i64;
    let before: i64 = fs::read_to_string(dir.join("free-before"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    println!("free before: {before} bytes");
    println!("free after:  {after} bytes");
    println!("reclaimed:   {} bytes", after - before);
    println!("finished {}", util::local_time(c"%Y-%m-%d %H:%M:%S"));
    events.emit(
        "done",
        json!({"free_before": free_at_start, "free_after": after, "reclaimed": after - free_at_start}),
    );
    fs::write(dir.join("status"), "done\n")?;
    Ok(0)
}
