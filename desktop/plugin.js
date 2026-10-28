// Session Review: merge-request style review of Hermes sessions, shown as a pane docked next to the chat.
// A session is a directory under the sessions root; each child worktree is an affected repo.
// Data comes from this plugin's Python backend (ctx.rest); comments are delivered to the
// Hermes session through the gateway (host.request).
import {
  Badge, Button, Codicon, Input, Textarea, PANES_AREA, host, queryClient, useQuery, useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-review'
const POLL_MS = 5000

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
      rows.push({ kind: 'add', text, code: text.slice(1), newLine: newLine++ })
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'del', text, code: text.slice(1), oldLine: oldLine++ })
    } else if (text.startsWith(' ')) {
      rows.push({ kind: 'ctx', text, code: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
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

// --- syntax highlighting -----------------------------------------------------------------------
// The plugin may import nothing but the SDK, so highlighting is a small hand-rolled tokenizer:
// one ordered rule list per language, applied line by line (multi-line strings and block
// comments that start on an earlier line are therefore not recognised).

const C_STYLE_KEYWORDS = 'if else for while do switch case break continue return goto default struct union enum typedef static const volatile extern sizeof void int char float double long short unsigned signed bool true false null nullptr class public private protected virtual override template typename namespace using new delete try catch throw this auto fn let mut pub impl trait use mod match loop in as ref self Self move async await dyn where type func package import interface map chan go defer range var final abstract extends implements instanceof'
const LANGUAGE_KEYWORDS = {
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self cls',
  script: 'async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield as',
  cStyle: C_STYLE_KEYWORDS,
  shell: 'if then else elif fi for while do done case esac function in return exit local export readonly set unset echo cd source',
  literal: 'true false null'
}

const wordList = words => new RegExp(`^(?:${words.split(' ').join('|')})\\b`)
const STRING = /^(?:[rRbBfFuU]{0,2}"(?:[^"\\]|\\.)*"|[rRbBfFuU]{0,2}'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/
const NUMBER = /^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/
const IDENTIFIER_BEFORE_PAREN = /^[A-Za-z_]\w*(?=\()/
const CAPITALIZED = /^[A-Z][A-Za-z0-9_]*/

const languageRules = {
  python: [['comment', /^#.*/], ['string', STRING], ['keyword', wordList(LANGUAGE_KEYWORDS.python)], ['number', NUMBER], ['function', IDENTIFIER_BEFORE_PAREN], ['type', CAPITALIZED]],
  script: [['comment', /^(?:\/\/.*|\/\*.*?\*\/)/], ['string', STRING], ['keyword', wordList(LANGUAGE_KEYWORDS.script)], ['number', NUMBER], ['function', IDENTIFIER_BEFORE_PAREN], ['type', CAPITALIZED]],
  cStyle: [['comment', /^(?:\/\/.*|\/\*.*?\*\/|#\s*(?:include|define|if|ifdef|ifndef|endif|else|pragma).*)/], ['string', STRING], ['keyword', wordList(LANGUAGE_KEYWORDS.cStyle)], ['number', NUMBER], ['function', IDENTIFIER_BEFORE_PAREN], ['type', CAPITALIZED]],
  shell: [['comment', /^#.*/], ['string', STRING], ['keyword', wordList(LANGUAGE_KEYWORDS.shell)], ['property', /^\$\{?\w+\}?/], ['number', NUMBER]],
  json: [['property', /^"(?:[^"\\]|\\.)*"(?=\s*:)/], ['string', STRING], ['keyword', wordList(LANGUAGE_KEYWORDS.literal)], ['number', NUMBER]],
  config: [['comment', /^#.*/], ['property', /^[\w.-]+(?=\s*[:=])/], ['string', STRING], ['keyword', wordList(LANGUAGE_KEYWORDS.literal + ' yes no')], ['number', NUMBER]],
  markdown: [['keyword', /^#{1,6}\s.*/], ['string', /^`[^`]*`/], ['property', /^\*\*[^*]+\*\*/]],
  markup: [['comment', /^<!--.*?-->/], ['keyword', /^<\/?[\w:-]+/], ['property', /^[\w:-]+(?==)/], ['string', STRING]],
  stylesheet: [['comment', /^\/\*.*?\*\//], ['property', /^[\w-]+(?=\s*:)/], ['string', STRING], ['number', /^#?\d[\w.%]*/], ['type', /^[.#][\w-]+/]]
}

const EXTENSION_LANGUAGE = {
  py: 'python', js: 'script', mjs: 'script', cjs: 'script', jsx: 'script', ts: 'script', tsx: 'script',
  c: 'cStyle', h: 'cStyle', cc: 'cStyle', cpp: 'cStyle', hpp: 'cStyle', go: 'cStyle', rs: 'cStyle', java: 'cStyle', d: 'cStyle', odin: 'cStyle', cs: 'cStyle', kt: 'cStyle', swift: 'cStyle', glsl: 'cStyle', hlsl: 'cStyle',
  sh: 'shell', bash: 'shell', zsh: 'shell', json: 'json', yaml: 'config', yml: 'config', toml: 'config', ini: 'config', cfg: 'config', env: 'config',
  md: 'markdown', html: 'markup', xml: 'markup', svg: 'markup', css: 'stylesheet', scss: 'stylesheet'
}

export function languageForPath(path) {
  const extension = path.includes('.') ? path.split('.').pop().toLowerCase() : ''
  return EXTENSION_LANGUAGE[extension] ?? null
}

/** Tokenise one line into [{ text, kind }]; `kind` is null for plain text. */
export function highlightLine(line, language) {
  const rules = languageRules[language]
  if (!rules) return [{ text: line, kind: null }]
  const tokens = []
  let plainStart = 0
  let position = 0
  const flushPlain = end => { if (end > plainStart) tokens.push({ text: line.slice(plainStart, end), kind: null }) }
  while (position < line.length) {
    const rest = line.slice(position)
    let matched = null
    // A keyword must not start in the middle of a word (e.g. the "in" of "print").
    if (position === 0 || !/\w/.test(line[position - 1])) {
      for (const [kind, pattern] of rules) {
        const result = pattern.exec(rest)
        if (result && result[0].length > 0) { matched = { kind, text: result[0] }; break }
      }
    }
    if (matched) {
      flushPlain(position)
      tokens.push(matched)
      position += matched.text.length
      plainStart = position
    } else {
      position += 1
    }
  }
  flushPlain(line.length)
  return tokens
}

// Mixing with currentColor keeps each hue readable on both light and dark themes.
const TOKEN_HUE = { keyword: 320, string: 150, number: 60, type: 230, function: 255, property: 200 }
export function tokenStyle(kind) {
  if (!kind) return undefined
  if (kind === 'comment') return { color: 'var(--ui-text-quaternary)', fontStyle: 'italic' }
  return { color: `color-mix(in oklch, oklch(0.72 0.15 ${TOKEN_HUE[kind]}), currentColor 30%)` }
}

// --- intra-line (word-level) change marking ----------------------------------------------------

/**
 * Character range that differs between a removed and an added line: everything between their common
 * prefix and common suffix. Returns null when the lines share too little for marking to help.
 */
export function changedRanges(oldText, newText) {
  let prefix = 0
  const shortest = Math.min(oldText.length, newText.length)
  while (prefix < shortest && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  while (suffix < shortest - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++
  if (prefix + suffix < shortest * 0.25) return null
  return { old: [prefix, oldText.length - suffix], new: [prefix, newText.length - suffix] }
}

/** Cut tokens at the emphasis range so each segment is either wholly inside it or wholly outside. */
export function applyEmphasis(tokens, range) {
  if (!range || range[0] >= range[1]) return tokens.map(t => ({ ...t, emphasized: false }))
  const segments = []
  let offset = 0
  for (const token of tokens) {
    const end = offset + token.text.length
    const cuts = [offset, Math.max(offset, Math.min(end, range[0])), Math.max(offset, Math.min(end, range[1])), end]
    for (let i = 0; i < 3; i++) {
      const text = token.text.slice(cuts[i] - offset, cuts[i + 1] - offset)
      if (text) segments.push({ text, kind: token.kind, emphasized: i === 1 })
    }
    offset = end
  }
  return segments
}

/**
 * Attach intra-line ranges to each removed line that is directly followed by an added line:
 * the k-th removal pairs with the k-th addition of the same change block.
 */
export function markChangedWords(rows) {
  const marked = rows.map(row => ({ ...row }))
  for (let i = 0; i < marked.length; i++) {
    if (marked[i].kind !== 'del') continue
    const deletions = []
    while (marked[i]?.kind === 'del') deletions.push(marked[i++])
    const additions = []
    while (marked[i]?.kind === 'add') additions.push(marked[i++])
    i--
    deletions.slice(0, additions.length).forEach((deletion, k) => {
      const ranges = changedRanges(deletion.code, additions[k].code)
      if (ranges) { deletion.emphasis = ranges.old; additions[k].emphasis = ranges.new }
    })
  }
  return marked
}

/** Side-by-side layout: context rows on both sides, removals beside the additions that replace them. */
export function toSplitRows(rows) {
  const split = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind === 'hunk') { split.push({ hunk: row }); continue }
    if (row.kind === 'ctx') { split.push({ left: row, right: row }); continue }
    const deletions = []
    while (rows[i]?.kind === 'del') deletions.push(rows[i++])
    const additions = []
    while (rows[i]?.kind === 'add') additions.push(rows[i++])
    i--
    for (let k = 0; k < Math.max(deletions.length, additions.length); k++) {
      split.push({ left: deletions[k] ?? null, right: additions[k] ?? null })
    }
  }
  return split
}

// --- diff view ---------------------------------------------------------------------------------

const ADDED_LINE = 'color-mix(in srgb, #2ea043 13%, transparent)'
const ADDED_GUTTER = 'color-mix(in srgb, #2ea043 24%, transparent)'
const ADDED_WORD = 'color-mix(in srgb, #2ea043 38%, transparent)'
const REMOVED_LINE = 'color-mix(in srgb, #f85149 13%, transparent)'
const REMOVED_GUTTER = 'color-mix(in srgb, #f85149 24%, transparent)'
const REMOVED_WORD = 'color-mix(in srgb, #f85149 38%, transparent)'
const HUNK_BAR = 'color-mix(in srgb, var(--ui-accent) 12%, transparent)'
const DIFF_FONT = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.75rem', lineHeight: '1.4', tabSize: 4 }
const DIFF_MODE_KEY = 'session-review.diffMode'

function CodeText({ row, language }) {
  const wordColor = row.kind === 'add' ? ADDED_WORD : REMOVED_WORD
  return jsx('span', { children: applyEmphasis(highlightLine(row.code, language), row.emphasis).map((segment, index) =>
    jsx('span', { key: index, style: { ...tokenStyle(segment.kind), background: segment.emphasized ? wordColor : undefined, borderRadius: segment.emphasized ? 2 : undefined }, children: segment.text })) })
}

function Gutter({ number, tint, width = '3.25rem' }) {
  return jsx('span', { className: 'shrink-0 px-2 text-right', style: { width, userSelect: 'none', color: 'var(--ui-text-quaternary)', background: tint }, children: number ?? '' })
}

const lineTint = kind => kind === 'add' ? ADDED_LINE : kind === 'del' ? REMOVED_LINE : undefined
const gutterTint = kind => kind === 'add' ? ADDED_GUTTER : kind === 'del' ? REMOVED_GUTTER : undefined
const SIGN = { add: '+', del: '−', ctx: ' ' }

function UnifiedRow({ row, language, onSelect }) {
  return jsxs('div', {
    className: 'flex', style: { ...SELECTABLE, background: lineTint(row.kind), minWidth: 'max-content' },
    onClick: onSelect,
    children: [
      jsx(Gutter, { number: row.oldLine, tint: gutterTint(row.kind) }),
      jsx(Gutter, { number: row.newLine, tint: gutterTint(row.kind) }),
      jsx('span', { className: 'w-5 shrink-0 text-center', style: { userSelect: 'none', color: 'var(--ui-text-tertiary)' }, children: SIGN[row.kind] }),
      jsx('span', { className: 'whitespace-pre pr-4', children: jsx(CodeText, { row, language }) })
    ]
  })
}

function SplitCell({ row, language, onSelect }) {
  const kind = row?.kind
  return jsxs('div', {
    className: 'flex min-w-0 flex-1', style: { ...SELECTABLE, background: row ? lineTint(kind) : 'color-mix(in srgb, currentColor 4%, transparent)' },
    onClick: row?.newLine !== undefined ? onSelect : undefined,
    children: [
      jsx(Gutter, { number: kind === 'add' ? row.newLine : row?.oldLine, tint: gutterTint(kind), width: '2.75rem' }),
      jsx('span', { className: 'overflow-hidden whitespace-pre pl-1 pr-2', children: row ? jsx(CodeText, { row, language }) : '' })
    ]
  })
}

function HunkBar({ text }) {
  const [, label] = /^@@ [^@]* @@ ?(.*)$/.exec(text) ?? []
  return jsx('div', { className: 'flex px-3 py-0.5', style: { background: HUNK_BAR, color: 'var(--ui-text-tertiary)', minWidth: 'max-content', userSelect: 'none' }, children: label ? `${text.split('@@')[1].trim()}   ${label}` : text.split('@@')[1]?.trim() ?? text })
}

function FileHeader({ file, mode, onMode }) {
  const slash = file.path.lastIndexOf('/')
  return jsxs('div', { className: 'sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5 text-xs', style: { background: 'var(--ui-surface, var(--background))', borderColor: 'var(--ui-stroke-secondary)' }, children: [
    jsxs('span', { className: 'min-w-0 truncate', style: SELECTABLE, children: [
      slash >= 0 && jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: file.path.slice(0, slash + 1) }),
      jsx('b', { children: file.path.slice(slash + 1) })
    ] }),
    jsx(Badge, { children: file.status }),
    jsx('span', { style: { color: '#2ea043' }, children: `+${file.additions}` }),
    jsx('span', { style: { color: '#f85149' }, children: `−${file.deletions}` }),
    jsxs('span', { className: 'ml-auto flex gap-1', children: [
      jsx(Button, { size: 'sm', variant: mode === 'unified' ? undefined : 'ghost', onClick: () => onMode('unified'), children: 'Unified' }),
      jsx(Button, { size: 'sm', variant: mode === 'split' ? undefined : 'ghost', onClick: () => onMode('split'), children: 'Split' })
    ] })
  ] })
}

function FileDiff({ session, repo, file }) {
  const [commentLine, setCommentLine] = useState(null)
  const [storedMode, setStoredMode] = useState(() => window.localStorage.getItem(DIFF_MODE_KEY) ?? 'unified')
  const mode = storedMode
  const chooseMode = next => { window.localStorage.setItem(DIFF_MODE_KEY, next); setStoredMode(next) }

  const { data } = useQuery({
    queryKey: [ID, 'patch', session.name, repo.name, file.path, repo.head],
    queryFn: () => ctx.rest(`/sessions/${session.name}/patch?repo=${encodeURIComponent(repo.name)}&path=${encodeURIComponent(file.path)}`)
  })
  const language = languageForPath(file.path)
  const rows = markChangedWords(parsePatch(data?.patch ?? ''))
  const fileComments = session.comments.filter(c => c.repo === repo.name && c.path === file.path)

  const threadsAt = line => fileComments.filter(c => c.line === line).map(comment =>
    jsx(CommentThread, { key: comment.id, comment, sessionName: session.name, session, headCommit: repo.head }))
  const commentUiAfter = (line, key) => line === undefined ? [] : [
    ...threadsAt(line),
    commentLine === line && jsx(NewCommentBox, { key: `new-${key}`, sessionName: session.name, session, repo, path: file.path, line, headCommit: repo.head, onDone: () => setCommentLine(null) })
  ]
  const selectLine = line => () => { if (!userIsSelectingText()) setCommentLine(line) }

  const body = mode === 'split'
    ? toSplitRows(rows).flatMap((pair, index) => pair.hunk
      ? [jsx(HunkBar, { key: index, text: pair.hunk.text })]
      : [jsxs('div', { key: index, className: 'flex', children: [
          jsx(SplitCell, { row: pair.left, language, onSelect: selectLine(pair.left?.newLine) }),
          jsx('div', { style: { width: 1, background: 'var(--ui-stroke-secondary)' } }),
          jsx(SplitCell, { row: pair.right, language, onSelect: selectLine(pair.right?.newLine) })
        ] }), ...commentUiAfter(pair.right?.newLine, index)])
    : rows.flatMap((row, index) => row.kind === 'hunk'
      ? [jsx(HunkBar, { key: index, text: row.text })]
      : [jsx(UnifiedRow, { key: index, row, language, onSelect: row.newLine !== undefined ? selectLine(row.newLine) : undefined }), ...commentUiAfter(row.newLine, index)])

  return jsxs('div', { children: [
    jsx(FileHeader, { file, mode, onMode: chooseMode }),
    ...fileComments.filter(c => !c.line).map(comment => jsx(CommentThread, { key: comment.id, comment, sessionName: session.name, session, headCommit: repo.head })),
    rows.length === 0
      ? jsx('div', { className: 'p-4 text-xs', style: { color: 'var(--ui-text-tertiary)' }, children: data ? 'No textual changes (binary file, mode change, or empty).' : 'Loading…' })
      : jsx('div', { className: 'overflow-x-auto', style: DIFF_FONT, children: jsx('div', { style: { minWidth: '100%', width: 'max-content' }, children: body }) })
  ] })
}

// --- merge indicators --------------------------------------------------------------------------

const MERGED_GREEN = '#2ea043'
const UNMERGED_AMBER = '#d29922'

/** Label and colour for a repo's (or a whole session's) relation to its base branch. */
export function mergeBadge(state, unmergedCommits = 0, totalCommits = 0) {
  if (state === 'merged') return { label: 'Merged', color: MERGED_GREEN, icon: 'git-merge' }
  if (state === 'partial') return { label: `${unmergedCommits} of ${totalCommits} unmerged`, color: UNMERGED_AMBER, icon: 'git-pull-request' }
  if (state === 'unmerged') return { label: totalCommits ? `${unmergedCommits} unmerged` : 'Unmerged', color: UNMERGED_AMBER, icon: 'git-pull-request' }
  return { label: 'No commits', color: 'var(--ui-text-quaternary)', icon: 'circle-outline' }
}

function MergeBadge({ state, unmergedCommits, totalCommits }) {
  if (state === undefined) return null // an outdated backend does not send merge state; the banner explains it
  const badge = mergeBadge(state, unmergedCommits, totalCommits)
  return jsxs('span', { className: 'inline-flex items-center gap-1 whitespace-nowrap', style: { color: badge.color }, children: [jsx(Codicon, { name: badge.icon }), badge.label] })
}

function CommitList({ commits }) {
  return jsx('div', { className: 'mb-1 pl-5', children: commits.map(commit => jsxs('div', {
    key: commit.sha, className: 'flex items-center gap-1.5 py-0.5', title: commit.merged ? 'In the base branch' : 'Not in the base branch yet', style: SELECTABLE,
    children: [
      commit.merged !== undefined && jsx(Codicon, { name: commit.merged ? 'pass-filled' : 'circle-large-outline', style: { color: commit.merged ? MERGED_GREEN : UNMERGED_AMBER } }),
      jsx('span', { className: 'font-mono', style: { color: 'var(--ui-text-tertiary)' }, children: commit.sha.slice(0, 7) }),
      jsx('span', { className: 'min-w-0 truncate', children: commit.subject })
    ]
  })) })
}

// --- file tree ---------------------------------------------------------------------------------

/**
 * Nest changed files into folders. Chains of folders with a single folder child are merged into one
 * row ("src/app/ui"), folders sort before files, and folders carry their files' summed stats.
 */
export function buildFileTree(files) {
  const root = { kind: 'dir', name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let directory = root
    parts.slice(0, -1).forEach((part, depth) => {
      const path = parts.slice(0, depth + 1).join('/')
      let child = directory.children.find(c => c.kind === 'dir' && c.path === path)
      if (!child) { child = { kind: 'dir', name: part, path, children: [] }; directory.children.push(child) }
      directory = child
    })
    directory.children.push({ kind: 'file', name: parts[parts.length - 1], path: file.path, file })
  }
  return finishTree(root.children)
}

function finishTree(nodes) {
  const finished = nodes.map(node => {
    if (node.kind === 'file') return node
    let directory = { ...node, children: finishTree(node.children) }
    while (directory.children.length === 1 && directory.children[0].kind === 'dir') {
      const only = directory.children[0]
      directory = { ...only, name: `${directory.name}/${only.name}` }
    }
    return { ...directory, ...sumStats(directory.children) }
  })
  return finished.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

function sumStats(children) {
  return children.reduce((total, child) => {
    const stats = child.kind === 'file' ? { files: 1, additions: child.file.additions, deletions: child.file.deletions } : child
    return { files: total.files + stats.files, additions: total.additions + stats.additions, deletions: total.deletions + stats.deletions }
  }, { files: 0, additions: 0, deletions: 0 })
}

export function filterFiles(files, query) {
  const needle = query.trim().toLowerCase()
  return needle ? files.filter(file => file.path.toLowerCase().includes(needle)) : files
}

const STATUS_MARK = {
  added: { letter: 'A', color: '#2ea043' },
  untracked: { letter: 'U', color: '#2ea043' },
  modified: { letter: 'M', color: '#d29922' },
  deleted: { letter: 'D', color: '#f85149' }
}
const ROW_INDENT_REM = 0.875

function TreeRow({ depth, selected, onClick, children }) {
  return jsx('div', {
    className: 'flex cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-(--chrome-action-hover)',
    style: { paddingLeft: `${0.25 + depth * ROW_INDENT_REM}rem`, background: selected ? 'color-mix(in srgb, var(--ui-accent) 16%, transparent)' : undefined },
    onClick, children
  })
}

function TreeNodes({ nodes, depth, repoName, selected, onSelect, collapsed, toggle, openCommentsByPath, forceOpen }) {
  return nodes.flatMap(node => {
    if (node.kind === 'dir') {
      const isOpen = forceOpen || !collapsed.has(`${repoName}:${node.path}`)
      return [
        jsxs(TreeRow, { key: `d:${node.path}`, depth, onClick: () => toggle(`${repoName}:${node.path}`), children: [
          jsx(Codicon, { name: isOpen ? 'chevron-down' : 'chevron-right', style: { color: 'var(--ui-text-tertiary)' } }),
          jsx(Codicon, { name: isOpen ? 'folder-opened' : 'folder', style: { color: 'var(--ui-accent)' } }),
          jsx('span', { className: 'min-w-0 flex-1 truncate', children: node.name }),
          jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: node.files })
        ] }),
        ...(isOpen ? [jsx(TreeNodes, { key: `c:${node.path}`, nodes: node.children, depth: depth + 1, repoName, selected, onSelect, collapsed, toggle, openCommentsByPath, forceOpen })] : [])
      ]
    }
    const { file } = node
    const mark = STATUS_MARK[file.status] ?? STATUS_MARK.modified
    const isSelected = selected?.repo === repoName && selected?.path === file.path
    const comments = openCommentsByPath[file.path] ?? 0
    return [jsxs(TreeRow, { key: `f:${file.path}`, depth, selected: isSelected, onClick: () => onSelect({ repo: repoName, path: file.path }), children: [
      jsx('span', { className: 'w-3.5 shrink-0' }),
      jsx(Codicon, { name: 'file', style: { color: 'var(--ui-text-tertiary)' } }),
      jsx('span', { className: 'min-w-0 flex-1 truncate', title: file.path, style: { fontWeight: isSelected ? 600 : 400, textDecoration: file.status === 'deleted' ? 'line-through' : undefined }, children: node.name }),
      comments > 0 && jsxs('span', { className: 'flex items-center gap-0.5', style: { color: 'var(--ui-accent)' }, children: [jsx(Codicon, { name: 'comment' }), comments] }),
      jsx('span', { style: { color: '#2ea043' }, children: `+${file.additions}` }),
      jsx('span', { style: { color: '#f85149' }, children: `−${file.deletions}` }),
      jsx('span', { className: 'w-3 shrink-0 text-center font-medium', style: { color: mark.color }, title: file.status, children: mark.letter })
    ] })]
  })
}

function RepoTree({ repo, comments, selected, onSelect, query }) {
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [repoOpen, setRepoOpen] = useState(true)
  const toggle = key => setCollapsed(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next })
  const openCommentsByPath = {}
  for (const comment of comments) {
    if (comment.repo === repo.name && comment.path && comment.status === 'open') openCommentsByPath[comment.path] = (openCommentsByPath[comment.path] ?? 0) + 1
  }
  const visibleFiles = filterFiles(repo.files, query)
  const filtering = query.trim() !== ''
  if (filtering && visibleFiles.length === 0) return null

  return jsxs('div', { className: 'mb-3', children: [
    jsxs('div', { className: 'flex cursor-pointer items-center gap-1.5 py-1 font-medium', onClick: () => setRepoOpen(!repoOpen), children: [
      jsx(Codicon, { name: repoOpen ? 'chevron-down' : 'chevron-right', style: { color: 'var(--ui-text-tertiary)' } }),
      jsx(Codicon, { name: 'repo' }),
      jsx('span', { className: 'min-w-0 truncate', children: repo.name }),
      repo.uncommitted && jsx('span', { title: 'uncommitted changes', style: { color: UNMERGED_AMBER }, children: '●' }),
      jsx('span', { className: 'ml-auto', children: jsx(MergeBadge, { state: repo.merge_state, unmergedCommits: repo.unmerged_commits, totalCommits: repo.commits.length }) })
    ] }),
    jsxs('div', { className: 'mb-1 pl-5', style: { color: 'var(--ui-text-tertiary)' }, children:
      `${repo.branch} → ${repo.base_branch} · ${repo.files.length} files · +${repo.additions} −${repo.deletions}` }),
    repoOpen && repo.commits.length > 0 && jsx(CommitList, { commits: repo.commits }),
    repoOpen && jsx(TreeNodes, { nodes: buildFileTree(visibleFiles), depth: 0, repoName: repo.name, selected, onSelect, collapsed, toggle, openCommentsByPath, forceOpen: filtering })
  ] })
}

function FileTree({ session, selected, onSelect }) {
  const [query, setQuery] = useState('')
  return jsxs('div', { children: [
    jsx(Input, { value: query, placeholder: 'Filter files…', onChange: e => setQuery(e.target.value), className: 'mb-2' }),
    ...session.repos.map(repo => jsx(RepoTree, { key: repo.name, repo, comments: session.comments, selected, onSelect, query })),
    session.repos.length === 0 && jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'No repositories in this session yet.' })
  ] })
}

// --- session detail ----------------------------------------------------------------------

function DeletePanel({ session, onDeleted }) {
  const [plan, setPlan] = useState(null)
  const preview = async () => {
    try {
      setPlan((await ctx.rest(`/sessions/${session.name}/delete`, { method: 'POST', body: { dry_run: true } })).log)
    } catch (error) {
      host.notifyError(error, 'Cannot delete this session')
    }
  }
  const confirm = async () => {
    await ctx.rest(`/sessions/${session.name}/delete`, { method: 'POST', body: {} })
    for (const linked of session.hermes_sessions) {
      await host.request('session.archive', { session_id: linked.id, archived: true }).catch(() => {})
    }
    host.notify({ kind: 'success', message: `Deleted ${session.name}` })
    setPlan(null)
    onDeleted()
  }
  if (!plan) return jsx(Button, { variant: 'ghost', onClick: preview, children: 'Delete session…' })
  return jsxs('div', { className: 'flex flex-col gap-1 text-xs', children: [
    ...plan.map((line, index) => jsx('div', { key: index, children: line })),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Button, { onClick: confirm, children: 'Confirm delete' }),
      jsx(Button, { variant: 'ghost', onClick: () => setPlan(null), children: 'Cancel' })
    ] })
  ] })
}

/** One session's review: files stacked above the diff, sized for the docked pane. The chat itself sits beside it. */
function SessionDetail({ name, onGone }) {
  const [selected, setSelected] = useState(null) // { repo, path }
  const focusedStoredId = useValue(host.state.focusedStoredSessionId) // hooks stay above the early returns below
  const { data: session, error } = useQuery({
    queryKey: [ID, 'session', name], queryFn: () => ctx.rest(`/sessions/${name}`), refetchInterval: POLL_MS
  })
  if (error) return jsx('div', { className: 'p-4 text-sm', children: String(error.message ?? error) })
  if (!session) return jsx('div', { className: 'p-4 text-sm', children: 'Loading…' })

  const linked = session.hermes_sessions[0]
  const backendOutdated = session.merge_state === undefined
  // The focused chat is already on screen beside the pane.
  const alreadyOpenBesideMe = focusedStoredId === linked?.id
  const selectedRepo = session.repos.find(r => r.name === selected?.repo)
  const selectedFile = selectedRepo?.files.find(f => f.path === selected?.path)

  return jsxs('div', { className: 'flex h-full min-h-0 flex-col', children: [
    backendOutdated && jsx('div', { className: 'border-b px-3 py-1.5 text-xs', style: { background: 'color-mix(in srgb, #d29922 18%, transparent)', borderColor: 'var(--ui-stroke-secondary)' },
      children: 'The Session Review backend is out of date, so merge status and delete are unavailable. Restart the gateway to load the new version.' }),
    jsxs('div', { className: 'flex flex-wrap items-center gap-3 border-b p-3 text-sm', style: { borderColor: 'var(--ui-stroke-secondary)' }, children: [
      jsx('b', { children: linked?.title || session.name }),
      jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: `${session.repos.length} repos · ${session.comments.filter(c => c.status === 'open').length} open comments` }),
      jsx(MergeBadge, { state: session.merge_state, unmergedCommits: session.unmerged_repos, totalCommits: 0 }),
      linked && !alreadyOpenBesideMe && jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.openSession(linked.id, { intent: 'tab' }), children: 'Open session' }),
      jsx('div', { className: 'ml-auto', children: jsx(DeletePanel, { session, onDeleted: () => { refresh(); onGone() } }) })
    ] }),
    jsxs('div', { className: 'flex min-h-0 flex-1 flex-col', children: [
      jsx('div', { className: 'max-h-60 shrink-0 overflow-auto border-b p-2 text-xs', style: { borderColor: 'var(--ui-stroke-secondary)' }, children:
        jsx(FileTree, { session, selected, onSelect: setSelected })
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
function reviewSessionBrief({ name, directory, repoNames, task, cliPath }) {
  const repoLine = repoNames.length
    ? `It contains one git worktree per repository (${repoNames.join(', ')}), each on branch hermes/${name}.`
    : `It contains no repositories yet. Before you change any repository, add it to this session with: ${cliPath} add-repo ${name} <path-to-repo> ` +
      '(creates a worktree on branch hermes/' + name + ' here). Never edit a repository outside this directory.'
  return [
    `This is a review-style session named "${name}". Your working directory is ${directory}.`,
    repoLine,
    'Work only inside the worktrees in this directory. Commit your changes at the end of every turn, in small commits with descriptive messages, so the reviewer sees stable diffs.',
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
        await host.request('prompt.submit', { session_id: live.session_id, text: reviewSessionBrief({ name, directory: made.path, repoNames, task: task.trim(), cliPath: data.cli_path }) })
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
    jsx('div', { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' }, children: `Repositories (optional). Leave empty and the agent adds each repo as a worktree when it needs it.` }),
    jsx('div', { className: 'max-h-48 overflow-auto', children: repos.map(repo => jsxs('label', { key: repo.path, className: 'flex items-center gap-2 py-0.5', children: [
      jsx('input', { type: 'checkbox', checked: chosen.includes(repo.path), onChange: () => toggle(repo.path) }), repo.name
    ] })) }),
    jsx(Textarea, { rows: 4, value: task, placeholder: 'Task for the agent (optional; you can also just open the session and talk)', onChange: e => setTask(e.target.value) }),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Button, { disabled: busy || !nameValid, onClick: create, children: busy ? 'Creating…' : 'Create' }),
      jsx(Button, { variant: 'ghost', onClick: onCancel, children: 'Cancel' })
    ] })
  ] })
}

// --- session list, shared by the page and the docked pane ---------------------------------------

function SessionRows({ sessions, selectedName, onSelect }) {
  return jsx('div', { children: [
    ...sessions.map(session => jsxs('div', {
      key: session.name,
      className: 'cursor-pointer rounded p-2 hover:bg-(--chrome-action-hover)',
      style: { fontWeight: selectedName === session.name ? 600 : 400 },
      onClick: () => onSelect(session.name),
      children: [
        jsx('div', { className: 'truncate', children: session.hermes_sessions[0]?.title || session.name }),
        jsx('div', { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' },
          children: [`${session.repos} repos · +${session.additions} −${session.deletions}` + (session.open_comments ? ` · ${session.open_comments} open` : ''), ' · ', jsx(MergeBadge, { state: session.merge_state, unmergedCommits: session.unmerged_repos, totalCommits: 0 })] })
      ]
    })),
    sessions.length === 0 && jsx('div', { className: 'p-2 text-xs', children: 'No session directories yet.' })
  ] })
}

function useSessionList() {
  const { data } = useQuery({ queryKey: [ID, 'list'], queryFn: () => ctx.rest('/sessions'), refetchInterval: POLL_MS })
  return { root: data?.root, sessions: data?.sessions ?? [] }
}

// --- docked pane next to the chat ----------------------------------------------------------

/**
 * The review pane. It follows the focused chat: when that chat belongs to a review session
 * (matched through the session's cwd) the pane shows it; the list lets you look at any other session.
 */
function ReviewPane() {
  const focusedStoredId = useValue(host.state.focusedStoredSessionId)
  const { root, sessions } = useSessionList()
  const [chosenName, setChosenName] = useState(null)
  const [creating, setCreating] = useState(false)
  const [listOpen, setListOpen] = useState(true)
  const focusedSession = sessions.find(s => s.hermes_sessions.some(h => h.id === focusedStoredId))

  // Moving to a different review chat takes the pane with you.
  useEffect(() => {
    if (!focusedSession) return
    setChosenName(null); setCreating(false); setListOpen(false)
  }, [focusedSession?.name])

  const selectedName = chosenName ?? focusedSession?.name ?? null
  const choose = name => { setChosenName(name); setCreating(false); setListOpen(false) }

  return jsxs('div', { className: 'flex h-full min-h-0 flex-col text-sm', children: [
    jsxs('div', { className: 'flex items-center gap-2 border-b px-3 py-1.5', style: { borderColor: 'var(--ui-stroke-secondary)' }, children: [
      jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => setListOpen(!listOpen),
        children: jsxs('span', { className: 'flex items-center gap-1', children: [jsx(Codicon, { name: listOpen ? 'chevron-down' : 'chevron-right' }), `Sessions (${sessions.length})`] }) }),
      jsx(Button, { size: 'sm', className: 'ml-auto', onClick: () => { setCreating(true); setListOpen(false) }, children: 'New' })
    ] }),
    listOpen && jsx('div', { className: 'max-h-56 shrink-0 overflow-auto border-b p-1', style: { borderColor: 'var(--ui-stroke-secondary)' },
      children: jsx(SessionRows, { sessions, selectedName, onSelect: choose }) }),
    jsx('div', { className: 'min-h-0 flex-1 overflow-auto', children: creating
      ? jsx(NewSessionForm, { onCreated: choose, onCancel: () => setCreating(false) })
      : selectedName
        ? jsx(SessionDetail, { name: selectedName, key: selectedName, onGone: () => setChosenName(null) })
        : jsx('div', { className: 'p-4 text-xs', style: { color: 'var(--ui-text-tertiary)' },
            children: `The focused chat is not a review session (its cwd is not under ${root ?? 'the sessions root'}). Pick a session above or create one.` }) })
  ] })
}

let ctx // set in register(); components reach the plugin backend through it

export default {
  id: ID,
  name: 'Session Review',
  register(pluginContext) {
    ctx = pluginContext
    ctx.onEvent('message.complete', () => refresh())
    ctx.onEvent('message.complete', event => postFinalReplyToThread(event).catch(error => host.notifyError(error, 'Could not post the agent reply')))
    ctx.register({
      id: 'pane', area: PANES_AREA, title: 'Review',
      data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, width: '520px' },
      render: () => jsx(ReviewPane, {})
    })
  }
}
