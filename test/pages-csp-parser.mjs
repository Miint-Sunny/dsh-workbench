/** HTML5 parser regression; DSH_HTML_PARSER may name an already installed parse5 module. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPageHardening } from '../lib/pages-csp.js'
const { parse } = await import(process.env.DSH_HTML_PARSER ?? 'parse5')

for (const start of ['<!-->', '<!--->', '<!-- --!>']) {
  test(`W-001: HTML5 ${start} cannot place active script before the policy`, () => {
    const html = `${start}<script id="untrusted">fetch('/probe')</script>--><body>fixture</body>`
    const document = parse(applyPageHardening(html))
    const active = []
    const visit = node => {
      if (node.tagName === 'meta' && node.attrs.some(a => a.name === 'http-equiv' && a.value === 'Content-Security-Policy')) active.push('policy')
      if (node.tagName === 'script' && node.attrs.some(a => a.name === 'id' && a.value === 'untrusted')) active.push('untrusted')
      for (const child of node.childNodes ?? []) visit(child)
    }
    visit(document)
    assert.deepEqual(active, ['policy', 'untrusted'])
    const head = document.childNodes.find(n => n.tagName === 'html').childNodes.find(n => n.tagName === 'head')
    assert(head.childNodes.some(n => n.tagName === 'meta' && n.attrs.some(a => a.name === 'http-equiv')))
  })
}


import { cspPrologCases } from './pages-csp-cases.mjs'
for (const [name, prefix, rest, mode] of cspPrologCases) {
  test(`W-001 rework: parser confirms head policy and document mode for ${name}`, () => {
    // The HTML byte decoder consumes one leading BOM before tokenization.
    const document = parse(applyPageHardening(`${prefix}${rest}<script id="untrusted">0</script>`).replace(/^\uFEFF/, ''))
    const seen = []
    function visit(node) {
      if (node.tagName === 'meta' && node.attrs.some(a => a.name === 'http-equiv' && a.value === 'Content-Security-Policy')) {
        assert.equal(node.parentNode.tagName, 'head')
        seen.push('policy')
      }
      if (node.tagName === 'script' && node.attrs.some(a => a.name === 'id' && a.value === 'untrusted')) seen.push('script')
      for (const child of node.childNodes ?? []) visit(child)
    }
    visit(document)
    assert.equal(seen[0], 'policy')
    assert.equal(seen.filter(x => x === 'policy').length, 1)
    assert.equal(document.mode, mode)
  })
}
