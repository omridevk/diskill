use crate::util;
use crate::worktrees;
use serde_json::Value;
use std::fs;
use std::io::{self, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const COMMANDS: &[&str] = &["xcode-unavailable-sims", "docker-prune", "brew-cleanup"];

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

pub fn queue(run_dir: &str) -> io::Result<i32> {
    let dir = Path::new(run_dir);
    if run_dir.is_empty() || !dir.join("selection.json").is_file() {
        eprintln!("usage: clean-disk clean <run_dir>  (run_dir must contain selection.json)");
        return Ok(2);
    }
    let scan_path = dir.join("scan.tsv");
    if !scan_path.is_file() {
        eprintln!("missing scan.tsv in {run_dir}");
        return Ok(2);
    }
    let scan_lines = util::read_lines(&scan_path);
    let home = util::home();
    let tmp_base = util::user_tmp_base();

    let mut rm_list = String::new();
    let mut cmd_list = String::new();
    let mut wt_list = String::new();
    let mut rejected = String::new();
    let mut total_bytes: i64 = 0;
    let mut kept = 0usize;

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
    for item in &items {
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
        if action == "cmd" {
            if COMMANDS.contains(&value) {
                cmd_list.push_str(&format!("{value}\n"));
                total_bytes += bytes;
                kept += 1;
            } else {
                rejected.push_str(&format!("unknown command id\t{value}\n"));
            }
            continue;
        }
        let scan_actions: Vec<&str> = scan_lines
            .iter()
            .map(|l| l.split('\t').collect::<Vec<_>>())
            .filter(|cols| cols.len() == 13 && cols[8] == value)
            .map(|cols| cols[5])
            .collect();
        if scan_actions.is_empty() {
            rejected.push_str(&format!("not in scan\t{value}\n"));
            continue;
        }
        if !scan_actions.contains(&action) {
            rejected.push_str(&format!("action does not match scan\t{value}\n"));
            continue;
        }
        if !is_allowed(value, &home, tmp_base.as_deref()) {
            rejected.push_str(&format!("protected path\t{value}\n"));
            continue;
        }
        if !Path::new(value).exists() {
            rejected.push_str(&format!("already gone\t{value}\n"));
            continue;
        }
        if value.contains('\n') {
            rejected.push_str(&format!("newline in path\t{value}\n"));
            continue;
        }
        if action == "worktree" {
            wt_list.push_str(&format!("{value}\n"));
        } else {
            rm_list.push_str(&format!("{value}\n"));
        }
        total_bytes += bytes;
        kept += 1;
    }
    fs::write(dir.join("rm-list"), &rm_list)?;
    fs::write(dir.join("cmd-list"), &cmd_list)?;
    fs::write(dir.join("wt-list"), &wt_list)?;
    fs::write(dir.join("rejected"), &rejected)?;

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
    // SAFETY: setsid is async-signal-safe and only detaches the child into its own session.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    let pid = child.id();
    fs::write(dir.join("worker.pid"), format!("{pid}\n"))?;

    println!("queued  : {kept} items ({total_bytes} bytes)");
    println!("rejected: {}", rejected.lines().count());
    println!("pid     : {pid}");
    println!("log     : {}", log_path.display());
    Ok(0)
}

fn remove_tree(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return true;
    };
    if !meta.is_dir() {
        return fs::remove_file(path).is_ok();
    }
    let mut ok = true;
    match fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(e) => ok &= remove_tree(&e.path()),
                    Err(_) => ok = false,
                }
            }
        }
        Err(_) => ok = false,
    }
    fs::remove_dir(path).is_ok() && ok
}

fn rm_one(target: &str) -> String {
    let start = Instant::now();
    let ok = remove_tree(Path::new(target));
    if fs::symlink_metadata(target).is_ok() {
        format!(
            "FAILED  {target} (still present, exit {})",
            if ok { 0 } else { 1 }
        )
    } else {
        format!("removed {target}  ({}s)", start.elapsed().as_secs())
    }
}

fn run_logged(label: &str, program: &str, args: &[&str]) {
    println!("running {label}");
    if let Err(e) = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .status()
    {
        println!("{program}: {e}");
    }
}

pub fn worker(run_dir: &str) -> io::Result<i32> {
    let dir = Path::new(run_dir);
    let parallel = util::env_num("CLEAN_DISK_PARALLEL", 4usize).max(1);
    println!("started {}", util::local_time(c"%Y-%m-%d %H:%M:%S"));

    let rm_list: Vec<String> = util::read_lines(&dir.join("rm-list"))
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect();
    if !rm_list.is_empty() {
        println!("deleting {} paths with {parallel} workers", rm_list.len());
        let next = AtomicUsize::new(0);
        let out = Mutex::new(io::stdout());
        std::thread::scope(|s| {
            for _ in 0..parallel {
                s.spawn(|| {
                    while let Some(target) = rm_list.get(next.fetch_add(1, Ordering::SeqCst)) {
                        let line = rm_one(target);
                        if let Ok(mut o) = out.lock() {
                            let _ = writeln!(o, "{line}");
                        }
                    }
                });
            }
        });
    }

    let wt_list: Vec<String> = util::read_lines(&dir.join("wt-list"))
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if !wt_list.is_empty() {
        println!(
            "removing {} worktrees (each re-checked first)",
            wt_list.len()
        );
        worktrees::remove(&wt_list, &mut io::stdout())?;
    }

    for cmd_id in util::read_lines(&dir.join("cmd-list")) {
        match cmd_id.as_str() {
            "xcode-unavailable-sims" => run_logged(
                "xcrun simctl delete unavailable",
                "xcrun",
                &["simctl", "delete", "unavailable"],
            ),
            "docker-prune" => run_logged(
                "docker system prune -f",
                "docker",
                &["system", "prune", "-f"],
            ),
            "brew-cleanup" => run_logged(
                "brew cleanup --prune=all -s",
                "brew",
                &["cleanup", "--prune=all", "-s"],
            ),
            other => println!("skipped unknown command id: {other}"),
        }
    }

    let after = util::free_bytes() as i64;
    let before: i64 = fs::read_to_string(dir.join("free-before"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    println!("free before: {before} bytes");
    println!("free after:  {after} bytes");
    println!("reclaimed:   {} bytes", after - before);
    println!("finished {}", util::local_time(c"%Y-%m-%d %H:%M:%S"));
    fs::write(dir.join("status"), "done\n")?;
    Ok(0)
}
