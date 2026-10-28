import subprocess
from pathlib import Path

import pytest

import review_core as core


def run(cwd: Path, *args: str) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def workspace(tmp_path):
    """A source repo on main plus a session directory holding one worktree of it."""
    source = tmp_path / "source"
    source.mkdir()
    run(source, "git", "init", "-q", "-b", "main")
    run(source, "git", "config", "user.email", "t@example.com")
    run(source, "git", "config", "user.name", "T")
    (source / "a.txt").write_text("one\ntwo\n")
    run(source, "git", "add", "-A")
    run(source, "git", "commit", "-qm", "init")
    session = tmp_path / "sessions" / "fix-bug"
    session.mkdir(parents=True)
    run(source, "git", "worktree", "add", "-q", "-b", "hermes/fix-bug", str(session / "source"))
    worktree = session / "source"
    run(worktree, "git", "config", "user.email", "t@example.com")
    run(worktree, "git", "config", "user.name", "T")
    return source, session, worktree


def test_discovers_worktrees_and_base(workspace):
    source, session, worktree = workspace
    assert core.list_worktrees(session) == [worktree]
    base = core.resolve_repo_base(worktree)
    assert (base.source_repo, base.base_branch) == (str(source), "main")


def test_changes_cover_committed_uncommitted_and_untracked(workspace):
    _, session, worktree = workspace
    (worktree / "a.txt").write_text("one\nTWO\nthree\n")
    run(worktree, "git", "commit", "-qam", "edit")
    (worktree / "b.txt").write_text("new\n")
    run(worktree, "git", "add", "b.txt")
    (worktree / "c.txt").write_text("x\ny\n")  # untracked
    summary = core.summarize_session(session)["repos"][0]
    by_path = {f["path"]: f for f in summary["files"]}
    assert by_path["a.txt"]["status"] == "modified" and by_path["a.txt"]["additions"] == 2
    assert by_path["b.txt"]["status"] == "added"
    assert by_path["c.txt"]["status"] == "untracked" and by_path["c.txt"]["additions"] == 2
    assert summary["uncommitted"] and len(summary["commits"]) == 1


def test_file_patch_for_tracked_and_untracked(workspace):
    _, _, worktree = workspace
    base = core.resolve_repo_base(worktree).merge_base
    (worktree / "a.txt").write_text("one\nchanged\n")
    (worktree / "n.txt").write_text("fresh\n")
    assert "+changed" in core.file_patch(worktree, base, "a.txt")
    assert "+fresh" in core.file_patch(worktree, base, "n.txt")


def test_comment_thread_lifecycle(workspace):
    _, session, _ = workspace
    comment = core.add_comment(session, repo="source", path="a.txt", line=2, commit="abc", body="why?")
    core.reply_to_comment(session, comment["id"], "fixed", resolve=True)
    stored = core.load_comments(session)
    assert stored[0]["status"] == "resolved"
    assert [m["author"] for m in stored[0]["thread"]] == ["user", "agent"]
    message = core.format_comment_for_agent(stored[0])
    assert "a.txt:2" in message and "RUNNING this shell command" in message
    with pytest.raises(core.ReviewError):
        core.reply_to_comment(session, "nope", "x")


def test_merge_removes_session_and_lands_commits(workspace):
    source, session, worktree = workspace
    (worktree / "a.txt").write_text("one\ntwo\nthree\n")
    run(worktree, "git", "commit", "-qam", "add three")
    core.add_comment(session, repo="source", path=None, line=None, commit=None, body="ok")
    dry_log = core.merge_and_remove(session, dry_run=True)
    assert session.exists() and "merge hermes/fix-bug into main" in dry_log[0]
    core.merge_and_remove(session)
    assert not session.exists()
    assert (source / "a.txt").read_text() == "one\ntwo\nthree\n"
    assert "hermes/fix-bug" not in subprocess.run(["git", "-C", str(source), "branch"], capture_output=True, text=True).stdout


def test_merge_refuses_uncommitted_worktree(workspace):
    _, session, worktree = workspace
    (worktree / "a.txt").write_text("dirty\n")
    with pytest.raises(core.ReviewError, match="uncommitted"):
        core.merge_and_remove(session)
    assert session.exists()


def test_merge_conflict_aborts_and_keeps_session(workspace):
    source, session, worktree = workspace
    (worktree / "a.txt").write_text("session\ntwo\n")
    run(worktree, "git", "commit", "-qam", "session edit")
    (source / "a.txt").write_text("main\ntwo\n")
    run(source, "git", "commit", "-qam", "main edit")
    with pytest.raises(core.ReviewError, match="failed"):
        core.merge_and_remove(session)
    assert session.exists() and not core.has_uncommitted_changes(source)
