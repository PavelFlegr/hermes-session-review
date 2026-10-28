// Tests the pure diff-rendering and file-tree functions of desktop/plugin.js by loading the file with the
// SDK imports stubbed out (the plugin itself can only import the SDK in the real app).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
const stubs = 'const host={},queryClient={},useQuery=()=>{},useValue=()=>{},useState=()=>{},useEffect=()=>{},useRef=()=>{},jsx=()=>{},jsxs=()=>{},Badge=0,Button=0,Codicon=0,Input=0,Textarea=0,PANES_AREA=0,ROUTES_AREA=0,SIDEBAR_NAV_AREA=0;'
const url = 'data:text/javascript;base64,' + Buffer.from(stubs + source).toString('base64')
const plugin = await import(url)

test('language is chosen by extension', () => {
  assert.equal(plugin.languageForPath('src/app.py'), 'python')
  assert.equal(plugin.languageForPath('a/b/main.go'), 'cStyle')
  assert.equal(plugin.languageForPath('Makefile'), null)
})

test('python line is tokenised into keyword, function, string, comment', () => {
  const kinds = plugin.highlightLine('def greet(x): return "hi"  # note', 'python').filter(t => t.kind).map(t => [t.kind, t.text])
  assert.deepEqual(kinds, [['keyword', 'def'], ['function', 'greet'], ['keyword', 'return'], ['string', '"hi"'], ['comment', '# note']])
})

test('keywords inside words are not highlighted', () => {
  assert.deepEqual(plugin.highlightLine('print(x)', 'python').map(t => t.kind), ['function', null])
})

test('tokens reassemble to the original line', () => {
  const line = 'const s = `a${b}` + 0x1F // end'
  assert.equal(plugin.highlightLine(line, 'script').map(t => t.text).join(''), line)
})

test('changed range is the middle between common prefix and suffix', () => {
  assert.deepEqual(plugin.changedRanges('return "hello " + name', 'return "hello " + name + punctuation'), { old: [22, 22], new: [22, 36] })
  assert.equal(plugin.changedRanges('abcdef', 'xyz'), null)
})

test('emphasis splits tokens at the range edges', () => {
  const tokens = plugin.highlightLine('let value = 1', 'script')
  const emphasized = plugin.applyEmphasis(tokens, [4, 9]).filter(s => s.emphasized).map(s => s.text).join('')
  assert.equal(emphasized, 'value')
})

test('split rows pair removals with additions and keep context on both sides', () => {
  const rows = [
    { kind: 'hunk', text: '@@' }, { kind: 'ctx', code: 'a', oldLine: 1, newLine: 1 },
    { kind: 'del', code: 'b', oldLine: 2 }, { kind: 'del', code: 'c', oldLine: 3 }, { kind: 'add', code: 'B', newLine: 2 },
    { kind: 'add', code: 'new', newLine: 3 }
  ]
  const split = plugin.toSplitRows(rows)
  assert.equal(split.length, 4)
  assert.deepEqual([split[2].left.code, split[2].right.code], ['b', 'B'])
  assert.deepEqual([split[3].left.code, split[3].right.code], ['c', 'new'])
})

const file = (path, additions = 1, deletions = 0, status = 'modified') => ({ path, additions, deletions, status })

test('file tree nests folders, sorts folders first and sums folder stats', () => {
  const tree = plugin.buildFileTree([file('README.md'), file('src/b.py', 3, 1), file('src/a.py', 2, 0), file('docs/x.md')])
  assert.deepEqual(tree.map(n => n.name), ['docs', 'src', 'README.md'])
  const src = tree.find(n => n.name === 'src')
  assert.deepEqual([src.files, src.additions, src.deletions], [2, 5, 1])
  assert.deepEqual(src.children.map(n => n.name), ['a.py', 'b.py'])
})

test('single-child folder chains are merged into one row', () => {
  const tree = plugin.buildFileTree([file('a/b/c/one.py'), file('a/b/c/two.py')])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].name, 'a/b/c')
  assert.equal(tree[0].path, 'a/b/c')
  assert.equal(tree[0].children.length, 2)
})

test('a folder with a file and a subfolder is not merged', () => {
  const tree = plugin.buildFileTree([file('a/top.py'), file('a/b/deep.py')])
  assert.equal(tree[0].name, 'a')
  assert.deepEqual(tree[0].children.map(n => n.name), ['b', 'top.py'])
})

test('filter matches paths case-insensitively', () => {
  const files = [file('src/App.py'), file('docs/guide.md')]
  assert.deepEqual(plugin.filterFiles(files, 'app').map(f => f.path), ['src/App.py'])
  assert.equal(plugin.filterFiles(files, '  ').length, 2)
})

test('merge badge wording', () => {
  assert.equal(plugin.mergeBadge('merged').label, 'Merged')
  assert.equal(plugin.mergeBadge('partial', 1, 3).label, '1 of 3 unmerged')
  assert.equal(plugin.mergeBadge('unmerged', 2, 2).label, '2 unmerged')
  assert.equal(plugin.mergeBadge('unmerged', 0, 0).label, 'Unmerged')
  assert.equal(plugin.mergeBadge('none').label, 'No commits')
})
