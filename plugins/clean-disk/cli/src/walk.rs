use jwalk::{Parallelism, WalkDirGeneric};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

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
}

#[derive(Default)]
pub struct Walk {
    pub sizes: HashMap<PathBuf, u64>,
    pub children: HashMap<PathBuf, Vec<PathBuf>>,
    pub map: Vec<(PathBuf, u64)>,
    pub node_modules: Vec<PathBuf>,
    pub artifacts: Vec<PathBuf>,
    pub big_files: Vec<(PathBuf, u64, u64)>,
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
    let walker = WalkDirGeneric::<((), Option<Meta>)>::new(root)
        .skip_hidden(false)
        .sort(false)
        .follow_links(false)
        .parallelism(if parallel {
            Parallelism::RayonNewPool(threads)
        } else {
            Parallelism::Serial
        })
        .process_read_dir(move |_, _, _, children| {
            for child in children.iter_mut().flatten() {
                let meta = fs::symlink_metadata(child.parent_path.join(&child.file_name))
                    .ok()
                    .map(|m| meta_of(&m));
                if meta.is_none_or(|m| m.kind != Kind::Dir || m.dev != dev) {
                    child.read_children = None;
                }
                child.client_state = meta;
            }
        });

    let mut stack: Vec<Frame> = Vec::new();
    let mut total = None;
    for entry in walker {
        let Ok(entry) = entry else { continue };
        let Some(meta) = entry.client_state else {
            continue;
        };
        let depth = entry.depth;
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
        let name = entry.file_name.to_str();
        let parent = stack.last();
        let found = classify(plan, parent, name, &meta);
        let path_of = |p: Option<&Frame>| match p {
            Some(p) => p.path.join(&entry.file_name),
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
            if home.is_none() && path == plan.home {
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
