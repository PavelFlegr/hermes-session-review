---
name: session-review-workflow
description: Use when working in a review-style session directory (worktrees under the sessions root).
---

# Working in a review-style session

A review-style session is a directory (default `~/Projects/sessions/<name>/`) whose child folders are
git worktrees of the repositories you change, each on branch `hermes/<name>`. A reviewer reads your diff in
the Session Review pane and sends comments to this chat.

## Rules
- Edit repositories only through their worktree inside the session directory, never the original checkout.
- Add a repository to the session before changing it: `session-review add-repo <session-name> <path-to-repo>`
  (the helper is `bin/session-review` inside the installed plugin).
- Commit at the end of every turn, in small commits with descriptive messages, so the reviewer sees stable
  diffs. Uncommitted work is shown but flagged.
- Review comments arrive as messages naming `repo/path:line`. Make the change if one is needed, commit it, and
  answer the reviewer directly. Your final reply is posted to the comment thread automatically.
- Do not merge or delete the session; the reviewer does that. Deleting keeps any branch with unmerged commits.
