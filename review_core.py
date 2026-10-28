"""Core logic for session review: a session is a directory, each child git worktree is an affected repo.

Layout under the sessions root:
    <root>/<session-name>/<repo-name>/      git worktree of a source repo on its own branch
    <root>/<session-name>/.review/comments.json

Stdlib only, so the HTTP routes, the CLI and the tests all share it.
"""
from __future__ import annotations

import fcntl
import json
import os
import sqlite3
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

REVIEW_DIRNAME = ".review"
COMMENTS_FILENAME = "comments.json"
FALLBACK_BASE_BRANCHES = ("main", "master")
CLI_PATH = Path(__file__).resolve().parent / "bin" / "session-review"


class ReviewError(Exception):
    """A problem the caller should show to the user as-is."""


def sessions_root() -> Path:
    return Path(os.environ.get("HERMES_SESSIONS_ROOT", Path.home() / "Projects" / "sessions"))


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, errors="replace"
    )
    if check and result.returncode != 0:
        raise ReviewError(f"git {' '.join(args)} failed in {repo}: {result.stderr.strip()}")
    return result.stdout


# --- discovery -------------------------------------------------------------

def session_dir(name: str, root: Path | None = None) -> Path:
    root = root or sessions_root()
    if "/" in name or name.startswith("."):
        raise ReviewError(f"invalid session name: {name!r}")
    path = root / name
    if not path.is_dir():
        raise ReviewError(f"no such session directory: {path}")
    return path


def list_session_names(root: Path | None = None) -> list[str]:
    root = root or sessions_root()
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))


def list_worktrees(session: Path) -> list[Path]:
    """Direct children that are git worktrees (their .git is a file pointing at the source repo)."""
    return sorted(p for p in session.iterdir() if p.is_dir() and (p / ".git").exists())


@dataclass
class RepoBase:
    source_repo: str   # the repo this worktree was created from
    base_branch: str   # branch the session will merge into
    merge_base: str    # commit the session branch forked from


def resolve_repo_base(worktree: Path) -> RepoBase:
    common_dir = Path(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").strip())
    source_repo = common_dir.parent
    base_branch = _source_checked_out_branch(source_repo)
    merge_base = git(worktree, "merge-base", "HEAD", base_branch).strip()
    return RepoBase(str(source_repo), base_branch, merge_base)


def _source_checked_out_branch(source_repo: Path) -> str:
    branch = git(source_repo, "symbolic-ref", "--short", "-q", "HEAD", check=False).strip()
    if branch:
        return branch
    for candidate in FALLBACK_BASE_BRANCHES:
        if git(source_repo, "rev-parse", "--verify", "-q", candidate, check=False).strip():
            return candidate
    raise ReviewError(f"cannot determine base branch of {source_repo}")


# --- changes ---------------------------------------------------------------

@dataclass
class FileChange:
    path: str
    status: str        # added | modified | deleted | untracked
    additions: int
    deletions: int


def list_file_changes(worktree: Path, base_commit: str) -> list[FileChange]:
    """Everything that differs from the fork point: commits, staged, unstaged and untracked."""
    statuses = _name_status(worktree, base_commit)
    changes = []
    for line in git(worktree, "diff", "--numstat", "--no-renames", base_commit).splitlines():
        added, deleted, path = line.split("\t", 2)
        binary = added == "-"
        changes.append(FileChange(path, statuses.get(path, "modified"),
                                  0 if binary else int(added), 0 if binary else int(deleted)))
    for path in git(worktree, "ls-files", "--others", "--exclude-standard").splitlines():
        changes.append(FileChange(path, "untracked", _count_lines(worktree / path), 0))
    return changes


def _name_status(worktree: Path, base_commit: str) -> dict[str, str]:
    names = {"A": "added", "M": "modified", "D": "deleted"}
    statuses = {}
    for line in git(worktree, "diff", "--name-status", "--no-renames", base_commit).splitlines():
        letter, path = line.split("\t", 1)
        statuses[path] = names.get(letter[0], "modified")
    return statuses


def _count_lines(path: Path) -> int:
    try:
        return len(path.read_text(errors="replace").splitlines())
    except OSError:
        return 0


def file_patch(worktree: Path, base_commit: str, path: str) -> str:
    """Unified diff of one file against the fork point; untracked files diff against /dev/null."""
    is_tracked = bool(git(worktree, "ls-files", "--", path).strip())
    if is_tracked or _exists_in_commit(worktree, base_commit, path):
        return git(worktree, "diff", "--no-renames", base_commit, "--", path)
    result = subprocess.run(
        ["git", "-C", str(worktree), "diff", "--no-index", "--", "/dev/null", path],
        capture_output=True, text=True, errors="replace",
    )
    return result.stdout  # exit code 1 means "differs", which is expected here


def _exists_in_commit(worktree: Path, commit: str, path: str) -> bool:
    return subprocess.run(["git", "-C", str(worktree), "cat-file", "-e", f"{commit}:{path}"],
                          capture_output=True).returncode == 0


def head_commit(worktree: Path) -> str:
    return git(worktree, "rev-parse", "HEAD").strip()


def commit_log(worktree: Path, base_commit: str) -> list[dict]:
    lines = git(worktree, "log", "--format=%H%x09%an%x09%at%x09%s", f"{base_commit}..HEAD").splitlines()
    return [dict(zip(("sha", "author", "time", "subject"), line.split("\t", 3))) for line in lines]


def has_uncommitted_changes(worktree: Path) -> bool:
    return bool(git(worktree, "status", "--porcelain").strip())


def summarize_session(session: Path) -> dict:
    repos = []
    for worktree in list_worktrees(session):
        base = resolve_repo_base(worktree)
        changes = list_file_changes(worktree, base.merge_base)
        repos.append({
            "name": worktree.name,
            "branch": git(worktree, "rev-parse", "--abbrev-ref", "HEAD").strip(),
            **asdict(base),
            "head": head_commit(worktree),
            "commits": commit_log(worktree, base.merge_base),
            "uncommitted": has_uncommitted_changes(worktree),
            "files": [asdict(c) for c in changes],
            "additions": sum(c.additions for c in changes),
            "deletions": sum(c.deletions for c in changes),
        })
    return {"name": session.name, "path": str(session), "repos": repos,
            "open_comments": sum(1 for c in load_comments(session) if c["status"] == "open")}


# --- comments --------------------------------------------------------------

def _comments_path(session: Path) -> Path:
    return session / REVIEW_DIRNAME / COMMENTS_FILENAME


def load_comments(session: Path) -> list[dict]:
    path = _comments_path(session)
    return json.loads(path.read_text()) if path.exists() else []


@contextmanager
def _locked_comments(session: Path):
    """Read-modify-write the comments file; the lock keeps the UI and the agent from clobbering each other."""
    path = _comments_path(session)
    path.parent.mkdir(exist_ok=True)
    with open(path.parent / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        comments = load_comments(session)
        yield comments
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(comments, indent=2))
        temporary.replace(path)


def add_comment(session: Path, *, repo: str, path: str | None, line: int | None,
                commit: str | None, body: str, author: str = "user") -> dict:
    comment = {"id": uuid.uuid4().hex[:8], "repo": repo, "path": path, "line": line,
               "commit": commit, "status": "open", "created": time.time(),
               "thread": [{"author": author, "body": body, "time": time.time()}]}
    with _locked_comments(session) as comments:
        comments.append(comment)
    return comment


def reply_to_comment(session: Path, comment_id: str, body: str, *,
                     author: str = "agent", resolve: bool = False) -> dict:
    with _locked_comments(session) as comments:
        comment = _find_comment(comments, comment_id)
        comment["thread"].append({"author": author, "body": body, "time": time.time()})
        if resolve:
            comment["status"] = "resolved"
    return comment


def set_comment_status(session: Path, comment_id: str, status: str) -> dict:
    if status not in ("open", "resolved"):
        raise ReviewError(f"invalid status: {status}")
    with _locked_comments(session) as comments:
        comment = _find_comment(comments, comment_id)
        comment["status"] = status
    return comment


def _find_comment(comments: list[dict], comment_id: str) -> dict:
    for comment in comments:
        if comment["id"] == comment_id:
            return comment
    raise ReviewError(f"no such comment: {comment_id}")


def format_comment_for_agent(comment: dict) -> str:
    where = comment["repo"] + (f"/{comment['path']}" if comment["path"] else "")
    if comment["line"]:
        where += f":{comment['line']}"
    return (f"Review comment {comment['id']} on {where}:\n{comment['thread'][-1]['body']}\n\n"
            f"Make the change if needed, commit it, then answer with: "
            f"{CLI_PATH} reply {comment['id']} \"<your answer>\" [--resolve]")


# --- link to hermes sessions ------------------------------------------------

def linked_hermes_sessions(session: Path, state_db: Path | None = None) -> list[dict]:
    """Hermes sessions (state.db) whose working directory is this session directory or below it."""
    state_db = state_db or Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "state.db"
    if not state_db.exists():
        return []
    connection = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT id, title, last_activity_at, message_count, ended_at FROM sessions "
            "WHERE cwd = ?1 OR cwd LIKE ?1 || '/%' ORDER BY last_activity_at DESC", (str(session),)
        ).fetchall()
    finally:
        connection.close()
    return [dict(zip(("id", "title", "last_activity_at", "message_count", "ended_at"), r)) for r in rows]


# --- merge and delete ------------------------------------------------------

def merge_and_remove(session: Path, *, dry_run: bool = False) -> list[str]:
    """Merge every worktree branch into its source repo's base branch, then delete the session.

    All repos are checked first; nothing is merged unless every repo can be.
    Returns a log of what was (or would be) done.
    """
    worktrees = list_worktrees(session)
    plans = [(wt, resolve_repo_base(wt)) for wt in worktrees]
    for worktree, base in plans:
        _check_mergeable(worktree, base)
    log = []
    for worktree, base in plans:
        branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD").strip()
        log.append(f"{worktree.name}: merge {branch} into {base.base_branch} of {base.source_repo}")
        if not dry_run:
            _merge_branch(Path(base.source_repo), branch, base.base_branch)
    if not dry_run:
        for worktree, base in plans:
            branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD").strip()
            git(Path(base.source_repo), "worktree", "remove", "--force", str(worktree))
            git(Path(base.source_repo), "branch", "-d", branch)
        _remove_review_state(session)
        log.append(f"removed {session}")
    return log


def _check_mergeable(worktree: Path, base: RepoBase) -> None:
    source = Path(base.source_repo)
    if has_uncommitted_changes(worktree):
        raise ReviewError(f"{worktree.name}: uncommitted changes in the session worktree")
    if has_uncommitted_changes(source):
        raise ReviewError(f"{worktree.name}: source repo {source} has uncommitted changes")
    if _source_checked_out_branch(source) != base.base_branch:
        raise ReviewError(f"{worktree.name}: source repo is no longer on {base.base_branch}")


def _merge_branch(source: Path, branch: str, base_branch: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(source), "merge", "--no-ff", "-m", f"Merge session branch {branch}", branch],
        capture_output=True, text=True)
    if result.returncode != 0:
        git(source, "merge", "--abort", check=False)
        raise ReviewError(f"merge of {branch} into {base_branch} failed: {result.stdout}{result.stderr}")


def _remove_review_state(session: Path) -> None:
    review_dir = session / REVIEW_DIRNAME
    for child in review_dir.glob("*") if review_dir.exists() else []:
        child.unlink()
    if review_dir.exists():
        review_dir.rmdir()
    session.rmdir()  # fails loudly if the agent left unexpected files behind
