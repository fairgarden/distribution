import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeReadmes } from '../dist/readme.js'
import { writeOverrides } from '../dist/overrides.js'
import { verify } from '../dist/verify.js'

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

const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const moduleRepo = (dir, version = '1.2.0') => {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  json(path.join(dir, 'package.json'), { name: '@acme/widget', version })
  writeFileSync(path.join(dir, 'Readme.md'), '# @acme/widget\n\nProse.\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

/** A distribution shipping one module, with everything fg-dist writes written. */
const distribution = async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'verify-'))
  const remote = moduleRepo(path.join(base, 'widget'))
  git(remote, ['tag', 'v1.2.0'])

  const root = path.join(base, 'core')
  mkdirSync(root)
  git(root, ['init', '-q', '-b', 'main'])
  json(path.join(root, 'package.json'), { name: '@acme/core', version: '26.09.01-alpha.0' })
  writeFileSync(path.join(root, 'Readme.md'), '# @acme/core\n\nProse.\n')
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  git(root, ['submodule', 'add', '-q', remote, 'apps/widget'])
  await writeReadmes(root, { modules: false })
  await writeOverrides(root)
  return root
}

const failing = (checks) => checks.filter((check) => !check.ok)

test('a module is checked on its readme, and told how to fix it', async () => {
  const root = moduleRepo(mkdtempSync(path.join(tmpdir(), 'verify-module-')))
  await writeReadmes(root)
  assert.deepEqual(failing(await verify(root)), [])

  // Moved by hand, without the readme.
  json(path.join(root, 'package.json'), { name: '@acme/widget', version: '1.3.0' })
  const [stale] = failing(await verify(root))
  assert.equal(stale.what, 'Readme.md')
  assert.equal(stale.fix, 'pnpm dist readme')
})

test("a distribution is checked on what it can fix, and not on its modules' readmes", async () => {
  const root = await distribution()
  const checks = await verify(root)
  assert.deepEqual(checks.map((check) => check.what), ['Readme.md', 'pnpm-workspace.yaml'])
  // The module's readme has no version block: that is its own CI's to fail.
  assert.deepEqual(failing(checks), [])
})

test('a pin moved without the readme, or a module without the overrides, fails', async () => {
  const root = await distribution()
  const widget = path.join(root, 'apps/widget')
  writeFileSync(path.join(widget, 'extra.txt'), 'x')
  git(widget, ['add', '-A'])
  git(widget, ['commit', '-qm', 'after the tag'])
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')

  const stale = failing(await verify(root))
  assert.deepEqual(stale.map((check) => check.fix), ['pnpm dist readme', 'pnpm dist overrides'])
})
