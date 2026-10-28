// Session Review: merge-request style review of Hermes sessions.
// A session is a directory under the sessions root; each child worktree is an affected repo.
// Data comes from this plugin's Python backend (ctx.rest); comments are delivered to the
// Hermes session through the gateway (host.request).
import {
  Badge, Button, Input, Textarea, ROUTES_AREA, SIDEBAR_NAV_AREA, host, queryClient, useQuery
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-review'
const POLL_MS = 5000
const ADDED_TINT = 'color-mix(in srgb, #2ea043 18%, transparent)'
const REMOVED_TINT = 'color-mix(in srgb, #f85149 18%, transparent)'

// The app shell disables text selection; review content must be selectable and copyable.
const SELECTABLE = { userSelect: 'text', cursor: 'text' }
const userIsSelectingText = () => Boolean(window.getSelection()?.toString())

const refresh = () => queryClient.invalidateQueries({ queryKey: [ID] })

// --- delivering text to the Hermes session -------------------------------------------

// Comments sent to a live session, waiting for that session's next final reply.
// runtime session id -> [{ sessionName, commentId, sentAt }] (oldest first)
const pendingReplies = new Map()

/** Resume the stored session (reuses it if live) and send it a user turn. Returns the runtime id. */
async function sendToHermesSession(storedSessionId, text) {
  const resumed = await host.request('session.resume', { session_id: storedSessionId, lazy: true })
  await host.request('prompt.submit', { session_id: resumed.session_id, text })
  return resumed.session_id
}

/**
 * Sessions that saw the old "run this command" instruction keep answering with the command
 * itself. Unwrap `session-review reply <id> "<answer>" [--resolve]` into just the answer.
 */
export function unwrapReplyCommand(text) {
  const command = /session-review\s+reply\s+\w+\s+"((?:[^"\\]|\\.)*)"\s*(--resolve)?\s*$/.exec(text)
  if (!command) return { answer: text, resolve: false }
  return { answer: command[1].replace(/\\(.)/g, '$1'), resolve: Boolean(command[2]) }
}

/** The agent's final message for a turn becomes its answer in the comment thread. */
async function postFinalReplyToThread(event) {
  if (event.replayed) return // a reconnect replaying an old turn must not repost it
  const runtimeSessionId = event.session_id ?? event.sessionId
  const text = (event.payload?.text ?? '').trim()
  const waiting = pendingReplies.get(runtimeSessionId)
  if (!waiting?.length || !text) return
  const { sessionName, commentId, sentAt } = waiting.shift()
  const session = await ctx.rest(`/sessions/${sessionName}`)
  const thread = session.comments.find(c => c.id === commentId)?.thread ?? []
  const agentAlreadyAnswered = thread.some(m => m.author === 'agent' && m.time * 1000 >= sentAt)
  if (!agentAlreadyAnswered) {
    const { answer, resolve } = unwrapReplyCommand(text)
    await ctx.rest(`/sessions/${sessionName}/comments/${commentId}/reply`, { method: 'POST', body: { body: answer, author: 'agent', resolve } })
  }
  refresh()
}

async function deliverToLinkedSession(session, text, commentId) {
  const target = session.hermes_sessions?.[0]
  if (!target) {
    host.notify({ kind: 'warning', message: 'Saved, but no Hermes session has this directory as its cwd.' })
    return
  }
  try {
    const runtimeSessionId = await sendToHermesSession(target.id, text)
    const queue = pendingReplies.get(runtimeSessionId) ?? []
    queue.push({ sessionName: session.name, commentId, sentAt: Date.now() })
    pendingReplies.set(runtimeSessionId, queue)
  } catch (error) {
    host.notifyError(error, 'Saved, but delivering to the Hermes session failed')
  }
}

// --- unified diff parsing --------------------------------------------------------------

/** Turn a unified diff into rows; `newLine` is set for lines that exist in the new file. */
function parsePatch(patch) {
  const rows = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true
      rows.push({ kind: 'hunk', text })
    } else if (!inHunk) {
      continue
    } else if (text.startsWith('+')) {
      rows.push({ kind: 'add', text, newLine: newLine++ })
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'del', text, oldLine: oldLine++ })
    } else if (text.startsWith(' ')) {
      rows.push({ kind: 'ctx', text, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return rows
}

// --- comments --------------------------------------------------------------------------

function CommentThread({ comment, sessionName, session, headCommit }) {
  const [replyText, setReplyText] = useState('')
  const stale = comment.commit && headCommit && comment.commit !== headCommit

  const post = async (suffix, body) => {
    await ctx.rest(`/sessions/${sessionName}/comments/${comment.id}/${suffix}`, { method: 'POST', body })
    refresh()
  }
  const sendReply = async () => {
    await post('reply', { body: replyText })
    await deliverToLinkedSession(session, `Follow-up on review comment ${comment.id}:\n${replyText}\n\n(Your final reply is posted to the review thread automatically.)`, comment.id)
    setReplyText('')
  }

  return jsxs('div', {
    className: 'my-1 ml-10 rounded border p-2 text-xs',
    style: { ...SELECTABLE, borderColor: 'var(--ui-stroke-secondary)', opacity: comment.status === 'resolved' ? 0.6 : 1 },
    children: [
      jsxs('div', { className: 'mb-1 flex items-center gap-2', children: [
        jsx(Badge, { children: comment.status }),
        stale && jsx('span', { children: `on ${comment.commit.slice(0, 7)} (outdated)` }),
        jsx(Button, {
          size: 'sm', variant: 'ghost',
          onClick: () => post('status', { status: comment.status === 'open' ? 'resolved' : 'open' }),
          children: comment.status === 'open' ? 'Resolve' : 'Reopen'
        })
      ] }),
      ...comment.thread.map((message, index) => jsxs('div', { key: index, className: 'mb-1 whitespace-pre-wrap', children: [
        jsx('b', { children: `${message.author}: ` }), message.body
      ] })),
      jsxs('div', { className: 'mt-1 flex gap-2', children: [
        jsx(Textarea, { rows: 1, value: replyText, placeholder: 'Reply…', onChange: e => setReplyText(e.target.value) }),
        jsx(Button, { size: 'sm', disabled: !replyText.trim(), onClick: sendReply, children: 'Reply' })
      ] })
    ]
  })
}

function NewCommentBox({ sessionName, session, repo, path, line, headCommit, onDone }) {
  const [body, setBody] = useState('')
  const submit = async () => {
    const created = await ctx.rest(`/sessions/${sessionName}/comments`, {
      method: 'POST', body: { repo: repo.name, path, line, commit: headCommit, body }
    })
    refresh()
    onDone()
    await deliverToLinkedSession(session, created.agent_message, created.comment.id)
  }
  return jsxs('div', { className: 'my-1 ml-10 flex gap-2', children: [
    jsx(Textarea, { rows: 2, autoFocus: true, value: body, placeholder: 'Comment (sent to the Hermes session)…', onChange: e => setBody(e.target.value) }),
    jsxs('div', { className: 'flex flex-col gap-1', children: [
      jsx(Button, { size: 'sm', disabled: !body.trim(), onClick: submit, children: 'Comment' }),
      jsx(Button, { size: 'sm', variant: 'ghost', onClick: onDone, children: 'Cancel' })
    ] })
  ] })
}

// --- diff view -------------------------------------------------------------------------

function FileDiff({ session, repo, file }) {
  const [commentLine, setCommentLine] = useState(null)
  const { data } = useQuery({
    queryKey: [ID, 'patch', session.name, repo.name, file.path, repo.head],
    queryFn: () => ctx.rest(`/sessions/${session.name}/patch?repo=${encodeURIComponent(repo.name)}&path=${encodeURIComponent(file.path)}`)
  })
  const fileComments = session.comments.filter(c => c.repo === repo.name && c.path === file.path)
  const commentsAt = line => fileComments.filter(c => c.line === line)
  const rows = parsePatch(data?.patch ?? '')

  const threads = line => commentsAt(line).map(comment => jsx(CommentThread, {
    key: comment.id, comment, sessionName: session.name, session, headCommit: repo.head
  }))

  return jsxs('div', { className: 'font-mono text-xs', style: SELECTABLE, children: [
    ...fileComments.filter(c => !c.line).map(comment => jsx(CommentThread, {
      key: comment.id, comment, sessionName: session.name, session, headCommit: repo.head
    })),
    ...rows.flatMap((row, index) => {
      if (row.kind === 'hunk') {
        return [jsx('div', { key: index, className: 'px-2 py-0.5', style: { color: 'var(--ui-text-tertiary)' }, children: row.text })]
      }
      const clickable = row.newLine !== undefined
      const line = jsxs('div', {
        key: index,
        className: 'flex whitespace-pre-wrap hover:brightness-110',
        style: { ...SELECTABLE, background: row.kind === 'add' ? ADDED_TINT : row.kind === 'del' ? REMOVED_TINT : undefined },
        onClick: clickable ? () => { if (!userIsSelectingText()) setCommentLine(row.newLine) } : undefined,
        children: [
          jsx('span', { className: 'w-10 shrink-0 pr-2 text-right', style: { userSelect: 'none', color: 'var(--ui-text-quaternary)' }, children: row.newLine ?? '' }),
          jsx('span', { children: row.text })
        ]
      })
      const extras = clickable ? [
        ...threads(row.newLine),
        commentLine === row.newLine && jsx(NewCommentBox, {
          key: `new-${index}`, sessionName: session.name, session, repo, path: file.path,
          line: row.newLine, headCommit: repo.head, onDone: () => setCommentLine(null)
        })
      ] : []
      return [line, ...extras]
    })
  ] })
}

// --- session detail ----------------------------------------------------------------------

function MergePanel({ session, onMerged }) {
  const [plan, setPlan] = useState(null)
  const preview = async () => {
    try {
      setPlan((await ctx.rest(`/sessions/${session.name}/merge`, { method: 'POST', body: { dry_run: true } })).log)
    } catch (error) {
      host.notifyError(error, 'Cannot merge yet')
    }
  }
  const confirm = async () => {
    await ctx.rest(`/sessions/${session.name}/merge`, { method: 'POST', body: {} })
    for (const linked of session.hermes_sessions) {
      await host.request('session.archive', { session_id: linked.id, archived: true }).catch(() => {})
    }
    host.notify({ kind: 'success', message: `Merged and removed ${session.name}` })
    setPlan(null)
    onMerged()
  }
  if (!plan) return jsx(Button, { onClick: preview, children: 'Merge & delete…' })
  return jsxs('div', { className: 'flex items-center gap-2 text-xs', children: [
    jsx('span', { children: plan.join(' · ') }),
    jsx(Button, { onClick: confirm, children: 'Confirm merge & delete' }),
    jsx(Button, { variant: 'ghost', onClick: () => setPlan(null), children: 'Cancel' })
  ] })
}

function SessionDetail({ name, onGone }) {
  const [selected, setSelected] = useState(null) // { repo, path }
  const { data: session, error } = useQuery({
    queryKey: [ID, 'session', name], queryFn: () => ctx.rest(`/sessions/${name}`), refetchInterval: POLL_MS
  })
  if (error) return jsx('div', { className: 'p-4 text-sm', children: String(error.message ?? error) })
  if (!session) return jsx('div', { className: 'p-4 text-sm', children: 'Loading…' })

  const linked = session.hermes_sessions[0]
  const selectedRepo = session.repos.find(r => r.name === selected?.repo)
  const selectedFile = selectedRepo?.files.find(f => f.path === selected?.path)

  return jsxs('div', { className: 'flex h-full min-h-0 flex-col', children: [
    jsxs('div', { className: 'flex items-center gap-3 border-b p-3 text-sm', style: { borderColor: 'var(--ui-stroke-secondary)' }, children: [
      jsx('b', { children: linked?.title || session.name }),
      jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: `${session.repos.length} repos · ${session.comments.filter(c => c.status === 'open').length} open comments` }),
      linked && jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.openSession(linked.id), children: 'Open session' }),
      jsx('div', { className: 'ml-auto', children: jsx(MergePanel, { session, onMerged: () => { refresh(); onGone() } }) })
    ] }),
    jsxs('div', { className: 'flex min-h-0 flex-1', children: [
      jsx('div', { className: 'w-72 shrink-0 overflow-auto border-r p-2 text-xs', style: { borderColor: 'var(--ui-stroke-secondary)' }, children:
        session.repos.map(repo => jsxs('div', { key: repo.name, className: 'mb-3', children: [
          jsxs('div', { className: 'font-medium', children: [
            repo.name, ' ',
            jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: `${repo.branch} → ${repo.base_branch}  +${repo.additions} −${repo.deletions}${repo.uncommitted ? '  ● uncommitted' : ''}` })
          ] }),
          ...repo.files.map(file => jsx('div', {
            key: file.path,
            className: 'cursor-pointer truncate py-0.5 pl-3 hover:underline',
            style: { fontWeight: selected?.repo === repo.name && selected?.path === file.path ? 600 : 400 },
            onClick: () => setSelected({ repo: repo.name, path: file.path }),
            children: `${file.path}  +${file.additions} −${file.deletions}`
          }))
        ] }))
      }),
      jsx('div', { className: 'min-w-0 flex-1 overflow-auto p-2', children:
        selectedFile
          ? jsx(FileDiff, { session, repo: selectedRepo, file: selectedFile, key: `${selected.repo}/${selected.path}` })
          : jsx('div', { className: 'p-4 text-sm', style: { color: 'var(--ui-text-tertiary)' }, children: 'Pick a file. Click a line to comment; the comment is sent to the Hermes session.' })
      })
    ] })
  ] })
}

// --- creating a review session -----------------------------------------------------------

/** What the agent is told when a review session starts; later comments arrive as plain messages. */
function reviewSessionBrief(name, directory, repoNames, task) {
  return [
    `This is a review-style session named "${name}". Your working directory is ${directory}.`,
    `It contains one git worktree per repository (${repoNames.join(', ')}), each on branch hermes/${name}.`,
    'Work only inside these worktrees. Commit your changes at the end of every turn, in small commits with descriptive messages, so the reviewer sees stable diffs.',
    'The reviewer will send comments as messages. Answer them directly; your final reply is posted to the review thread.',
    '',
    `Task: ${task}`
  ].join('\n')
}

function NewSessionForm({ onCreated, onCancel }) {
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [chosen, setChosen] = useState([])
  const [busy, setBusy] = useState(false)
  const { data } = useQuery({ queryKey: [ID, 'repos'], queryFn: () => ctx.rest('/repos') })
  const repos = data?.repos ?? []
  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(name)
  const toggle = path => setChosen(chosen.includes(path) ? chosen.filter(p => p !== path) : [...chosen, path])

  const create = async () => {
    setBusy(true)
    try {
      const made = await ctx.rest('/sessions', { method: 'POST', body: { name, repos: chosen } })
      const live = await host.request('session.create', { cwd: made.path, cwd_explicit: true, title: name })
      const repoNames = chosen.map(path => path.split('/').pop())
      if (task.trim()) {
        await host.request('prompt.submit', { session_id: live.session_id, text: reviewSessionBrief(name, made.path, repoNames, task.trim()) })
      }
      refresh()
      onCreated(name)
    } catch (error) {
      host.notifyError(error, 'Could not create the review session')
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', { className: 'flex max-w-xl flex-col gap-3 p-4 text-sm', children: [
    jsx('b', { children: 'New review session' }),
    jsx(Input, { value: name, placeholder: 'name (lowercase, digits, dashes)', onChange: e => setName(e.target.value.trim()) }),
    jsx('div', { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' }, children: `Repositories (worktrees are created under ${data?.sessions_root ?? '…'}/${name || '<name>'})` }),
    jsx('div', { className: 'max-h-48 overflow-auto', children: repos.map(repo => jsxs('label', { key: repo.path, className: 'flex items-center gap-2 py-0.5', children: [
      jsx('input', { type: 'checkbox', checked: chosen.includes(repo.path), onChange: () => toggle(repo.path) }), repo.name
    ] })) }),
    jsx(Textarea, { rows: 4, value: task, placeholder: 'Task for the agent (optional; you can also just open the session and talk)', onChange: e => setTask(e.target.value) }),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Button, { disabled: busy || !nameValid || chosen.length === 0, onClick: create, children: busy ? 'Creating…' : 'Create' }),
      jsx(Button, { variant: 'ghost', onClick: onCancel, children: 'Cancel' })
    ] })
  ] })
}

// --- page --------------------------------------------------------------------------------

function ReviewPage() {
  const [selectedName, setSelectedName] = useState(null)
  const [creating, setCreating] = useState(false)
  const { data } = useQuery({
    queryKey: [ID, 'list'], queryFn: () => ctx.rest('/sessions'), refetchInterval: POLL_MS
  })
  const sessions = data?.sessions ?? []

  return jsxs('div', { className: 'flex h-full min-h-0', children: [
    jsxs('div', { className: 'w-64 shrink-0 overflow-auto border-r p-2 text-sm', style: { borderColor: 'var(--ui-stroke-secondary)' }, children: [
      jsx(Button, { size: 'sm', className: 'mb-2 w-full', onClick: () => { setCreating(true); setSelectedName(null) }, children: 'New review session' }),
      jsx('div', { className: 'mb-2 text-xs', style: { color: 'var(--ui-text-tertiary)' }, children: data?.root ?? '' }),
      ...sessions.map(session => jsxs('div', {
        key: session.name,
        className: 'cursor-pointer rounded p-2 hover:bg-(--chrome-action-hover)',
        style: { fontWeight: selectedName === session.name ? 600 : 400 },
        onClick: () => { setCreating(false); setSelectedName(session.name) },
        children: [
          jsx('div', { className: 'truncate', children: session.hermes_sessions[0]?.title || session.name }),
          jsx('div', { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' },
            children: `${session.repos} repos · +${session.additions} −${session.deletions}` + (session.open_comments ? ` · ${session.open_comments} open` : '') })
        ]
      })),
      sessions.length === 0 && jsx('div', { className: 'text-xs', children: 'No session directories yet.' })
    ] }),
    jsx('div', { className: 'min-w-0 flex-1', children: creating
      ? jsx(NewSessionForm, { onCreated: name => { setCreating(false); setSelectedName(name) }, onCancel: () => setCreating(false) })
      : selectedName
      ? jsx(SessionDetail, { name: selectedName, key: selectedName, onGone: () => setSelectedName(null) })
      : jsx('div', { className: 'p-4 text-sm', children: 'Select a session.' }) })
  ] })
}

let ctx // set in register(); components reach the plugin backend through it

export default {
  id: ID,
  name: 'Session Review',
  register(pluginContext) {
    ctx = pluginContext
    ctx.onEvent('message.complete', event => postFinalReplyToThread(event).catch(error => host.notifyError(error, 'Could not post the agent reply')))
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/session-review' }, render: () => jsx(ReviewPage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/session-review', label: 'Session Review', codicon: 'git-pull-request' } })
  }
}
