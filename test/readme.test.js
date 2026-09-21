import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updateSection } from '../dist/readme.js'

test('adds a block after the first heading', () => {
  const out = updateSection('# Title\n\nSome prose.\n', 'version', '**1.0.0**')
  assert.match(out, /# Title\n\n<!-- fg:version -->\n\n\*\*1\.0\.0\*\*\n\n<!-- \/fg:version -->/)
  assert.match(out, /Some prose\./)
})

test('replaces the block without touching anything around it', () => {
  const before = `# Title

<!-- fg:version -->

**1.0.0** — old

<!-- /fg:version -->

Prose that must survive.

## A section

More prose.
`
  const out = updateSection(before, 'version', '**2.0.0** — new')
  assert.match(out, /\*\*2\.0\.0\*\* — new/)
  assert.doesNotMatch(out, /1\.0\.0/)
  assert.match(out, /Prose that must survive\./)
  assert.match(out, /## A section/)
  assert.match(out, /More prose\./)
})

test('is idempotent', () => {
  const once = updateSection('# Title\n\nProse.\n', 'version', '**1.0.0**')
  assert.equal(updateSection(once, 'version', '**1.0.0**'), once)
})

test('puts the block first when there is no heading', () => {
  const out = updateSection('Just prose.\n', 'modules', 'table')
  assert.ok(out.startsWith('<!-- fg:modules -->'))
  assert.match(out, /Just prose\./)
})

test('keeps different markers apart', () => {
  let out = updateSection('# Title\n\nProse.\n', 'version', 'V')
  out = updateSection(out, 'modules', 'M')
  assert.match(out, /<!-- fg:version -->\n\nV/)
  assert.match(out, /<!-- fg:modules -->\n\nM/)

  out = updateSection(out, 'version', 'V2')
  assert.match(out, /<!-- fg:version -->\n\nV2/)
  assert.match(out, /<!-- fg:modules -->\n\nM/)
})

test('does not treat a mention of the marker in prose as the block', () => {
  // an inline code span is not an html node, so it is left alone
  const before = '# Title\n\nWrite `<!-- fg:version -->` to mark the block.\n'
  const out = updateSection(before, 'version', '**1.0.0**')
  assert.match(out, /Write `<!-- fg:version -->` to mark the block\./)
  assert.match(out, /# Title\n\n<!-- fg:version -->\n\n\*\*1\.0\.0\*\*/)
})

test('replaces a multi-line block', () => {
  const before = `# Title

<!-- fg:modules -->

| Module | Version |
| --- | --- |
| \`a\` | 1.0.0 |

<!-- /fg:modules -->

After.
`
  const out = updateSection(before, 'modules', '| Module |\n| --- |\n| `b` |')
  assert.doesNotMatch(out, /1\.0\.0/)
  assert.match(out, /\| `b` \|/)
  assert.match(out, /After\./)
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeReadmes } from '../dist/readme.js'

process.env.GIT_CONFIG_COUNT = '2'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_CONFIG_KEY_1 = 'protocol.file.allow'
process.env.GIT_CONFIG_VALUE_1 = 'always'
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** A distribution with one module in a chosen release state. */
const distributionWith = ({ tag, ahead, remote = 'https://github.com/acme/widget.git' }) => {
  const base = mkdtempSync(path.join(tmpdir(), 'rmtag-'))

  const remoteDir = path.join(base, 'remote')
  mkdirSync(remoteDir, { recursive: true })
  git(remoteDir, ['init', '-q', '-b', 'main'])
  writeFileSync(
    path.join(remoteDir, 'package.json'),
    JSON.stringify({ name: '@acme/widget', version: '1.2.0' })
  )
  writeFileSync(path.join(remoteDir, 'Readme.md'), '# @acme/widget\n\nProse.\n')
  git(remoteDir, ['add', '-A'])
  git(remoteDir, ['commit', '-qm', 'init'])
  if (tag) git(remoteDir, ['tag', tag])
  if (ahead) {
    writeFileSync(path.join(remoteDir, 'extra.txt'), 'x')
    git(remoteDir, ['add', '-A'])
    git(remoteDir, ['commit', '-qm', 'after the tag'])
  }

  const root = path.join(base, 'dist')
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/core' }))
  writeFileSync(path.join(root, 'Readme.md'), '# @acme/core\n\nProse.\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  git(root, ['submodule', 'add', '-q', remoteDir, 'apps/widget'])
  git(root, ['config', '--file', '.gitmodules', 'submodule.apps/widget.url', remote])

  return root
}

const table = (root) => readFileSync(path.join(root, 'Readme.md'), 'utf8')

test('links to the tag when the pin is a released version', async () => {
  const root = distributionWith({ tag: 'v1.2.0' })
  await writeReadmes(root)
  assert.match(table(root), /\[v1\.2\.0\]\(https:\/\/github\.com\/acme\/widget\/tree\/v1\.2\.0\)/)
  assert.doesNotMatch(table(root), /unreleased/)
})

test('links to the commit and says so when the pin is ahead of its tag', async () => {
  const root = distributionWith({ tag: 'v1.2.0', ahead: true })
  await writeReadmes(root)
  const out = table(root)
  assert.match(out, /\/commit\/[0-9a-f]{40}\)/)
  assert.match(out, /unreleased, after v1\.2\.0/)
  // and it explains why that matters
  assert.match(out, /stated version is not what is deployed/)
})

test('says untagged when the module has never been released', async () => {
  const root = distributionWith({})
  await writeReadmes(root)
  assert.match(table(root), /— untagged/)
})

test('does not link a remote with no web address', async () => {
  const root = distributionWith({ tag: 'v1.2.0', remote: '../remote' })
  await writeReadmes(root)
  const out = table(root)
  assert.match(out, /\| v1\.2\.0 \|/)
  assert.doesNotMatch(out, /\]\(\.\.\/remote/)
})

test('rewrites an ssh remote into a browsable address', async () => {
  const root = distributionWith({ tag: 'v1.2.0', remote: 'git@github.com:acme/widget.git' })
  await writeReadmes(root)
  assert.match(table(root), /https:\/\/github\.com\/acme\/widget\/tree\/v1\.2\.0/)
})

test('a module states its own version and names no distribution', async () => {
  // the same module is shipped in several distributions, so naming one here
  // would be a claim it cannot make
  const root = distributionWith({ tag: 'v1.2.0' })
  await writeReadmes(root)
  const moduleReadme = readFileSync(path.join(root, 'apps/widget/Readme.md'), 'utf8')

  assert.match(moduleReadme, /Version \*\*1\.2\.0\*\*/)
  assert.doesNotMatch(moduleReadme, /@acme\/core/)
  assert.match(moduleReadme, /Prose\./)
})

test('the distribution readme is where the relationship lives', async () => {
  const root = distributionWith({ tag: 'v1.2.0' })
  await writeReadmes(root)
  assert.match(table(root), /`@acme\/widget`/)
})

test('links each module to its repository', async () => {
  const root = distributionWith({ tag: 'v1.2.0' })
  await writeReadmes(root)
  assert.match(table(root), /\[`@acme\/widget`\]\(https:\/\/github\.com\/acme\/widget\)/)
})

test('carries the description a module declares', async () => {
  const root = distributionWith({ tag: 'v1.2.0' })
  const manifest = path.join(root, 'apps/widget/package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  writeFileSync(manifest, JSON.stringify({ ...pkg, description: 'Does widget things' }))

  await writeReadmes(root)
  assert.match(table(root), /<br>Does widget things/)
})

test('leaves the cell bare when a module declares none', async () => {
  const root = distributionWith({ tag: 'v1.2.0' })
  await writeReadmes(root)
  assert.match(table(root), /\[`@acme\/widget`\]\([^)]+\) \| 1\.2\.0/)
})

/** A module repository on its own, with no submodules of its own. */
const standaloneModule = (version = '2.1.0') => {
  const root = mkdtempSync(path.join(tmpdir(), 'solo-'))
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@acme/widget', version })
  )
  writeFileSync(path.join(root, 'Readme.md'), '# @acme/widget\n\nProse.\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  return root
}

test('records its own version when run inside a module', async () => {
  // so a module releases on its own schedule, without the distribution
  const root = standaloneModule()
  const result = await writeReadmes(root)

  assert.equal(result.kind, 'module')
  assert.deepEqual(result.modules, [])
  const readme = readFileSync(path.join(root, 'Readme.md'), 'utf8')
  assert.match(readme, /Version \*\*2\.1\.0\*\*/)
  assert.match(readme, /Prose\./)
  // no table: it ships nothing
  assert.doesNotMatch(readme, /fg:modules/)
})

test('follows the module\'s own version when it is released', async () => {
  const root = standaloneModule('2.1.0')
  await writeReadmes(root)

  const manifest = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  writeFileSync(manifest, JSON.stringify({ ...pkg, version: '2.2.0' }))

  const stale = await writeReadmes(root, { check: true })
  assert.ok(stale.updates.some((update) => update.changed))

  await writeReadmes(root)
  assert.match(readFileSync(path.join(root, 'Readme.md'), 'utf8'), /Version \*\*2\.2\.0\*\*/)
})

test('lists modules when run inside a distribution instead', async () => {
  const root = distributionWith({ tag: 'v1.2.0' })
  const result = await writeReadmes(root)
  assert.equal(result.kind, 'distribution')
  assert.equal(result.modules.length, 1)
})

test('refuses a repository with nothing to record', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'empty-'))
  git(root, ['init', '-q', '-b', 'main'])
  await assert.rejects(writeReadmes(root), /nothing to record/)
})
