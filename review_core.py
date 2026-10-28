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
import re
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


def _setting(env_name: str, config_key: str, default: Path) -> Path:
    """Environment variable first, then `$HERMES_HOME/plugin-data/session-review/config.json`, then the default."""
    if env_name in os.environ:
        return Path(os.environ[env_name]).expanduser()
    config_file = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "plugin-data" / "session-review" / "config.json"
    if config_file.exists():
        configured = json.loads(config_file.read_text()).get(config_key)
        if configured:
            return Path(configured).expanduser()
    return default


def sessions_root() -> Path:
    return _setting("HERMES_SESSIONS_ROOT", "sessions_root", Path.home() / "Projects" / "sessions")


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
    base_branch: str   # branch the session's work is compared against
    fork_point: str    # commit the session branch started from; the diff baseline


def resolve_repo_base(worktree: Path) -> RepoBase:
    common_dir = Path(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").strip())
    source_repo = common_dir.parent
    base_branch = _source_checked_out_branch(source_repo)
    return RepoBase(str(source_repo), base_branch, _fork_point(worktree, source_repo, base_branch))


def _fork_point(worktree: Path, source_repo: Path, base_branch: str) -> str:
    """The recorded session start, or (for sessions made before it was recorded) the merge-base."""
    branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD").strip()
    recorded = git(source_repo, "config", f"branch.{branch}.sessionBase", check=False).strip()
    if recorded and _commit_exists(source_repo, recorded):
        return recorded
    return git(worktree, "merge-base", "HEAD", base_branch).strip()


def _commit_exists(repo: Path, commit: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{commit}^{{commit}}"],
                          capture_output=True).returncode == 0


def _source_checked_out_branch(source_repo: Path) -> str:
    branch = git(source_repo, "symbolic-ref", "--short", "-q", "HEAD", check=False).strip()
    if branch:
        return branch
    for candidate in FALLBACK_BASE_BRANCHES:
        if git(source_repo, "rev-parse", "--verify", "-q", candidate, check=False).strip():
            return candidate
    raise ReviewError(f"cannot determine base branch of {source_repo}")


# --- creating a review session ------------------------------------------------

SESSION_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def repo_search_root() -> Path:
    return _setting("HERMES_REPO_SEARCH_ROOT", "repo_search_root", Path.home() / "Projects")


def list_candidate_repos() -> list[dict]:
    """Real repositories (not worktrees) directly under the search root."""
    root = repo_search_root()
    if not root.is_dir():
        return []
    return [{"name": p.name, "path": str(p)} for p in sorted(root.iterdir())
            if (p / ".git").is_dir() and p != sessions_root()]


def add_repo_to_session(session_name: str, source_repo: Path) -> Path:
    """Create `<session>/<repo>` as a worktree on branch `hermes/<session>` forked from the repo's current branch."""
    if not SESSION_NAME_PATTERN.match(session_name):
        raise ReviewError("session name must be lowercase letters, digits and dashes")
    source_repo = source_repo.resolve()
    if not (source_repo / ".git").is_dir():
        raise ReviewError(f"{source_repo} is not the root of a git repository")
    session = sessions_root() / session_name
    target = session / source_repo.name
    if target.exists():
        raise ReviewError(f"{target} already exists")
    session.mkdir(parents=True, exist_ok=True)
    branch = f"hermes/{session_name}"
    fork_point = git(source_repo, "rev-parse", "HEAD").strip()
    git(source_repo, "worktree", "add", "-b", branch, str(target))
    # Remember where the session started: after the branch is merged, the merge-base would equal HEAD
    # and the review would show an empty diff.
    git(source_repo, "config", f"branch.{branch}.sessionBase", fork_point)
    return target


def create_session(session_name: str, source_repos: list[Path]) -> Path:
    """Create a session directory with one worktree per repo; leave nothing behind if any repo fails.

    With no repos the directory is created empty; the agent adds worktrees later with `add-repo`.
    """
    if not SESSION_NAME_PATTERN.match(session_name):
        raise ReviewError("session name must be lowercase letters, digits and dashes")
    session = sessions_root() / session_name
    if session.exists():
        raise ReviewError(f"session {session_name!r} already exists")
    session.mkdir(parents=True)
    created: list[tuple[Path, Path]] = []
    try:
        for source in source_repos:
            created.append((source.resolve(), add_repo_to_session(session_name, source)))
    except ReviewError:
        for source, worktree in created:
            git(source, "worktree", "remove", "--force", str(worktree), check=False)
            git(source, "branch", "-D", f"hermes/{session_name}", check=False)
        if not any(session.iterdir()):
            session.rmdir()
        raise
    return session


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


def commit_log(worktree: Path, base: RepoBase) -> list[dict]:
    """Session commits, newest first, each marked with whether the base branch already contains it."""
    lines = git(worktree, "log", "--format=%H%x09%an%x09%at%x09%s", f"{base.fork_point}..HEAD").splitlines()
    commits = [dict(zip(("sha", "author", "time", "subject"), line.split("\t", 3))) for line in lines]
    for commit in commits:
        commit["merged"] = _is_ancestor(Path(base.source_repo), commit["sha"], base.base_branch)
    return commits


def merge_state(commits: list[dict]) -> str:
    """none (nothing committed), merged (all in the base branch), partial, or unmerged."""
    merged = sum(1 for c in commits if c["merged"])
    if not commits:
        return "none"
    return "merged" if merged == len(commits) else "partial" if merged else "unmerged"


def session_merge_state(repo_states: list[str]) -> str:
    """Whole-session summary: unmerged if any repo has unmerged commits, merged if the rest are merged or empty."""
    if any(state in ("unmerged", "partial") for state in repo_states):
        return "unmerged"
    return "merged" if "merged" in repo_states else "none"


def has_uncommitted_changes(worktree: Path) -> bool:
    return bool(git(worktree, "status", "--porcelain").strip())


def summarize_session(session: Path) -> dict:
    repos = []
    for worktree in list_worktrees(session):
        base = resolve_repo_base(worktree)
        changes = list_file_changes(worktree, base.fork_point)
        commits = commit_log(worktree, base)
        repos.append({
            "name": worktree.name,
            "branch": git(worktree, "rev-parse", "--abbrev-ref", "HEAD").strip(),
            **asdict(base),
            "head": head_commit(worktree),
            "commits": commits,
            "merge_state": merge_state(commits),
            "unmerged_commits": sum(1 for c in commits if not c["merged"]),
            "uncommitted": has_uncommitted_changes(worktree),
            "files": [asdict(c) for c in changes],
            "additions": sum(c.additions for c in changes),
            "deletions": sum(c.deletions for c in changes),
        })
    return {"name": session.name, "path": str(session), "repos": repos,
            "merge_state": session_merge_state([r["merge_state"] for r in repos]),
            "unmerged_repos": sum(1 for r in repos if r["unmerged_commits"] > 0),
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
            f"If a change is needed, make it and commit it. Your final reply to this message is "
            f"posted to the review thread automatically, so answer the reviewer directly.")


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


# --- delete ----------------------------------------------------------------------------------

def delete_session(session: Path, *, dry_run: bool = False) -> list[str]:
    """Remove the session's worktrees, review state and directory.

    A session branch is deleted only when everything on it is already in the base branch; otherwise the
    branch stays in the source repo so no commits are lost. Uncommitted changes in a worktree are discarded.
    Returns a log of what was (or would be) done.
    """
    log = []
    removals = []
    for worktree in list_worktrees(session):
        base = resolve_repo_base(worktree)
        source = Path(base.source_repo)
        branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD").strip()
        fully_merged = _is_ancestor(source, branch, base.base_branch)
        if has_uncommitted_changes(worktree):
            log.append(f"{worktree.name}: uncommitted changes will be discarded")
        log.append(f"{worktree.name}: remove worktree; " + (
            f"delete branch {branch} (already in {base.base_branch})" if fully_merged
            else f"keep branch {branch} in {source} (has commits not in {base.base_branch})"))
        removals.append((worktree, source, branch, fully_merged))
    log.append(f"remove {session}")
    if dry_run:
        return log
    for worktree, source, branch, fully_merged in removals:
        git(source, "worktree", "remove", "--force", str(worktree))
        if fully_merged:
            git(source, "branch", "-D", branch)
    _remove_review_state(session)
    return log


def _is_ancestor(repo: Path, commit: str, other: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", commit, other],
                          capture_output=True).returncode == 0


def _remove_review_state(session: Path) -> None:
    review_dir = session / REVIEW_DIRNAME
    for child in review_dir.glob("*") if review_dir.exists() else []:
        child.unlink()
    if review_dir.exists():
        review_dir.rmdir()
    session.rmdir()  # fails loudly if the agent left unexpected files behind
