import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { submodules, inspect, target, moveTo } from '../dist/submodules.js'
import { readDistribution, findFloorViolations } from '../dist/extends.js'
import { extractModule } from '../dist/extract.js'

process.env.GIT_CONFIG_COUNT = '3'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_CONFIG_KEY_1 = 'tag.gpgsign'
process.env.GIT_CONFIG_VALUE_1 = 'false'
process.env.GIT_CONFIG_KEY_2 = 'protocol.file.allow'
process.env.GIT_CONFIG_VALUE_2 = 'always'
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** A distribution with its own tags and one submodule. */
const repo = ({ moduleTags = ['v1.0.0'], distributionTag = 'v9.9.9' } = {}) => {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'))

  const remote = path.join(base, 'remote')
  mkdirSync(remote, { recursive: true })
  git(remote, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(remote, 'package.json'), JSON.stringify({ name: '@fg/thing', version: '1.0.0' }))
  git(remote, ['add', '-A'])
  git(remote, ['commit', '-qm', 'init'])
  for (const tag of moduleTags) git(remote, ['tag', tag])

  const root = path.join(base, 'dist')
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/core' }))
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  if (distributionTag) git(root, ['tag', distributionTag])
  git(root, ['submodule', 'add', '-q', remote, 'modules/thing'])
  git(root, ['commit', '-qm', 'add submodule'])

  return root
}

test('ignores a submodule that was never checked out', () => {
  // git run inside an empty submodule finds the distribution instead, and
  // would report its tags as the module's — or check one out onto its HEAD
  const root = repo()
  rmSync(path.join(root, 'modules/thing'), { recursive: true, force: true })
  mkdirSync(path.join(root, 'modules/thing'), { recursive: true })

  assert.deepEqual(submodules(root), [])
})

test('refuses to move a submodule that is not checked out', () => {
  const root = repo()
  const [module] = submodules(root)
  rmSync(path.join(root, 'modules/thing/.git'), { recursive: true, force: true })
  assert.throws(() => moveTo(module, 'v1.0.0'), /not checked out/)
})

test('holds a prerelease major back like any other major', () => {
  // semver.diff calls this premajor, which bucketed as patch and applied
  // without --major — and every module here is 0.x.y-alpha.n
  const root = repo({ moduleTags: ['v0.1.0-alpha.0', 'v1.0.0-alpha.0'] })
  const [module] = submodules(root)
  git(path.join(root, 'modules/thing'), ['checkout', '-q', 'refs/tags/v0.1.0-alpha.0'])

  const state = inspect(module, { fetch: false })
  assert.equal(state.upgrades.major, 'v1.0.0-alpha.0')
  assert.equal(target(state), undefined)
  assert.equal(target(state, { major: true }), 'v1.0.0-alpha.0')
})

test('survives a dependency range that is not a version', () => {
  // minVersion throws on these, which took the whole check down with it
  const ours = { name: 'ours', version: '1', modules: { '@fg/id': 'latest' }, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: { '@fg/id': 'github:acme/id' }, extends: undefined }
  assert.doesNotThrow(() => findFloorViolations(ours, parent))
  assert.deepEqual(findFloorViolations(ours, parent), [])
})

test('does not commit build output when extracting', () => {
  // the distribution's .gitignore stops applying once this is its own repo
  const root = repo()
  const dir = path.join(root, 'packages/charts')
  mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true })
  mkdirSync(path.join(dir, '.next'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/charts', version: '0.1.0' }))
  writeFileSync(path.join(dir, 'index.js'), 'export const x = 1\n')
  writeFileSync(path.join(dir, 'node_modules', 'junk', 'a.js'), '')
  writeFileSync(path.join(dir, '.next', 'build.js'), '')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'grown in place'])

  return extractModule(root, 'packages/charts', { url: 'https://example.com/a/charts.git' }).then(() => {
    const tracked = git(dir, ['ls-files']).split('\n')
    assert.ok(tracked.includes('index.js'))
    assert.ok(!tracked.some((f) => f.startsWith('node_modules/')), tracked.join(' '))
    assert.ok(!tracked.some((f) => f.startsWith('.next/')), tracked.join(' '))
    assert.ok(existsSync(path.join(dir, '.gitignore')))
  })
})

test('reads module versions only from checkouts that exist', () => {
  const root = repo()
  assert.deepEqual(readDistribution(root).modules, { '@fg/thing': '1.0.0' })
})
