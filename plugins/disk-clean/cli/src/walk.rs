use crate::insights::{self, Ins, Insights};
use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsStr, OsString};
use std::fs;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, sync_channel};

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Kind {
    #[default]
    Other,
    File,
    Dir,
    Symlink,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Meta {
    pub dev: u64,
    pub ino: u64,
    pub nlink: u64,
    pub blocks: u64,
    pub size: u64,
    pub mtime: i64,
    pub kind: Kind,
}

pub fn meta_of(m: &fs::Metadata) -> Meta {
    let t = m.file_type();
    let kind = if t.is_symlink() {
        Kind::Symlink
    } else if t.is_dir() {
        Kind::Dir
    } else if t.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Meta {
        dev: m.dev(),
        ino: m.ino(),
        nlink: m.nlink(),
        blocks: m.blocks(),
        size: m.size(),
        mtime: m.mtime(),
        kind,
    }
}

#[derive(Default)]
pub struct Plan {
    pub home: PathBuf,
    pub map_depth: Option<usize>,
    pub nm_depth: usize,
    pub dev_depth: usize,
    pub big_depth: usize,
    pub repo_depth: usize,
    pub stale_days: i64,
    pub now: i64,
    pub big_bytes: u64,
    pub exact: HashSet<PathBuf>,
    pub parents: HashSet<PathBuf>,
    pub repo_tx: Option<std::sync::mpsc::Sender<PathBuf>>,
    pub days: Vec<i64>,
}

#[derive(Default)]
pub struct Walk {
    pub sizes: HashMap<PathBuf, u64>,
    pub children: HashMap<PathBuf, Vec<PathBuf>>,
    pub map: Vec<(PathBuf, u64)>,
    pub node_modules: Vec<PathBuf>,
    pub artifacts: Vec<PathBuf>,
    pub big_files: Vec<(PathBuf, u64, u64)>,
    pub insights: Insights,
}

const NM_TOP: &[&str] = &[
    "Library",
    ".Trash",
    "Applications",
    ".claude",
    ".nvm",
    ".volta",
    ".asdf",
    ".local",
    ".bun",
    ".npm",
    ".cache",
    ".cursor",
    ".vscode",
    ".codex",
    ".rustup",
    "Documents",
    "Desktop",
];
const DEV_TOP: &[&str] = &[
    "Library",
    ".Trash",
    "Applications",
    ".cargo",
    ".gradle",
    ".m2",
    ".npm",
    ".bun",
    ".nvm",
    ".volta",
    ".asdf",
    ".local",
    ".rbenv",
    ".pyenv",
    ".docker",
    ".orbstack",
];
const DEV_NAMES: &[&str] = &[
    ".venv",
    "venv",
    "target",
    ".next",
    ".nuxt",
    ".turbo",
    ".svelte-kit",
    ".parcel-cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
];
const REPO_SKIP: &[&str] = &[
    "Library",
    ".Trash",
    "node_modules",
    ".cache",
    ".npm",
    ".nvm",
    ".cargo",
    ".rustup",
    ".local",
    ".docker",
    ".orbstack",
    "go",
    ".gradle",
    ".m2",
    "Applications",
];

#[derive(Clone, Copy)]
struct Home {
    depth: usize,
    nm: bool,
    dev: bool,
    big: bool,
    repo: bool,
    is_go: bool,
}

struct Frame {
    depth: usize,
    path: PathBuf,
    blocks: u64,
    track: bool,
    collect_children: bool,
    home: Option<Home>,
    ins: Option<Ins>,
}

struct Found {
    home: Option<Home>,
    node_modules: bool,
    artifact: bool,
    big_file: bool,
    repo: bool,
}

fn classify(plan: &Plan, parent: Option<&Frame>, name: Option<&str>, meta: &Meta) -> Found {
    let mut found = Found {
        home: None,
        node_modules: false,
        artifact: false,
        big_file: false,
        repo: false,
    };
    let Some(ph) = parent.and_then(|p| p.home) else {
        return found;
    };
    let is = |s: &str| name == Some(s);
    let any = |list: &[&str]| name.is_some_and(|n| list.contains(&n));
    let d = ph.depth + 1;
    if is(".git")
        && ph.repo
        && (meta.kind == Kind::Dir
            || (meta.kind == Kind::Symlink && parent.is_some_and(|p| p.path.join(".git").is_dir())))
    {
        found.repo = true;
    }
    if meta.kind != Kind::Dir {
        let pruned =
            (d == 1 && (is("Library") || is(".Trash"))) || is(".git") || is("node_modules");
        found.big_file = ph.big && !pruned && meta.kind == Kind::File && meta.size > plan.big_bytes;
        return found;
    }
    let nm_pruned = (d == 1 && any(NM_TOP)) || is(".git");
    let is_nm = is("node_modules");
    found.node_modules = ph.nm && !nm_pruned && is_nm;
    let dev_pruned = (d == 1 && any(DEV_TOP)) || (d == 2 && ph.is_go && is("pkg")) || is(".git");
    let dev_match = any(DEV_NAMES);
    found.artifact =
        ph.dev && !dev_pruned && dev_match && (plan.now - meta.mtime) / 86400 > plan.stale_days;
    let big_pruned =
        (d == 1 && (is("Library") || is(".Trash"))) || is(".git") || is("node_modules");
    let hidden_top = ph.depth == 0 && name.is_some_and(|n| n.starts_with('.')) && !is(".claude");
    found.home = Some(Home {
        depth: d,
        nm: ph.nm && !nm_pruned && !is_nm && d < plan.nm_depth,
        dev: ph.dev && !dev_pruned && !dev_match && d < plan.dev_depth,
        big: ph.big && !big_pruned && d < plan.big_depth,
        repo: ph.repo
            && !is(".git")
            && !any(REPO_SKIP)
            && ph.depth < plan.repo_depth
            && !hidden_top,
        is_go: d == 1 && is("go"),
    });
    found
}

fn pop(stack: &mut Vec<Frame>, plan: &Plan, out: &mut Walk) -> u64 {
    let Some(f) = stack.pop() else { return 0 };
    if let Some(p) = stack.last_mut() {
        p.blocks += f.blocks;
    }
    if f.track {
        out.sizes.insert(f.path.clone(), f.blocks);
    }
    if plan.map_depth.is_some_and(|m| f.depth <= m) {
        out.map.push((f.path, f.blocks));
    }
    f.blocks
}

const COMMON: u32 = libc::ATTR_CMN_RETURNED_ATTRS
    | libc::ATTR_CMN_NAME
    | libc::ATTR_CMN_DEVID
    | libc::ATTR_CMN_OBJTYPE
    | libc::ATTR_CMN_MODTIME
    | libc::ATTR_CMN_FILEID;
const DIR_ATTRS: u32 = libc::ATTR_DIR_MOUNTSTATUS | libc::ATTR_DIR_ALLOCSIZE;
const FILE_ATTRS: u32 =
    libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE | libc::ATTR_FILE_DATALENGTH;
const VREG: u32 = 1;
const VDIR: u32 = 2;
const VLNK: u32 = 5;

struct Entry {
    name: OsString,
    meta: Meta,
    next: Option<Next>,
}

enum Next {
    Read(PathBuf),
    Wait(Receiver<Vec<Entry>>),
}

fn take<const N: usize>(buf: &[u8], at: &mut usize) -> Option<[u8; N]> {
    let bytes = buf.get(*at..*at + N)?.try_into().ok()?;
    *at += N;
    Some(bytes)
}

fn u32_at(buf: &[u8], at: &mut usize) -> Option<u32> {
    take(buf, at).map(u32::from_ne_bytes)
}

fn u64_at(buf: &[u8], at: &mut usize) -> Option<u64> {
    take(buf, at).map(u64::from_ne_bytes)
}

fn blocks_of(alloc: u64) -> u64 {
    alloc.div_ceil(512)
}

fn parse_entry(rec: &[u8]) -> Option<(OsString, Option<Meta>)> {
    let mut at = 4;
    let common = u32_at(rec, &mut at)?;
    let [_, dirattr, fileattr, _] = [(); 4].map(|_| u32_at(rec, &mut at).unwrap_or(0));
    let has = |bit: u32| common & bit == bit;
    if !has(libc::ATTR_CMN_NAME) {
        return None;
    }
    let name_at = at;
    let offset = i32::from_ne_bytes(take(rec, &mut at)?);
    let len = u32_at(rec, &mut at)? as usize;
    let start = name_at.checked_add_signed(offset as isize)?;
    let name = rec.get(start..start + len.saturating_sub(1))?;
    let name = OsString::from_vec(name.to_vec());
    let wanted = libc::ATTR_CMN_DEVID
        | libc::ATTR_CMN_OBJTYPE
        | libc::ATTR_CMN_MODTIME
        | libc::ATTR_CMN_FILEID;
    if !has(wanted) {
        return Some((name, None));
    }
    let dev = i32::from_ne_bytes(take(rec, &mut at)?) as u64;
    let objtype = u32_at(rec, &mut at)?;
    let mtime = i64::from_ne_bytes(take(rec, &mut at)?);
    at += 8;
    let ino = u64_at(rec, &mut at)?;
    let mut meta = Meta {
        dev,
        ino,
        mtime,
        kind: match objtype {
            VREG => Kind::File,
            VDIR => Kind::Dir,
            VLNK => Kind::Symlink,
            _ => Kind::Other,
        },
        ..Meta::default()
    };
    if meta.kind == Kind::Dir {
        if dirattr & DIR_ATTRS != DIR_ATTRS {
            return Some((name, None));
        }
        let mount = u32_at(rec, &mut at)?;
        if mount & libc::DIR_MNTSTATUS_MNTPOINT != 0 {
            return Some((name, None));
        }
        meta.blocks = blocks_of(u64_at(rec, &mut at)?);
    } else {
        if fileattr & FILE_ATTRS != FILE_ATTRS {
            return Some((name, None));
        }
        meta.nlink = u64::from(u32_at(rec, &mut at)?);
        meta.blocks = blocks_of(u64_at(rec, &mut at)?);
        meta.size = u64_at(rec, &mut at)?;
    }
    Some((name, Some(meta)))
}

fn read_dir_bulk(dir: &Path) -> Vec<(OsString, Option<Meta>)> {
    let mut out = Vec::new();
    let Ok(c) = CString::new(dir.as_os_str().as_bytes()) else {
        return out;
    };
    // SAFETY: open has no memory preconditions beyond a valid C string.
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return out;
    }
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: COMMON,
        volattr: 0,
        dirattr: DIR_ATTRS,
        fileattr: FILE_ATTRS,
        forkattr: 0,
    };
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        // SAFETY: getattrlistbulk writes at most buf.len() bytes into buf.
        let n = unsafe {
            libc::getattrlistbulk(
                fd,
                (&mut list as *mut libc::attrlist).cast(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
            )
        };
        if n <= 0 {
            break;
        }
        let mut at = 0usize;
        for _ in 0..n {
            let mut cursor = at;
            let Some(len) = u32_at(&buf, &mut cursor).map(|l| l as usize) else {
                break;
            };
            if len == 0 || at + len > buf.len() {
                break;
            }
            out.extend(parse_entry(&buf[at..at + len]));
            at += len;
        }
    }
    // SAFETY: fd was opened above and is closed once.
    unsafe { libc::close(fd) };
    out
}

fn list(dir: &Path, dev: u64, parallel: bool) -> Vec<Entry> {
    read_dir_bulk(dir)
        .into_iter()
        .filter_map(|(name, meta)| {
            let meta = meta.or_else(|| {
                fs::symlink_metadata(dir.join(&name))
                    .ok()
                    .map(|m| meta_of(&m))
            })?;
            let next = (meta.kind == Kind::Dir && meta.dev == dev)
                .then(|| descend(dir.join(&name), dev, parallel));
            Some(Entry { name, meta, next })
        })
        .collect()
}

fn descend(path: PathBuf, dev: u64, parallel: bool) -> Next {
    if !parallel {
        return Next::Read(path);
    }
    let (tx, rx) = sync_channel(1);
    rayon::spawn(move || {
        let _ = tx.send(list(&path, dev, true));
    });
    Next::Wait(rx)
}

fn open(next: Next, dev: u64) -> Vec<Entry> {
    match next {
        Next::Read(path) => list(&path, dev, false),
        Next::Wait(rx) => rx.recv().unwrap_or_default(),
    }
}

pub fn walk(
    root: &Path,
    logical: &Path,
    plan: &Plan,
    parallel: bool,
    seen: &mut HashSet<(u64, u64)>,
    out: &mut Walk,
) -> Option<u64> {
    let root_meta = meta_of(&fs::symlink_metadata(root).ok()?);
    let dev = root_meta.dev;
    let threads = std::thread::available_parallelism()
        .map(|n| n.get() * 2)
        .unwrap_or(8);
    let pool = if parallel {
        Some(
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .ok()?,
        )
    } else {
        None
    };
    let next = (root_meta.kind == Kind::Dir).then(|| match &pool {
        Some(pool) => pool.install(|| descend(root.to_path_buf(), dev, true)),
        None => Next::Read(root.to_path_buf()),
    });
    let root_entry = Entry {
        name: root.file_name().unwrap_or(OsStr::new("/")).to_os_string(),
        meta: root_meta,
        next,
    };
    let mut pending: Vec<(usize, std::vec::IntoIter<Entry>)> =
        vec![(0, vec![root_entry].into_iter())];

    let mut stack: Vec<Frame> = Vec::new();
    let mut total = None;
    while let Some((depth, entries)) = pending.last_mut() {
        let depth = *depth;
        let Some(entry) = entries.next() else {
            pending.pop();
            continue;
        };
        if let Some(next) = entry.next {
            pending.push((depth + 1, open(next, dev).into_iter()));
        }
        let meta = entry.meta;
        let file_name = entry.name;
        while stack.last().is_some_and(|f| f.depth >= depth) {
            let blocks = pop(&mut stack, plan, out);
            if stack.is_empty() {
                total = Some(blocks);
            }
        }
        if depth > 0 && stack.is_empty() {
            continue;
        }
        let counted =
            meta.kind == Kind::Dir || meta.nlink <= 1 || seen.insert((meta.dev, meta.ino));
        let own = if counted { meta.blocks } else { 0 };
        let name = file_name.to_str();
        let parent = stack.last();
        let found = classify(plan, parent, name, &meta);
        let path_of = |p: Option<&Frame>| match p {
            Some(p) => p.path.join(&file_name),
            None => logical.to_path_buf(),
        };
        let child_of_interest = parent.is_some_and(|p| p.collect_children);
        if name == Some(".git")
            && let Some(p) = stack.last_mut()
        {
            p.track = true;
        }
        let parent = stack.last();
        if found.repo
            && let (Some(p), Some(tx)) = (parent, &plan.repo_tx)
        {
            let _ = tx.send(p.path.clone());
        }

        if meta.kind == Kind::Dir {
            let path = path_of(parent);
            let mut home = found.home;
            let mut ins = parent.and_then(|p| {
                p.ins
                    .map(|i| insights::enter(&mut out.insights, i, &p.path, &file_name))
            });
            if home.is_none() && path == plan.home {
                ins = insights::start(&mut out.insights);
                home = Some(Home {
                    depth: 0,
                    nm: plan.nm_depth >= 1,
                    dev: plan.dev_depth >= 1,
                    big: plan.big_depth >= 1,
                    repo: true,
                    is_go: false,
                });
            }
            let collect_children = plan.parents.contains(&path);
            if collect_children {
                out.children.entry(path.clone()).or_default();
            }
            if child_of_interest && let Some(p) = parent {
                out.children
                    .entry(p.path.clone())
                    .or_default()
                    .push(path.clone());
            }
            if found.node_modules {
                out.node_modules.push(path.clone());
            }
            if found.artifact {
                out.artifacts.push(path.clone());
            }
            let track = depth == 0
                || child_of_interest
                || found.node_modules
                || found.artifact
                || plan.map_depth.is_some_and(|m| depth <= m)
                || plan.exact.contains(&path);
            stack.push(Frame {
                depth,
                path,
                blocks: own,
                track,
                collect_children,
                home,
                ins,
            });
            continue;
        }

        if depth == 0 {
            out.sizes.insert(logical.to_path_buf(), own);
            return Some(own);
        }
        let needs_path = child_of_interest || found.big_file || meta.kind == Kind::Symlink;
        if needs_path {
            let path = path_of(parent);
            if child_of_interest || plan.exact.contains(&path) {
                out.sizes.insert(path.clone(), own);
            }
            if child_of_interest && let Some(p) = parent {
                out.children
                    .entry(p.path.clone())
                    .or_default()
                    .push(path.clone());
            }
            if found.big_file {
                out.big_files.push((path, meta.size, meta.blocks));
            }
        }
        if meta.kind == Kind::File
            && counted
            && let Some(p) = parent
            && let Some(i) = p.ins
        {
            let path = || p.path.join(&file_name);
            insights::add(
                &mut out.insights,
                i,
                &plan.days,
                plan.now,
                &file_name,
                &meta,
                path,
            );
        }
        if let Some(p) = stack.last_mut() {
            p.blocks += own;
        }
    }
    while !stack.is_empty() {
        let blocks = pop(&mut stack, plan, out);
        if stack.is_empty() {
            total = Some(blocks);
        }
    }
    total
}

pub fn size_of(path: &Path) -> Option<u64> {
    walk(
        path,
        path,
        &Plan::default(),
        false,
        &mut HashSet::new(),
        &mut Walk::default(),
    )
}
