# Session Review for Hermes

Merge-request style review for [Hermes Agent](https://hermes-agent.nousresearch.com) sessions.

A **review session** is a directory under a central folder (default `~/Projects/sessions/<name>/`).
Every child folder is a git worktree of a repository the session changes, on branch `hermes/<name>`.
A pane docked next to the chat shows:

- a hierarchical file tree across all affected repos, with status letters, +/− counts and open-comment counts
- a GitLab-style diff (syntax highlighting, word-level changes, unified or split)
- per repo and per commit whether the work is already in the base branch ("Merged", "2 unmerged", …)
- comment threads: click a line to comment; the comment is sent to the Hermes session and the agent's
  final reply is posted back into the thread
- a list of all review sessions, a form to create one, and **Delete session** (keeps any branch that still
  has unmerged commits)

Plain chats are unaffected: a session is review-style only when you create it from the pane (or put it in a
session directory yourself).

## Install

```bash
hermes plugins install PavelFlegr/hermes-session-review --enable
```

Then:

1. Settings → Plugins: switch on **Session Review** (the desktop half is opt-in).
2. Restart the gateway once (`hermes gateway restart`); Python routes load at startup.
3. The **Review** pane docks to the right of the conversation.

## Use

- **New** in the pane: pick a name, optionally some repositories, and a task. Repositories can be left empty;
  the agent is told to add each one with `session-review add-repo <name> <path>` before editing it.
- Agents get the helper at `<plugin dir>/bin/session-review` (`add-repo`, `comments`, `reply`) and a
  `session-review-workflow` skill describing the rules.
- Merging is done in the source repo with ordinary git; the pane shows what has landed.

## Configuration

| Setting | Environment variable | Config key | Default |
|---|---|---|---|
| Where session directories live | `HERMES_SESSIONS_ROOT` | `sessions_root` | `~/Projects/sessions` |
| Where the New form looks for repos | `HERMES_REPO_SEARCH_ROOT` | `repo_search_root` | `~/Projects` |

Config keys go in `$HERMES_HOME/plugin-data/session-review/config.json`. The environment variable wins.

## Limits

- Syntax highlighting is line-based; a block comment or string opened on an earlier line is not recognised.
- The base branch is whatever the source repo has checked out now, not recorded at creation. Merge status is
  judged against it.
- Comments are anchored to the line numbers of the current diff; if the file changes they can point at the wrong
  line (an "outdated" badge marks comments made on an older commit).
- Unmerged detection assumes the work is merged by a real merge or fast-forward, not squash or rebase.

## Develop

```bash
uv run --no-project --with pytest python -m pytest -q tests      # core logic
node --test tests/plugin-logic.test.mjs                          # diff, tree and badge logic
ln -s "$PWD" ~/.hermes/plugins/session-review                    # live-develop; JS hot-reloads
```

The Python backend (`dashboard/plugin_api.py`) is imported once by the gateway, so route changes need a gateway restart.

MIT licensed.
