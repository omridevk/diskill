#!/usr/bin/env python3
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
IDLE_DAYS = float(os.environ.get("CLEAN_DISK_WORKTREE_IDLE_DAYS", "2"))
SEARCH_DEPTH = int(os.environ.get("CLEAN_DISK_REPO_DEPTH", "6"))

REGENERABLE_DIRS = {
    "node_modules", "dist", "build", "out", ".turbo", ".next", ".nuxt", ".svelte-kit", ".output",
    ".vinxi", ".tanstack", "coverage", "test-results", "playwright-report", "storybook-static",
    ".cache", ".parcel-cache", ".vite", ".fallow", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", "target", ".venv", "venv", ".gradle", "DerivedData",
}
REGENERABLE_SUFFIXES = (".tsbuildinfo", ".log", ".pyc", ".DS_Store")
SKIP_DIRS = {"Library", ".Trash", "node_modules", ".cache", ".npm", ".nvm", ".cargo", ".rustup",
             ".local", ".docker", ".orbstack", "go", ".gradle", ".m2", "Applications"}
IN_PROGRESS = ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge",
               "rebase-apply", "sequencer")


def git(cwd, *args):
    result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return result.returncode, result.stdout


def find_repos():
    repos = []
    for root, dirs, _ in os.walk(HOME):
        depth = root[len(HOME):].count(os.sep)
        if ".git" in dirs and os.path.isdir(os.path.join(root, ".git")):
            repos.append(root)
        dirs[:] = [d for d in dirs if d != ".git" and d not in SKIP_DIRS and depth < SEARCH_DEPTH
                   and not (root == HOME and d.startswith(".") and d not in {".claude"})]
    return repos


def list_worktrees(repo):
    code, out = git(repo, "worktree", "list", "--porcelain")
    if code != 0:
        return []
    entries = []
    for block in out.strip().split("\n\n"):
        entry = {}
        for line in block.splitlines():
            key, _, value = line.partition(" ")
            entry[key] = value
        if entry.get("worktree"):
            entries.append(entry)
    return entries[1:]


def process_cwds():
    result = subprocess.run(["lsof", "-a", "-d", "cwd", "-u", str(os.getuid()), "-Fn"],
                            capture_output=True, text=True)
    return {line[1:] for line in result.stdout.splitlines() if line.startswith("n")}


def is_regenerable(entry):
    parts = entry.rstrip("/").split("/")
    return any(part in REGENERABLE_DIRS for part in parts) or parts[-1].endswith(REGENERABLE_SUFFIXES)


def last_activity(git_dir):
    stamps = [os.stat(os.path.join(git_dir, name)).st_mtime
              for name in ("HEAD", "index", os.path.join("logs", "HEAD"))
              if os.path.exists(os.path.join(git_dir, name))]
    return (time.time() - max(stamps)) / 86400 if stamps else 0.0


def orphaned_reflog_commits(path):
    code, out = git(path, "reflog", "show", "--format=%H", "-n", "500", "HEAD")
    hashes = sorted(set(out.split())) if code == 0 else []
    if not hashes:
        return 0
    code, out = git(path, "rev-list", "--count", *hashes, "--not", "--branches", "--tags", "--remotes",
                    "--glob=refs/stash")
    return int(out.strip() or 0) if code == 0 else -1


def evaluate(repo, entry, cwds):
    path = entry["worktree"]
    blockers = []
    if not os.path.isdir(path):
        return ["folder missing (stale entry, cleared by git worktree prune)"], {}
    if "locked" in entry:
        blockers.append("locked")
    code, git_dir = git(path, "rev-parse", "--absolute-git-dir")
    git_dir = git_dir.strip()
    if code != 0 or not git_dir:
        return ["not a readable git worktree"], {}
    real = os.path.realpath(path)
    if any(os.path.realpath(c) == real or os.path.realpath(c).startswith(real + os.sep) for c in cwds):
        blockers.append("a running process is inside it")
    for marker in IN_PROGRESS:
        if os.path.exists(os.path.join(git_dir, marker)):
            blockers.append("git operation in progress (%s)" % marker)
    if os.path.exists(os.path.join(path, ".gitmodules")):
        blockers.append("has submodules")
    code, status = git(path, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")
    changes = [line for line in status.splitlines() if line.strip()]
    if code != 0:
        blockers.append("git status failed")
    elif changes:
        blockers.append("%d uncommitted or untracked files" % len(changes))
    code, ignored = git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
    kept = [e for e in ignored.split("\0") if e and not is_regenerable(e)]
    if code != 0:
        blockers.append("could not list ignored files")
    elif kept:
        blockers.append("ignored files that are not build output: %s" % ", ".join(kept[:3])
                        + (" +%d more" % (len(kept) - 3) if len(kept) > 3 else ""))
    code, worktree_refs = git(path, "for-each-ref", "--format=%(refname)", "refs/worktree", "refs/bisect")
    if worktree_refs.strip():
        blockers.append("has worktree-only refs")
    branch = entry.get("branch", "").replace("refs/heads/", "")
    if not branch:
        code, holders = git(path, "for-each-ref", "--contains", "HEAD", "--format=%(refname)",
                            "refs/heads", "refs/remotes", "refs/tags")
        if not holders.strip():
            blockers.append("detached HEAD with commits on no branch")
    orphans = orphaned_reflog_commits(path)
    if orphans != 0:
        blockers.append("%s commits exist only in this worktree's history" % ("some" if orphans < 0 else orphans))
    code, upstream = git(path, "rev-parse", "--abbrev-ref", "@{u}")
    unpushed = None
    if code == 0:
        code, count = git(path, "rev-list", "--count", "@{u}..HEAD")
        unpushed = int(count.strip() or 0) if code == 0 else None
    return blockers, {"branch": branch or "detached", "unpushed": unpushed, "has_upstream": bool(upstream.strip()),
                      "idle": last_activity(git_dir)}


def size_bytes(path):
    out = subprocess.run(["du", "-skx", path], capture_output=True, text=True).stdout.split()
    return int(out[0]) * 1024 if out and out[0].isdigit() else 0


def emit(cat_id, title, desc, risk, pre, label, path, size, note, age):
    fields = [cat_id, title, desc, risk, pre, "worktree", "-", label, path, str(size), note, age, "exact"]
    if not any("\t" in f or "\n" in f for f in fields):
        print("\t".join(fields))


def scan():
    cwds = process_cwds()
    for repo in find_repos():
        for entry in list_worktrees(repo):
            path = entry["worktree"]
            if not os.path.isdir(path):
                continue
            blockers, info = evaluate(repo, entry, cwds)
            label = path.replace(HOME, "~", 1)
            age = str(int(info["idle"])) if info else "-"
            if blockers:
                emit("worktrees-kept", "Git worktrees kept (report only)",
                     "Worktrees that still hold work or are in use. Never removed.", "report", "0",
                     label, path, size_bytes(path), "Kept: " + "; ".join(blockers), age)
                continue
            if info["unpushed"] is None:
                push = "branch never pushed; its commits stay on the local branch"
            elif info["unpushed"]:
                push = "%d unpushed commits stay on the local branch" % info["unpushed"]
            else:
                push = "branch is pushed"
            idle = info["idle"] >= IDLE_DAYS
            note = "Branch %s is kept, %s. Re-create with: git worktree add %s %s" % (
                info["branch"], push, label, info["branch"])
            if not idle:
                note = "Active %.1f days ago. " % info["idle"] + note
            emit("worktrees", "Git worktrees with no leftover work",
                 "Clean worktrees: no uncommitted, untracked or local-only ignored files, no process inside, "
                 "nothing that exists only in the worktree. Only the folder goes; the branch and every commit stay. "
                 "Every check is repeated right before removal.",
                 "safe", "1" if idle else "0", label, path, size_bytes(path), note, age)


def common_repo(path):
    code, common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return os.path.dirname(common.strip()) if code == 0 and common.strip() else None


def remove(paths):
    cwds = process_cwds()
    touched = set()
    for path in paths:
        repo = common_repo(path) if os.path.isdir(path) else None
        entry = next((e for e in list_worktrees(repo) if os.path.realpath(e["worktree"]) == os.path.realpath(path)),
                     None) if repo else None
        if entry is None:
            print("KEPT    %s (not a registered worktree)" % path)
            continue
        blockers, _ = evaluate(repo, entry, cwds)
        if blockers:
            print("KEPT    %s (%s)" % (path, "; ".join(blockers)))
            continue
        result = subprocess.run(["git", "-C", repo, "worktree", "remove", path], capture_output=True, text=True)
        if result.returncode == 0 and not os.path.exists(path):
            print("removed worktree %s" % path)
            touched.add(repo)
        else:
            print("KEPT    %s (git refused: %s)" % (path, result.stderr.strip().splitlines()[-1:] or "?"))
    for repo in touched:
        git(repo, "worktree", "prune")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "scan":
        scan()
    elif len(sys.argv) >= 2 and sys.argv[1] == "remove":
        remove([line.rstrip("\n") for line in sys.stdin if line.strip()])
    else:
        print("usage: worktrees.py scan | remove < paths", file=sys.stderr)
        sys.exit(2)
