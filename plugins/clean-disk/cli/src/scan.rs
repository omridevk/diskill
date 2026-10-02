use crate::util::{self, tilde};
use crate::walk::{self, Plan, Walk};
use crate::worktrees;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

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
            min_bytes: util::env_num("CLEAN_DISK_MIN_BYTES", 10_485_760),
            stale_days: util::env_num("CLEAN_DISK_STALE_DAYS", 90),
            bigfile_bytes: util::env_num("CLEAN_DISK_BIGFILE_BYTES", 1_073_741_824),
            old_download_days: util::env_num("CLEAN_DISK_OLD_DOWNLOAD_DAYS", 180),
            max_report_items: util::env_num("CLEAN_DISK_MAX_REPORT_ITEMS", 40),
            map_min_bytes: util::env_num("CLEAN_DISK_MAP_MIN_BYTES", 209_715_200),
            map_depth: util::env_num("CLEAN_DISK_MAP_DEPTH", 5),
            nm_depth: util::env_num("CLEAN_DISK_NM_DEPTH", 9),
            nm_min_bytes: util::env_num("CLEAN_DISK_NM_MIN_BYTES", 5_242_880),
            skip_map: std::env::var("CLEAN_DISK_SKIP_MAP").is_ok_and(|v| v == "1"),
        }
    }
}

struct Ctx {
    home: String,
    now: i64,
    walk: Walk,
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
    walk::size_of(path).map(kb_bytes)
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

struct Probes {
    brew_cache: Option<String>,
    docker_bytes: Option<u64>,
    sims: usize,
    snapshots: usize,
}

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

fn probe_sims(home: &str) -> usize {
    if !util::which("xcrun") || !Path::new(&format!("{home}/{SIM_DEVICES}")).is_dir() {
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
        nm_depth: cfg.nm_depth,
        dev_depth: 7,
        big_depth: 6,
        repo_depth: worktrees::repo_depth(),
        stale_days: cfg.stale_days,
        now,
        big_bytes: cfg.bigfile_bytes,
        exact,
        parents,
        repo_tx: None,
    }
}

fn run_walk(cfg: &Config, plan: Plan, home: &str, tmp_base: Option<&str>, mount: &Path) -> Walk {
    let mut out = Walk::default();
    let mut seen = HashSet::new();
    if cfg.skip_map {
        let mut roots = vec![PathBuf::from(home), PathBuf::from("/private/tmp")];
        roots.extend(tmp_base.map(PathBuf::from));
        for root in roots.iter().filter(|r| r.is_dir()) {
            walk::walk(root, root, &plan, true, &mut seen, &mut out);
        }
    } else {
        walk::walk(mount, Path::new("/"), &plan, true, &mut seen, &mut out);
    }
    out
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let cfg = Config::from_env();
    let home = util::home();
    let now = util::now();
    let run_dir = match run_dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(format!(
            "{home}/.cache/clean-disk/run-{}",
            util::local_time(c"%Y%m%d-%H%M%S")
        )),
    };
    fs::create_dir_all(&run_dir)?;
    eprintln!("  scanning (one parallel walk of the data volume)...");

    let tmp_base = util::user_tmp_base();
    let mount = util::data_mount();
    let mut plan = plan(&cfg, &home, now, tmp_base.as_deref());
    let (repo_tx, repo_rx) = std::sync::mpsc::channel();
    plan.repo_tx = Some(repo_tx);
    let started = std::time::Instant::now();
    let (walked, probes, checked) = std::thread::scope(|s| {
        let brew = s.spawn(probe_brew);
        let docker = s.spawn(probe_docker);
        let sims = s.spawn(|| probe_sims(&home));
        let snaps = s.spawn(probe_snapshots);
        let checks = s.spawn(move || worktrees::check_repos(repo_rx));
        let walked = run_walk(&cfg, plan, &home, tmp_base.as_deref(), &mount);
        eprintln!("  walked the disk in {}s", started.elapsed().as_secs());
        let probes = Probes {
            brew_cache: brew.join().ok().flatten(),
            docker_bytes: docker.join().ok().flatten(),
            sims: sims.join().unwrap_or(0),
            snapshots: snaps.join().unwrap_or(0),
        };
        let checked = checks.join().unwrap_or_default();
        eprintln!(
            "  checked {} git worktrees by {}s",
            checked.len(),
            started.elapsed().as_secs()
        );
        (walked, probes, checked)
    });
    let ctx = Ctx {
        home: home.clone(),
        now,
        walk: walked,
    };

    let mut rows: Vec<Row> = Vec::new();
    scan_trash(&ctx, &mut rows);
    scan_pkg(&ctx, &mut rows, &cfg, probes.brew_cache.as_deref());
    scan_xcode(&ctx, &mut rows, &cfg, probes.sims);
    scan_node_modules(&ctx, &mut rows, &cfg);
    scan_dev_artifacts(&ctx, &mut rows, &cfg);
    scan_docker(&mut rows, &cfg, probes.docker_bytes);
    scan_ios_backups(&ctx, &mut rows, &cfg);
    scan_caches(&ctx, &mut rows, &cfg);
    scan_logs(&ctx, &mut rows, &cfg);
    scan_user_tmpdir(&ctx, &mut rows, &cfg, tmp_base.as_deref());
    scan_private_tmp(&ctx, &mut rows, &cfg);
    let worktree_rows = worktrees::rows(&checked, &home, |p| size_bytes(&ctx, p).unwrap_or(0));
    rows.extend(worktree_rows);
    scan_big_files(&ctx, &mut rows, &cfg);
    scan_old_downloads(&ctx, &mut rows, &cfg);

    let mut seen = HashSet::new();
    let mut scan = String::new();
    for r in rows.iter().filter(|r| !r[8].contains(['\t', '\n'])) {
        if seen.insert(r[8].clone()) {
            scan.push_str(&r.join("\t"));
            scan.push('\n');
        }
    }
    fs::write(run_dir.join("scan.tsv"), &scan)?;

    let mut map = String::new();
    if !cfg.skip_map {
        let min_kb = cfg.map_min_bytes / 1024;
        for (p, blocks) in &ctx.walk.map {
            let kb = blocks.div_ceil(2);
            let Some(s) = p.to_str() else { continue };
            if kb >= min_kb || s == "/" {
                map.push_str(&format!("{}\t{s}\n", kb * 1024));
            }
        }
    }
    fs::write(run_dir.join("map.tsv"), &map)?;

    let stats = util::volume_stats(&mount);
    let home_bytes = size_bytes(&ctx, Path::new(&home)).unwrap_or(0);
    let (total, used, free) = stats
        .as_ref()
        .map(|s| (s.total, s.used, s.avail))
        .unwrap_or((0, 0, 0));
    fs::write(
        run_dir.join("disk.tsv"),
        format!(
            "total\t{total}\nused\t{used}\nfree\t{free}\nhome\t{home_bytes}\nsnapshots\t{}\n",
            probes.snapshots
        ),
    )?;
    fs::write(
        run_dir.join("free-before"),
        format!("{}\n", util::free_bytes()),
    )?;

    eprintln!("  found {} items", seen.len());
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", run_dir.display())?;
    Ok(0)
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

fn scan_xcode(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, sims: usize) {
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

    if sims > 0 {
        let bytes = size_bytes(ctx, &h(ctx, SIM_DEVICES)).unwrap_or(0) / 3;
        let cat = Cat {
            id: "xcode-sims",
            title: "Unavailable simulators",
            desc: "Simulator devices whose runtime is no longer installed.",
            risk: "safe",
            pre: "1",
        };
        rows.push(row(
            &cat,
            "cmd",
            "xcode-unavailable-sims",
            &format!("xcrun simctl delete unavailable ({sims} devices)"),
            "cmd:xcode-unavailable-sims",
            bytes,
            "Rough estimate. Removes only devices macOS already marks unavailable.",
            "-",
            "estimate",
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
    let Some(bytes) = bytes.filter(|b| *b >= cfg.min_bytes) else {
        return;
    };
    let cat = Cat {
        id: "docker",
        title: "Docker",
        desc: "Dangling images, stopped containers and build cache.",
        risk: "review",
        pre: "0",
    };
    rows.push(row(
        &cat,
        "cmd",
        "docker-prune",
        "docker system prune -f",
        "cmd:docker-prune",
        bytes,
        "Frees space INSIDE Docker's sparse VM disk image, which does not shrink — macOS gets little or none of it back. Reclaim it on the host by resetting the Docker VM disk in Docker Desktop. Named volumes are never touched.",
        "-",
        "vm",
    ));
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
