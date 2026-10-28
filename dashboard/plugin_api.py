"""HTTP routes for the session-review desktop page. Thin wrappers over review_core."""
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import review_core as core  # noqa: E402

router = APIRouter()


class NewComment(BaseModel):
    repo: str
    path: str | None = None
    line: int | None = None
    commit: str | None = None
    body: str


class Reply(BaseModel):
    body: str
    resolve: bool = False
    author: str = "user"


class Status(BaseModel):
    status: str


class NewSession(BaseModel):
    name: str
    repos: list[str]


class MergeRequest(BaseModel):
    dry_run: bool = False


def _session(name: str) -> Path:
    try:
        return core.session_dir(name)
    except core.ReviewError as error:
        raise HTTPException(404, str(error))


def _worktree(session: Path, repo: str) -> Path:
    for worktree in core.list_worktrees(session):
        if worktree.name == repo:
            return worktree
    raise HTTPException(404, f"no repo {repo!r} in session {session.name}")


def _review_errors_as_http(call):
    try:
        return call()
    except core.ReviewError as error:
        raise HTTPException(400, str(error))


@router.get("/sessions")
def list_sessions():
    rows = []
    for name in core.list_session_names():
        session = core.sessions_root() / name
        summary = _review_errors_as_http(lambda: core.summarize_session(session))
        rows.append({
            "name": name,
            "repos": len(summary["repos"]),
            "additions": sum(r["additions"] for r in summary["repos"]),
            "deletions": sum(r["deletions"] for r in summary["repos"]),
            "open_comments": summary["open_comments"],
            "hermes_sessions": core.linked_hermes_sessions(session),
        })
    return {"root": str(core.sessions_root()), "sessions": rows}


@router.get("/repos")
def candidate_repos():
    return {"repos": core.list_candidate_repos(), "sessions_root": str(core.sessions_root())}


@router.post("/sessions")
def create_session(body: NewSession):
    if not core.SESSION_NAME_PATTERN.match(body.name):
        raise HTTPException(400, "session name must be lowercase letters, digits and dashes")
    session = _review_errors_as_http(lambda: core.create_session(body.name, [Path(r) for r in body.repos]))
    return {"name": session.name, "path": str(session)}


@router.get("/sessions/{name}")
def get_session(name: str):
    session = _session(name)
    summary = _review_errors_as_http(lambda: core.summarize_session(session))
    summary["comments"] = core.load_comments(session)
    summary["hermes_sessions"] = core.linked_hermes_sessions(session)
    return summary


@router.get("/sessions/{name}/patch")
def get_patch(name: str, repo: str, path: str):
    worktree = _worktree(_session(name), repo)
    if not (worktree / path).resolve().is_relative_to(worktree.resolve()):
        raise HTTPException(400, "path escapes the worktree")
    base = core.resolve_repo_base(worktree)
    return {"patch": core.file_patch(worktree, base.merge_base, path)}


@router.post("/sessions/{name}/comments")
def create_comment(name: str, body: NewComment):
    session = _session(name)
    _worktree(session, body.repo)
    comment = core.add_comment(session, **body.model_dump())
    return {"comment": comment, "agent_message": core.format_comment_for_agent(comment)}


@router.post("/sessions/{name}/comments/{comment_id}/reply")
def reply(name: str, comment_id: str, body: Reply):
    return _review_errors_as_http(lambda: core.reply_to_comment(
        _session(name), comment_id, body.body, author=body.author, resolve=body.resolve))


@router.post("/sessions/{name}/comments/{comment_id}/status")
def set_status(name: str, comment_id: str, body: Status):
    return _review_errors_as_http(lambda: core.set_comment_status(_session(name), comment_id, body.status))


@router.post("/sessions/{name}/merge")
def merge(name: str, body: MergeRequest):
    log = _review_errors_as_http(lambda: core.merge_and_remove(_session(name), dry_run=body.dry_run))
    return {"log": log}
