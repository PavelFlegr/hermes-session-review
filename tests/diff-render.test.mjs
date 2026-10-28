// Tests the pure diff-rendering functions of desktop/plugin.js by loading the file with the
// SDK imports stubbed out (the plugin itself can only import the SDK in the real app).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
const stubs = 'const host={},queryClient={},useQuery=()=>{},useValue=()=>{},useState=()=>{},useEffect=()=>{},useRef=()=>{},jsx=()=>{},jsxs=()=>{},Badge=0,Button=0,Input=0,Textarea=0,PANES_AREA=0,ROUTES_AREA=0,SIDEBAR_NAV_AREA=0;'
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
