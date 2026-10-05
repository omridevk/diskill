use crate::insights;
use crate::review;
use crate::trash;
use crate::util::{self, tilde};
use crate::walk::{self, Plan, Walk};
use crate::worktrees;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Instant;

pub type Row = [String; 13];

pub struct Config {
    pub min_bytes: u64,
    pub stale_days: i64,
    pub bigfile_bytes: u64,
    pub old_download_days: i64,
    pub max_report_items: usize,
    pub map_min_bytes: u64,
    pub map_depth: usize,
    pub nm_depth: usize,
    pub nm_min_bytes: u64,
    pub skip_map: bool,
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            min_bytes: util::env_num("DISK_CLEAN_MIN_BYTES", 10_485_760),
            stale_days: util::env_num("DISK_CLEAN_STALE_DAYS", 90),
            bigfile_bytes: util::env_num("DISK_CLEAN_BIGFILE_BYTES", 1_073_741_824),
            old_download_days: util::env_num("DISK_CLEAN_OLD_DOWNLOAD_DAYS", 180),
            max_report_items: util::env_num("DISK_CLEAN_MAX_REPORT_ITEMS", 40),
            map_min_bytes: util::env_num("DISK_CLEAN_MAP_MIN_BYTES", 209_715_200),
            map_depth: util::env_num("DISK_CLEAN_MAP_DEPTH", 5),
            nm_depth: util::env_num("DISK_CLEAN_NM_DEPTH", 9),
            nm_min_bytes: util::env_num("DISK_CLEAN_NM_MIN_BYTES", 5_242_880),
            skip_map: std::env::var("DISK_CLEAN_SKIP_MAP").is_ok_and(|v| v == "1"),
        }
    }
}

struct Ctx {
    home: String,
    now: i64,
    walk: Walk,
    parallel: bool,
}

fn early(home: &str, now: i64, parallel: bool) -> Ctx {
    Ctx {
        home: home.to_string(),
        now,
        walk: Walk::default(),
        parallel,
    }
}

struct Cat<'a> {
    id: &'a str,
    title: &'a str,
    desc: &'a str,
    risk: &'a str,
    pre: &'a str,
}

fn kb_bytes(blocks: u64) -> u64 {
    blocks.div_ceil(2) * 1024
}

fn size_bytes(ctx: &Ctx, path: &Path) -> Option<u64> {
    if let Some(r) = ctx.walk.sizes.get(path) {
        return Some(kb_bytes(*r));
    }
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if !is_link
        && let Some(r) = fs::canonicalize(path)
            .ok()
            .and_then(|c| ctx.walk.sizes.get(&c))
    {
        return Some(kb_bytes(*r));
    }
    walk::size_with(path, ctx.parallel).map(kb_bytes)
}

fn age_of(ctx: &Ctx, path: &Path) -> String {
    match fs::symlink_metadata(path) {
        Ok(m) => ((ctx.now - m.mtime()) / 86400).to_string(),
        Err(_) => "-".to_string(),
    }
}

fn children_of(ctx: &Ctx, dir: &Path) -> Vec<PathBuf> {
    if let Some(list) = ctx.walk.children.get(dir) {
        return list.clone();
    }
    fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn row(
    cat: &Cat,
    action: &str,
    cmd_id: &str,
    label: &str,
    path: &str,
    bytes: u64,
    note: &str,
    age: &str,
    accuracy: &str,
) -> Row {
    [
        cat.id.to_string(),
        cat.title.to_string(),
        cat.desc.to_string(),
        cat.risk.to_string(),
        cat.pre.to_string(),
        action.to_string(),
        cmd_id.to_string(),
        label.to_string(),
        path.to_string(),
        bytes.to_string(),
        note.to_string(),
        age.to_string(),
        accuracy.to_string(),
    ]
}

fn sized(ctx: &Ctx, out: &mut Vec<Row>, cat: &Cat, paths: &[PathBuf], note: &str, min: u64) {
    for p in paths {
        if !p.exists() {
            continue;
        }
        let Some(s) = p.to_str() else { continue };
        let Some(bytes) = size_bytes(ctx, p) else {
            continue;
        };
        if bytes < min {
            continue;
        }
        out.push(row(
            cat,
            "rm",
            "-",
            &tilde(s, &ctx.home),
            s,
            bytes,
            note,
            &age_of(ctx, p),
            "exact",
        ));
    }
}

fn h(ctx: &Ctx, rel: &str) -> PathBuf {
    PathBuf::from(format!("{}/{rel}", ctx.home))
}

fn existing(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|p| p.exists()).collect()
}

const PKG_CACHE: &[&str] = &[
    ".npm/_cacache",
    "Library/Caches/Yarn",
    ".yarn/berry/cache",
    "Library/Caches/pnpm",
    ".bun/install/cache",
    "Library/Caches/pip",
    ".cache/pip",
    ".cache/uv",
    "Library/Caches/Homebrew",
];
const PKG_CACHE_TAIL: &[&str] = &[
    "Library/Caches/go-build",
    ".cargo/registry/cache",
    ".cache/ms-playwright",
    "Library/Caches/ms-playwright",
    ".cache/puppeteer",
    "Library/Caches/CocoaPods",
    ".composer/cache",
    ".cache/yarn",
    "Library/Caches/electron",
    "Library/Caches/node-gyp",
    "Library/Caches/deno",
];
const PKG_STORE: &[&str] = &[
    ".cargo/registry/src",
    "go/pkg/mod",
    ".m2/repository",
    ".gradle/caches",
    ".gem",
];
const PNPM_STORE: &[&str] = &["Library/pnpm/store", ".local/share/pnpm/store"];
const XCODE: &[&str] = &[
    "Library/Developer/Xcode/DerivedData",
    "Library/Developer/CoreSimulator/Caches",
    "Library/Developer/Xcode/iOS DeviceSupport",
    "Library/Developer/Xcode/watchOS DeviceSupport",
    "Library/Developer/Xcode/UserData/IB Support",
];
const XCODE_ARCHIVES: &str = "Library/Developer/Xcode/Archives";
const SIM_DEVICES: &str = "Library/Developer/CoreSimulator/Devices";
const CRASH_REPORTER: &str = "Library/Application Support/CrashReporter";
const DIAGNOSTIC_REPORTS: &str = "Library/Logs/DiagnosticReports";
const IOS_BACKUP: &str = "Library/Application Support/MobileSync/Backup";

pub fn parse_docker_bytes(s: &str) -> u64 {
    let b = s.as_bytes();
    let numeric = |c: u8| c.is_ascii_digit() || c == b'.';
    let mut i = 0;
    while i < b.len() {
        if !numeric(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && numeric(b[i]) {
            i += 1;
        }
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let unit = match (b.get(j), b.get(j + 1)) {
            (Some(b'K'), Some(b'B')) => Some(1u64 << 10),
            (Some(b'M'), Some(b'B')) => Some(1 << 20),
            (Some(b'G'), Some(b'B')) => Some(1 << 30),
            (Some(b'T'), Some(b'B')) => Some(1 << 40),
            (Some(b'B'), _) => Some(1),
            _ => None,
        };
        if let Some(unit) = unit {
            return s[start..i]
                .parse::<f64>()
                .map(|v| (v * unit as f64) as u64)
                .unwrap_or(0);
        }
    }
    0
}

fn probe_docker() -> Option<u64> {
    if !util::which("docker") || !util::output("docker", &["info"])?.0 {
        return None;
    }
    let (_, out) = util::output("docker", &["system", "df", "--format", "{{.Reclaimable}}"])?;
    Some(parse_docker_bytes(out.lines().next().unwrap_or("")))
}

fn has_sims(home: &str) -> bool {
    util::which("xcrun") && Path::new(&format!("{home}/{SIM_DEVICES}")).is_dir()
}

fn probe_sims(home: &str) -> usize {
    if !has_sims(home) {
        return 0;
    }
    util::output("xcrun", &["simctl", "list", "devices"])
        .map(|(_, out)| out.lines().filter(|l| l.contains("unavailable")).count())
        .unwrap_or(0)
}

fn probe_brew() -> Option<String> {
    if !util::which("brew") {
        return None;
    }
    let (_, out) = util::output("brew", &["--cache"])?;
    let out = out.trim_end_matches('\n').to_string();
    (!out.is_empty()).then_some(out)
}

fn probe_snapshots() -> usize {
    util::output("tmutil", &["listlocalsnapshots", "/"])
        .map(|(_, out)| out.lines().filter(|l| l.contains("com.apple")).count())
        .unwrap_or(0)
}

fn plan(cfg: &Config, home: &str, now: i64, tmp_base: Option<&str>) -> Plan {
    let hp = |rel: &str| PathBuf::from(format!("{home}/{rel}"));
    let mut exact: HashSet<PathBuf> = [PKG_CACHE, PKG_CACHE_TAIL, PKG_STORE, PNPM_STORE, XCODE]
        .concat()
        .iter()
        .map(|r| hp(r))
        .collect();
    exact.extend(
        [
            XCODE_ARCHIVES,
            SIM_DEVICES,
            CRASH_REPORTER,
            DIAGNOSTIC_REPORTS,
        ]
        .iter()
        .map(|r| hp(r)),
    );
    exact.insert(PathBuf::from(home));
    let mut parents: HashSet<PathBuf> = [
        ".Trash",
        "Library/Caches",
        "Library/Logs",
        IOS_BACKUP,
        "Downloads",
    ]
    .iter()
    .map(|r| hp(r))
    .collect();
    parents.insert(PathBuf::from("/private/tmp"));
    if let Some(base) = tmp_base {
        for sub in ["T", "C", "X"] {
            parents.insert(PathBuf::from(format!("{base}/{sub}")));
        }
    }
    Plan {
        home: PathBuf::from(home),
        map_depth: (!cfg.skip_map).then_some(cfg.map_depth),
        map_min_kb: cfg.map_min_bytes / 1024,
        nm_depth: cfg.nm_depth,
        dev_depth: 7,
        big_depth: 6,
        repo_depth: worktrees::repo_depth(),
        stale_days: cfg.stale_days,
        now,
        big_bytes: cfg.bigfile_bytes,
        exact,
        parents,
        held: trash::legacy_held_root(home),
        repo_tx: None,
        days: insights::midnights(now),
        cancel: Arc::default(),
    }
}

pub trait Sink: Sync {
    fn emit(&self, event: &str, data: Value);
}

pub struct FilesOnly;

impl Sink for FilesOnly {
    fn emit(&self, _: &str, _: Value) {}
}

fn run_walk(
    cfg: &Config,
    plan: Plan,
    home: &str,
    tmp_base: Option<&str>,
    mount: &Path,
    progress: &dyn Fn(&Walk, &Path),
) -> Walk {
    let mut out = Walk::default();
    let mut seen = HashSet::new();
    if cfg.skip_map {
        let mut roots = vec![PathBuf::from(home), PathBuf::from("/private/tmp")];
        roots.extend(tmp_base.map(PathBuf::from));
        for root in roots.iter().filter(|r| r.is_dir()) {
            walk::walk(root, root, &plan, true, &mut seen, &mut out, progress);
        }
    } else {
        walk::walk(
            mount,
            Path::new("/"),
            &plan,
            true,
            &mut seen,
            &mut out,
            progress,
        );
    }
    out
}

pub fn new_run_dir(run_dir: Option<String>) -> io::Result<PathBuf> {
    let run_dir = match run_dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(format!(
            "{}/.cache/disk-clean/run-{}",
            util::home(),
            util::local_time(c"%Y%m%d-%H%M%S")
        )),
    };
    fs::create_dir_all(&run_dir)?;
    Ok(run_dir)
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let run_dir = new_run_dir(run_dir)?;
    scan(&run_dir, &FilesOnly, Arc::new(AtomicBool::new(false)))?;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", run_dir.display())?;
    Ok(0)
}

static IN_ORDER: Mutex<()> = Mutex::new(());

fn emit(sink: &dyn Sink, started: Instant, event: &str, mut data: Value) {
    let _in_order = IN_ORDER.lock().unwrap_or_else(PoisonError::into_inner);
    data["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
    sink.emit(event, data);
}

struct Published {
    shown: HashMap<String, Row>,
    order: Vec<Row>,
    settled: HashSet<String>,
    checking: HashSet<String>,
    record: fs::File,
    lines: usize,
    cancel: Arc<AtomicBool>,
    started: Instant,
}

fn valid(rows: &[Row]) -> impl Iterator<Item = &Row> {
    rows.iter().filter(|r| !r[8].contains(['\t', '\n']))
}

fn show(out: &mut Published, row: &Row, sink: &dyn Sink) {
    if out.cancel.load(Ordering::Relaxed) || out.shown.get(&row[8]) == Some(row) {
        return;
    }
    out.shown.insert(row[8].clone(), row.clone());
    out.checking.remove(&row[8]);
    let fields: Vec<&str> = row.iter().map(String::as_str).collect();
    let Some((category, mut item)) = review::parse_row(&fields) else {
        return;
    };
    if let Err(e) = out
        .record
        .write_all(format!("{}\n", row.join("\t")).as_bytes())
    {
        eprintln!("  could not record {} in scan.tsv: {e}", row[8]);
        return;
    }
    out.lines += 1;
    item.line = Some(out.lines);
    emit(
        sink,
        out.started,
        "item",
        json!({"category": category, "item": item}),
    );
}

fn pend(rows: &[Row], out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    if out.cancel.load(Ordering::Relaxed) {
        return;
    }
    for r in valid(rows) {
        if out.shown.contains_key(&r[8]) || out.settled.contains(&r[8]) {
            continue;
        }
        if !out.checking.insert(r[8].clone()) {
            continue;
        }
        let fields: Vec<&str> = r.iter().map(String::as_str).collect();
        if let Some((category, mut item)) = review::parse_row(&fields) {
            item.checking = true;
            emit(
                sink,
                out.started,
                "item",
                json!({"category": category, "item": item}),
            );
        }
    }
}

fn unpend(paths: impl IntoIterator<Item = String>, out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    for path in paths {
        if out.checking.remove(&path) && !out.cancel.load(Ordering::Relaxed) {
            emit(sink, out.started, "unlisted", json!({"path": path}));
        }
    }
}

fn preview(rows: &[Row], out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    for r in valid(rows) {
        let taken = out.shown.get(&r[8]).is_some_and(|s| s[0] != r[0]);
        if !taken && !out.settled.contains(&r[8]) {
            show(&mut out, r, sink);
        }
    }
}

fn settle(rows: &[Row], out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    for r in valid(rows) {
        if out.settled.insert(r[8].clone()) {
            out.order.push(r.clone());
            show(&mut out, r, sink);
        }
    }
}

fn unsettled(ctx: &Ctx, out: &Mutex<Published>) -> Vec<Row> {
    let out = out.lock().unwrap_or_else(PoisonError::into_inner);
    let mut rows: Vec<Row> = out
        .shown
        .values()
        .filter(|r| !out.settled.contains(&r[8]))
        .cloned()
        .collect();
    rows.sort_by(|a, b| a[8].cmp(&b[8]));
    for r in &mut rows {
        if let Some(bytes) = size_bytes(ctx, Path::new(&r[8])) {
            r[9] = bytes.to_string();
        }
    }
    rows
}

fn interrupted() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "scan cancelled")
}

pub fn scan(run_dir: &Path, sink: &dyn Sink, cancel: Arc<AtomicBool>) -> io::Result<()> {
    util::utility_qos();
    let _ = rayon::ThreadPoolBuilder::new()
        .start_handler(|_| util::utility_qos())
        .build_global();
    let cfg = Config::from_env();
    let home = util::home();
    let now = util::now();
    let started = Instant::now();
    eprintln!("  scanning (one parallel walk of the data volume)...");

    let tmp_base = util::user_tmp_base();
    let mount = util::data_mount();
    let start = util::volume_stats(&mount);
    let used = start.as_ref().map_or(0, |s| s.used);
    let snapshots = probe_snapshots();
    emit(
        sink,
        started,
        "disk",
        json!({
            "total": start.as_ref().map_or(0, |s| s.total),
            "used": used,
            "free": start.as_ref().map_or(0, |s| s.avail),
            "snapshots": snapshots,
        }),
    );
    let mut plan = plan(&cfg, &home, now, tmp_base.as_deref());
    plan.cancel = Arc::clone(&cancel);
    let (repo_tx, repo_rx) = std::sync::mpsc::channel();
    plan.repo_tx = Some(repo_tx);
    let days = plan.days.clone();
    let out = Mutex::new(Published {
        shown: HashMap::new(),
        order: Vec::new(),
        settled: HashSet::new(),
        checking: HashSet::new(),
        record: fs::File::create(run_dir.join("scan.tsv"))?,
        lines: 0,
        cancel: Arc::clone(&cancel),
        started,
    });
    let progress = |w: &Walk, dir: &Path| {
        emit(
            sink,
            started,
            "progress",
            json!({"files": w.files, "bytes": w.bytes, "dir": dir.to_string_lossy()}),
        );
    };
    let walk_ctx: OnceLock<Ctx> = OnceLock::new();
    let waiting: Mutex<Vec<worktrees::Checked>> = Mutex::new(Vec::new());
    let checked_so_far = AtomicUsize::new(0);
    let show_worktrees = |ctx: &Ctx, checked: &[worktrees::Checked]| {
        let rows = worktrees::rows(checked, &home, |p| size_bytes(ctx, p).unwrap_or(0));
        preview(&rows, &out, sink);
        unpend(
            checked
                .iter()
                .filter_map(|c| c.entry.get("worktree").cloned()),
            &out,
            sink,
        );
    };
    let on_listed = |entries: &[worktrees::Entry]| {
        pend(&worktrees::checking_rows(entries, &home), &out, sink);
    };
    let on_checked = |c: &worktrees::Checked| {
        checked_so_far.fetch_add(1, Ordering::Relaxed);
        let mut waiting = waiting.lock().unwrap_or_else(PoisonError::into_inner);
        match walk_ctx.get() {
            Some(ctx) => {
                drop(waiting);
                show_worktrees(ctx, std::slice::from_ref(c));
            }
            None => waiting.push(c.clone()),
        }
    };
    let (listed_tx, listed_rx) = std::sync::mpsc::channel();
    std::thread::scope(|s| {
        let (out, cfg, home) = (&out, &cfg, &home);
        let docker = s.spawn(move || {
            util::utility_qos();
            if util::which("docker") {
                pend(&[docker_row(0)], out, sink);
            }
            let bytes = probe_docker();
            let mut rows = Vec::new();
            scan_docker(&mut rows, cfg, bytes);
            preview(&rows, out, sink);
            unpend([DOCKER_KEY.to_string()], out, sink);
            bytes
        });
        let sims = s.spawn(move || {
            util::utility_qos();
            if has_sims(home) {
                pend(&[sims_row("xcrun simctl delete unavailable", 0)], out, sink);
            }
            let sims = probe_sims(home);
            let mut rows = Vec::new();
            scan_sims(&early(home, now, true), &mut rows, sims);
            preview(&rows, out, sink);
            unpend([SIMS_KEY.to_string()], out, sink);
            sims
        });
        let (on_listed, on_checked) = (&on_listed, &on_checked);
        let checks = s.spawn(move || {
            util::utility_qos();
            worktrees::check_repos(repo_rx, listed_tx, on_listed, on_checked)
        });

        let brew_cache = probe_brew();
        let fixed = early(home, now, true);
        let mut rows: Vec<Row> = Vec::new();
        scan_trash(&fixed, &mut rows);
        scan_pkg(&fixed, &mut rows, cfg, brew_cache.as_deref());
        scan_xcode(&fixed, &mut rows, cfg);
        scan_ios_backups(&fixed, &mut rows, cfg);
        scan_caches(&fixed, &mut rows, cfg);
        scan_logs(&fixed, &mut rows, cfg);
        preview(&rows, out, sink);
        eprintln!(
            "  sized {} fixed locations in {:.1}s",
            rows.len(),
            started.elapsed().as_secs_f64()
        );

        let mut walked = run_walk(cfg, plan, home, tmp_base.as_deref(), &mount, &progress);
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        eprintln!("  walked the disk in {}s", started.elapsed().as_secs());
        let too_deep = walked.too_deep;
        if too_deep > 0 {
            eprintln!("  skipped {too_deep} folders nested too deep to read");
        }
        let insights = insights::to_json(std::mem::take(&mut walked.insights), &days, now, home);
        let finished_early = {
            let mut waiting = waiting.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = walk_ctx.set(Ctx {
                home: home.clone(),
                now,
                walk: walked,
                parallel: false,
            });
            std::mem::take(&mut *waiting)
        };
        let Some(ctx) = walk_ctx.get() else {
            return Err(interrupted());
        };

        let mut rows: Vec<Row> = Vec::new();
        scan_trash(ctx, &mut rows);
        scan_pkg(ctx, &mut rows, cfg, brew_cache.as_deref());
        scan_xcode(ctx, &mut rows, cfg);
        scan_node_modules(ctx, &mut rows, cfg);
        scan_dev_artifacts(ctx, &mut rows, cfg);
        scan_ios_backups(ctx, &mut rows, cfg);
        scan_caches(ctx, &mut rows, cfg);
        scan_logs(ctx, &mut rows, cfg);
        scan_user_tmpdir(ctx, &mut rows, cfg, tmp_base.as_deref());
        scan_private_tmp(ctx, &mut rows, cfg);
        scan_big_files(ctx, &mut rows, cfg);
        settle(&rows, out, sink);
        show_worktrees(ctx, &finished_early);

        let mut map = String::new();
        if !cfg.skip_map {
            let min_kb = cfg.map_min_bytes / 1024;
            for (p, blocks, files, mtime) in &ctx.walk.map {
                let kb = blocks.div_ceil(2);
                let Some(s) = p.to_str() else { continue };
                if kb >= min_kb || s == "/" {
                    map.push_str(&format!("{}\t{files}\t{mtime}\t{s}\n", kb * 1024));
                }
            }
        }
        util::write_atomic(&run_dir.join("map.tsv"), map.as_bytes())?;
        util::write_atomic(
            &run_dir.join("insights.json"),
            insights.to_string().as_bytes(),
        )?;
        let home_bytes = size_bytes(ctx, Path::new(home)).unwrap_or(0);
        let listed = listed_rx.recv().unwrap_or(0);
        let running = listed.saturating_sub(checked_so_far.load(Ordering::Relaxed));
        emit(
            sink,
            started,
            "walked",
            json!({
                "home": home_bytes,
                "tree": review::load_map(run_dir, home, used as i64),
                "insights": insights,
                "worktrees": running,
            }),
        );

        let checked = checks.join().unwrap_or_default();
        eprintln!(
            "  checked {} git worktrees by {}s",
            checked.len(),
            started.elapsed().as_secs()
        );
        let mut rows = worktrees::rows(&checked, home, |p| size_bytes(ctx, p).unwrap_or(0));
        scan_old_downloads(ctx, &mut rows, cfg);
        scan_sims(ctx, &mut rows, sims.join().unwrap_or(0));
        scan_docker(&mut rows, cfg, docker.join().ok().flatten());
        settle(&rows, out, sink);
        settle(&unsettled(ctx, out), out, sink);
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        let leftover: Vec<String> = out
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .checking
            .iter()
            .cloned()
            .collect();
        unpend(leftover, out, sink);

        let out = out.lock().unwrap_or_else(PoisonError::into_inner);
        let mut scan = String::new();
        let mut reclaimable = 0;
        for r in &out.order {
            scan.push_str(&r.join("\t"));
            scan.push('\n');
            let fields: Vec<&str> = r.iter().map(String::as_str).collect();
            if let Some((_, item)) = review::parse_row(&fields)
                && !item.report
                && item.accuracy == "exact"
            {
                reclaimable += item.bytes;
            }
        }
        util::write_atomic(&run_dir.join("scan.tsv"), scan.as_bytes())?;
        let stats = util::volume_stats(&mount);
        let (total, used, free) = stats
            .as_ref()
            .map(|s| (s.total, s.used, s.avail))
            .unwrap_or((0, 0, 0));
        util::write_atomic(
            &run_dir.join("disk.tsv"),
            format!(
                "total\t{total}\nused\t{used}\nfree\t{free}\nhome\t{home_bytes}\nsnapshots\t{snapshots}\ntoo_deep\t{too_deep}\n"
            )
            .as_bytes(),
        )?;
        eprintln!("  found {} items", out.order.len());
        emit(sink, started, "done", json!({"reclaimable": reclaimable}));
        Ok(())
    })
}

fn scan_trash(ctx: &Ctx, rows: &mut Vec<Row>) {
    let cat = Cat {
        id: "trash",
        title: "Trash",
        desc: "Items already in the macOS Trash.",
        risk: "safe",
        pre: "1",
    };
    let list = children_of(ctx, &h(ctx, ".Trash"));
    sized(ctx, rows, &cat, &list, "Permanently removed.", 1);
}

fn scan_caches(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "caches",
        title: "Application caches",
        desc: "~/Library/Caches — regenerated automatically by each app.",
        risk: "safe",
        pre: "1",
    };
    let list = children_of(ctx, &h(ctx, "Library/Caches"));
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "App rebuilds this on next launch.",
        cfg.min_bytes,
    );
}

fn scan_logs(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "logs",
        title: "Logs and crash reports",
        desc: "Diagnostic output kept by apps and macOS.",
        risk: "safe",
        pre: "1",
    };
    let mut list = children_of(ctx, &h(ctx, "Library/Logs"));
    list.extend(existing(vec![
        h(ctx, CRASH_REPORTER),
        h(ctx, DIAGNOSTIC_REPORTS),
    ]));
    sized(ctx, rows, &cat, &list, "Diagnostics only.", cfg.min_bytes);
}

fn scan_pkg(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, brew_cache: Option<&str>) {
    let mut list: Vec<PathBuf> = PKG_CACHE.iter().map(|r| h(ctx, r)).collect();
    list.extend(brew_cache.map(PathBuf::from));
    list.extend(PKG_CACHE_TAIL.iter().map(|r| h(ctx, r)));
    let cat = Cat {
        id: "pkg-cache",
        title: "Package manager caches",
        desc: "Download caches for npm, brew, pip, cargo, go and friends.",
        risk: "safe",
        pre: "1",
    };
    sized(
        ctx,
        rows,
        &cat,
        &existing(list),
        "Re-downloaded on next install.",
        cfg.min_bytes,
    );

    let cat = Cat {
        id: "pkg-store",
        title: "Package manager stores",
        desc: "Extracted dependency sources. Safe to delete but slower to restore.",
        risk: "review",
        pre: "0",
    };
    let list = existing(PKG_STORE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Re-downloaded and re-extracted on next build.",
        cfg.min_bytes,
    );

    let cat = Cat {
        id: "pnpm-store",
        title: "pnpm content store",
        desc: "The store that existing node_modules hard-link into.",
        risk: "review",
        pre: "0",
    };
    let list = existing(PNPM_STORE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Breaks every existing node_modules on this Mac until each project reinstalls.",
        cfg.min_bytes,
    );
}

fn scan_xcode(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "xcode",
        title: "Xcode build data",
        desc: "Derived data, simulator caches and device support files.",
        risk: "safe",
        pre: "1",
    };
    let list = existing(XCODE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Xcode regenerates on next build or device connect.",
        cfg.min_bytes,
    );

    let cat = Cat {
        id: "xcode-archives",
        title: "Xcode archives",
        desc: "Built .xcarchive bundles. Needed to re-submit or symbolicate an old build.",
        risk: "review",
        pre: "0",
    };
    let list = existing(vec![h(ctx, XCODE_ARCHIVES)]);
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Not recoverable without rebuilding that exact commit.",
        cfg.min_bytes,
    );
}

const SIMS_KEY: &str = "cmd:xcode-unavailable-sims";
const DOCKER_KEY: &str = "cmd:docker-prune";

fn sims_row(label: &str, bytes: u64) -> Row {
    let cat = Cat {
        id: "xcode-sims",
        title: "Unavailable simulators",
        desc: "Simulator devices whose runtime is no longer installed.",
        risk: "safe",
        pre: "1",
    };
    row(
        &cat,
        "cmd",
        "xcode-unavailable-sims",
        label,
        SIMS_KEY,
        bytes,
        "Rough estimate. Removes only devices macOS already marks unavailable.",
        "-",
        "estimate",
    )
}

fn scan_sims(ctx: &Ctx, rows: &mut Vec<Row>, sims: usize) {
    if sims > 0 {
        let bytes = size_bytes(ctx, &h(ctx, SIM_DEVICES)).unwrap_or(0) / 3;
        rows.push(sims_row(
            &format!("xcrun simctl delete unavailable ({sims} devices)"),
            bytes,
        ));
    }
}

fn scan_dev_artifacts(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let list: Vec<PathBuf> = ctx
        .walk
        .artifacts
        .iter()
        .filter(|d| {
            d.file_name().is_none_or(|n| n != "target") || d.with_file_name("Cargo.toml").is_file()
        })
        .cloned()
        .collect();
    let desc = format!(
        "Virtualenvs and build output untouched for over {} days. node_modules has its own section below.",
        cfg.stale_days
    );
    let cat = Cat {
        id: "dev-artifacts",
        title: "Stale build artifacts",
        desc: &desc,
        risk: "safe",
        pre: "1",
    };
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Restored by re-running the project's install or build.",
        cfg.min_bytes,
    );
}

fn scan_node_modules(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let desc = "Every node_modules folder on this Mac, whatever its age. Each one is fully rebuildable from its lockfile.";
    for p in &ctx.walk.node_modules {
        let Some(bytes) = size_bytes(ctx, p) else {
            continue;
        };
        if bytes < cfg.nm_min_bytes {
            continue;
        }
        let parent = p.parent().unwrap_or(Path::new("/"));
        let mut mgr = "npm";
        if parent.join("pnpm-lock.yaml").is_file() {
            mgr = "pnpm";
        }
        if parent.join("yarn.lock").is_file() {
            mgr = "yarn";
        }
        if parent.join("bun.lockb").is_file() || parent.join("bun.lock").is_file() {
            mgr = "bun";
        }
        let age = age_of(ctx, p);
        let pre = age.parse::<i64>().is_ok_and(|a| a > cfg.stale_days);
        let mut note =
            format!("{mgr} project, last installed {age} days ago. Restore with: {mgr} install");
        let mut measurement = "exact";
        if mgr == "pnpm" {
            measurement = "estimate";
            note.push_str(" Size is apparent: pnpm clones package files from ~/Library/pnpm/store, so deleting frees only blocks no other project or the store still holds.");
        }
        let (Some(s), Some(ps)) = (p.to_str(), parent.to_str()) else {
            continue;
        };
        let cat = Cat {
            id: "node-modules",
            title: "node_modules",
            desc,
            risk: "safe",
            pre: if pre { "1" } else { "0" },
        };
        rows.push(row(
            &cat,
            "rm",
            "-",
            &tilde(ps, &ctx.home),
            s,
            bytes,
            &note,
            &age,
            measurement,
        ));
    }
}

fn scan_ios_backups(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "ios-backups",
        title: "iOS device backups",
        desc: "Local iPhone and iPad backups.",
        risk: "review",
        pre: "0",
    };
    let list = children_of(ctx, &h(ctx, IOS_BACKUP));
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Not recoverable. Only delete if the device backs up to iCloud.",
        cfg.min_bytes,
    );
}

fn scan_docker(rows: &mut Vec<Row>, cfg: &Config, bytes: Option<u64>) {
    if let Some(bytes) = bytes.filter(|b| *b >= cfg.min_bytes) {
        rows.push(docker_row(bytes));
    }
}

fn docker_row(bytes: u64) -> Row {
    let cat = Cat {
        id: "docker",
        title: "Docker",
        desc: "Dangling images, stopped containers and build cache.",
        risk: "review",
        pre: "0",
    };
    row(
        &cat,
        "cmd",
        "docker-prune",
        "docker system prune -f",
        DOCKER_KEY,
        bytes,
        "Frees space INSIDE Docker's sparse VM disk image, which does not shrink — macOS gets little or none of it back. Reclaim it on the host by resetting the Docker VM disk in Docker Desktop. Named volumes are never touched.",
        "-",
        "vm",
    )
}

fn scan_big_files(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let gb = 1_073_741_824u64;
    let desc = format!(
        "Files over {} GB, measured by space actually allocated on disk. Listed for awareness — never deleted by this skill.",
        cfg.bigfile_bytes / gb
    );
    let cat = Cat {
        id: "big-files",
        title: "Large files (report only)",
        desc: &desc,
        risk: "report",
        pre: "0",
    };
    for (f, apparent, blocks) in ctx.walk.big_files.iter().take(cfg.max_report_items) {
        let sz = blocks * 512;
        if sz < cfg.bigfile_bytes {
            continue;
        }
        let note = if *apparent > sz * 2 {
            format!(
                "Sparse file — {} GB apparent, {} GB actually on disk.",
                apparent / gb,
                sz / gb
            )
        } else {
            "Review manually.".to_string()
        };
        let Some(s) = f.to_str() else { continue };
        rows.push(row(
            &cat,
            "rm",
            "-",
            &tilde(s, &ctx.home),
            s,
            sz,
            &note,
            &age_of(ctx, f),
            "exact",
        ));
    }
}

fn scan_old_downloads(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let list: Vec<PathBuf> = children_of(ctx, &h(ctx, "Downloads"))
        .into_iter()
        .filter(|p| {
            fs::symlink_metadata(p)
                .is_ok_and(|m| (ctx.now - m.mtime()) / 86400 > cfg.old_download_days)
        })
        .take(cfg.max_report_items)
        .collect();
    let desc = format!(
        "~/Downloads entries untouched for over {} days. Listed for awareness — never deleted by this skill.",
        cfg.old_download_days
    );
    let cat = Cat {
        id: "old-downloads",
        title: "Old downloads (report only)",
        desc: &desc,
        risk: "report",
        pre: "0",
    };
    sized(ctx, rows, &cat, &list, "Review manually.", cfg.min_bytes);
}

fn scan_private_tmp(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let tmp = Path::new("/private/tmp");
    if !tmp.is_dir() {
        return;
    }
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let list: Vec<PathBuf> = children_of(ctx, tmp)
        .into_iter()
        .filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.uid() == uid))
        .collect();
    let cat = Cat {
        id: "private-tmp",
        title: "Temp files in /private/tmp",
        desc: "Entries in /private/tmp that belong to you. Tools recreate what they need, but a running process may still be using one.",
        risk: "review",
        pre: "0",
    };
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Recreated on demand.",
        cfg.min_bytes,
    );
}

fn scan_user_tmpdir(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, base: Option<&str>) {
    let Some(base) = base.filter(|b| Path::new(b).is_dir()) else {
        return;
    };
    let mut list = children_of(ctx, &PathBuf::from(format!("{base}/T")));
    list.extend(children_of(ctx, &PathBuf::from(format!("{base}/C"))));
    let cat = Cat {
        id: "user-tmpdir",
        title: "Your macOS temp and cache folder",
        desc: "The per-user $TMPDIR tree. Rebuilt automatically, but a running process may still be using one.",
        risk: "review",
        pre: "0",
    };
    sized(ctx, rows, &cat, &list, "Rebuilt on demand.", cfg.min_bytes);

    let cat = Cat {
        id: "code-sign-clones",
        title: "App code-signing clones",
        desc: "Copies macOS makes of an app bundle while the app runs. They pile up and are rarely cleaned. Sizes are apparent — clones share disk blocks with the app, so the space actually returned is only the blocks of app versions no longer on disk.",
        risk: "review",
        pre: "0",
    };
    for d in children_of(ctx, &PathBuf::from(format!("{base}/X"))) {
        let Some(name) = d.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || !name.ends_with(".code_sign_clone") || !d.is_dir() {
            continue;
        }
        let Some(bytes) = size_bytes(ctx, &d) else {
            continue;
        };
        if bytes < cfg.min_bytes {
            continue;
        }
        let Some(s) = d.to_str() else { continue };
        rows.push(row(
            &cat,
            "rm",
            "-",
            &format!("$TMPDIR/../X/{name}"),
            s,
            bytes,
            "Quit the app first. Frees far less than the size shown.",
            &age_of(ctx, &d),
            "estimate",
        ));
    }
}
