import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from '@babel/parser'
import { addMount, ConfigEditError } from '../dist/config-edit.js'

/** Every edit has to leave a file that still parses. */
const reparse = (source) => {
  assert.doesNotThrow(
    () => parse(source, { sourceType: 'module', plugins: ['typescript'] }),
    `edit produced unparseable output:\n${source}`
  )
  return source
}

const SCAFFOLD = `import { withMonolith } from '@fairgarden/monolith'

export default withMonolith(
  {
    // the monolith's own Next config
  },
  {
    // mount name -> module, added by \`fg-monolith add-module\`
  }
)
`

test('adds the first mount to an empty map, keeping the comment', () => {
  const { source, changed } = addMount(SCAFFOLD, 'widget', '@acme/widget')
  assert.equal(changed, true)
  reparse(source)
  assert.match(source, /widget: '@acme\/widget',/)
  assert.match(source, /mount name -> module/)
  // everything else is untouched
  assert.match(source, /the monolith's own Next config/)
})

test('adds a second mount after the first', () => {
  const once = addMount(SCAFFOLD, 'widget', '@acme/widget').source
  const { source } = addMount(once, 'billing', '@acme/billing')
  reparse(source)
  const widget = source.indexOf("widget: '@acme/widget'")
  const billing = source.indexOf("billing: '@acme/billing'")
  assert.ok(widget > 0 && billing > widget, source)
})

test('does not add a mount that is already there', () => {
  const once = addMount(SCAFFOLD, 'widget', '@acme/widget').source
  const again = addMount(once, 'widget', '@acme/widget')
  assert.equal(again.changed, false)
  assert.equal(again.source, once)
})

test('recognises an existing mount written as a string key', () => {
  const source = `import { withMonolith } from '@fairgarden/monolith'
export default withMonolith({}, { 'my-widget': '@acme/widget' })
`
  assert.equal(addMount(source, 'my-widget', '@acme/widget').changed, false)
})

test('quotes a mount name that is not an identifier', () => {
  const { source } = addMount(SCAFFOLD, 'my-widget', '@acme/widget')
  reparse(source)
  assert.match(source, /'my-widget': '@acme\/widget',/)
})

test('keeps a trailing comma from doubling', () => {
  const source = `import { withMonolith } from '@fairgarden/monolith'
export default withMonolith(
  {},
  {
    id: '@acme/id',
  }
)
`
  const { source: after } = addMount(source, 'widget', '@acme/widget')
  reparse(after)
  assert.doesNotMatch(after, /,\s*,/)
  assert.match(after, /id: '@acme\/id',\n    widget: '@acme\/widget',/)
})

test('handles a map with no trailing comma', () => {
  const source = `import { withMonolith } from '@fairgarden/monolith'
export default withMonolith({}, { id: '@acme/id' })
`
  const { source: after } = addMount(source, 'widget', '@acme/widget')
  reparse(after)
  assert.doesNotMatch(after, /,\s*,/)
  assert.match(after, /id: '@acme\/id',/)
  assert.match(after, /widget: '@acme\/widget',/)
})

test('adds a mount map when the call has only a config', () => {
  const source = `import { withMonolith } from '@fairgarden/monolith'

export default withMonolith({
  reactStrictMode: true,
})
`
  const { source: after, changed } = addMount(source, 'widget', '@acme/widget')
  assert.equal(changed, true)
  reparse(after)
  assert.match(after, /reactStrictMode: true,/)
  assert.match(after, /widget: '@acme\/widget',/)
})

test('follows a renamed import', () => {
  const source = `import { withMonolith as compose } from '@fairgarden/monolith'
export default compose({}, { id: '@acme/id' })
`
  assert.match(reparse(addMount(source, 'w', '@acme/w').source), /w: '@acme\/w',/)
})

test('works when the config is assigned before being exported', () => {
  const source = `import { withMonolith } from '@fairgarden/monolith'
const config = withMonolith({}, {})
export default config
`
  assert.match(reparse(addMount(source, 'w', '@acme/w').source), /w: '@acme\/w',/)
})

test('refuses a config that does not import withMonolith', () => {
  assert.throws(
    () => addMount(`export default {}\n`, 'w', '@acme/w'),
    ConfigEditError
  )
})

test('refuses a config that imports but never calls it', () => {
  assert.throws(
    () => addMount(`import { withMonolith } from '@fairgarden/monolith'\nexport default {}\n`, 'w', '@acme/w'),
    /never calls withMonolith/
  )
})

test('refuses when the apps are not written inline', () => {
  const source = `import { withMonolith } from '@fairgarden/monolith'
const apps = { id: '@acme/id' }
export default withMonolith({}, apps)
`
  assert.throws(() => addMount(source, 'w', '@acme/w'), /not written inline/)
})

test('refuses a file it cannot parse', () => {
  assert.throws(() => addMount('export default withMonolith(', 'w', '@acme/w'), /could not be parsed/)
})

test('recognises the config that composes modules', async () => {
  const { declaresMonolith } = await import('../dist/config-edit.js')
  assert.equal(declaresMonolith(SCAFFOLD), true)
})

test('does not mistake a module for the app composing them', async () => {
  const { declaresMonolith } = await import('../dist/config-edit.js')
  // a module imports from this package too, for portability and links
  const moduleConfig = `import { withMonolithicPortability } from '@fairgarden/monolith'
export default withMonolithicPortability({})
`
  assert.equal(declaresMonolith(moduleConfig), false)
  assert.equal(declaresMonolith('export default {}\n'), false)
  assert.equal(declaresMonolith('not valid ts ((('), false)
})

test('does not count an import without a call', async () => {
  const { declaresMonolith } = await import('../dist/config-edit.js')
  assert.equal(
    declaresMonolith(`import { withMonolith } from '@fairgarden/monolith'\nexport default {}\n`),
    false
  )
})
