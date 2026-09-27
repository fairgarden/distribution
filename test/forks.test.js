import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { contribute, forkModule, integrate, unforkModule } from '../dist/forks.js'
import { writeReadmes } from '../dist/readme.js'
import { notesFor } from '../dist/changelog.js'
import { inspect, submodules } from '../dist/submodules.js'

// Reach the git processes the code under test spawns: no signing, local
// remotes allowed, and someone to commit as.
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
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const write = (dir, files) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
}

const commit = (dir, files, message) => {
  write(dir, files)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', message])
}

const manifest = (version) => JSON.stringify({ name: '@acme/widget', version })

/**
 * An upstream module with a v1.0.0 release, a fork of it (a bare clone, as
 * GitHub makes one), and a distribution pinning the release. `release` is
 * upstream's maintainer publishing what is in their working copy.
 */
const setup = () => {
  const base = mkdtempSync(path.join(tmpdir(), 'forks-'))

  const work = path.join(base, 'upstream-work')
  mkdirSync(work)
  git(work, ['init', '-q', '-b', 'main'])
  commit(work, { 'package.json': manifest('1.0.0'), 'app/page.tsx': 'export default 1\n' }, 'init')
  git(work, ['tag', 'v1.0.0'])
  const upstream = path.join(base, 'upstream.git')
  git(base, ['clone', '-q', '--bare', work, upstream])
  git(work, ['remote', 'add', 'origin', upstream])

  const fork = path.join(base, 'fork.git')
  git(base, ['clone', '-q', '--bare', upstream, fork])

  const root = path.join(base, 'dist')
  mkdirSync(root)
  git(root, ['init', '-q', '-b', 'main'])
  write(root, { 'package.json': JSON.stringify({ name: '@acme/core', version: '26.09.01-alpha.0' }) })
  git(root, ['submodule', 'add', '-q', upstream, 'apps/widget'])
  git(path.join(root, 'apps/widget'), ['checkout', '-q', 'v1.0.0'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])

  const release = (files, version) => {
    commit(work, { ...files, 'package.json': manifest(version) }, `Release ${version}`)
    git(work, ['tag', `v${version}`])
    git(work, ['push', '-q', 'origin', 'main', '--tags'])
  }

  return { base, work, upstream, fork, root, release, widget: path.join(root, 'apps/widget') }
}

const module = (root) => submodules(root).find((found) => found.name === 'widget')

test('a fork is checked out from the fork and remembers its upstream', () => {
  const { root, upstream, fork, widget } = setup()
  const result = forkModule(root, module(root), fork)

  assert.equal(result.upstream, upstream)
  assert.equal(result.branch, 'acme-core')
  assert.equal(git(root, ['config', '-f', '.gitmodules', 'submodule.apps/widget.url']), fork)
  assert.equal(git(root, ['config', '-f', '.gitmodules', 'submodule.apps/widget.upstream']), upstream)
  assert.equal(git(widget, ['remote', 'get-url', 'origin']), fork)
  assert.equal(git(widget, ['remote', 'get-url', 'upstream']), upstream)
  // The pinned commit is on the fork, on a branch that outlives any pull request.
  assert.equal(git(fork, ['rev-parse', 'acme-core']), git(widget, ['rev-parse', 'HEAD']))

  assert.equal(module(root).upstream, upstream)
})

test('forking onto a fork whose branch has moved on changes nothing', () => {
  const { root, fork, widget, base } = setup()
  // Someone pinned more on the fork's distribution branch before.
  const other = path.join(base, 'other')
  git(base, ['clone', '-q', fork, other])
  commit(other, { 'lib/theirs.ts': 'export {}\n' }, 'Theirs')
  git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/acme-core'])

  assert.throws(() => forkModule(root, module(root), fork), /has commits that apps\/widget does not/)
  assert.equal(module(root).upstream, undefined)
  assert.notEqual(git(root, ['config', '-f', '.gitmodules', 'submodule.apps/widget.url']), fork)
  assert.notEqual(git(widget, ['remote', 'get-url', 'origin']), fork)
})

test("the distribution's readme says which modules are forks, and of what", async () => {
  const { root, upstream, fork } = setup()
  forkModule(root, module(root), fork)
  write(root, { 'Readme.md': '# Acme\n\n<!-- fg:modules -->\n<!-- /fg:modules -->\n' })
  await writeReadmes(root)
  const readme = readFileSync(path.join(root, 'Readme.md'), 'utf8')
  assert.match(readme, new RegExp(`\\| \`@acme/widget\`<br>Fork of ${upstream.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`))
})

test('a fork has to exist, and cannot be its own upstream', () => {
  const { root, base, upstream } = setup()
  assert.throws(() => forkModule(root, module(root), path.join(base, 'nowhere.git')), /Could not read/)
  assert.throws(() => forkModule(root, module(root), upstream), /already checked out from/)
})

test('a fix goes upstream, and once released there the fork goes back to upstream', () => {
  const { root, upstream, fork, widget, work, release } = setup()
  forkModule(root, module(root), fork)

  git(widget, ['switch', '-q', '-c', 'fix-page'])
  commit(widget, { 'app/page.tsx': 'export default 2\n' }, 'Fix the page')
  const fix = git(widget, ['rev-parse', 'HEAD'])

  const offered = contribute(root, module(root))
  assert.equal(offered.branch, 'fix-page')
  assert.equal(offered.base, 'main')
  assert.equal(offered.pinnedOn, 'acme-core')
  assert.equal(git(fork, ['rev-parse', 'fix-page']), fix)
  assert.equal(git(fork, ['rev-parse', 'acme-core']), fix)
  // Noted by what it is, never by the branch it was made on.
  const noted = notesFor(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '26.09.01-alpha.0')
  assert.match(noted, /- `@acme\/widget` ahead of its next release: Fix the page\n/)
  assert.equal(noted.includes('fix-page'), false)

  let state = inspect(module(root))
  assert.equal(state.pushed, true)
  assert.deepEqual(state.fork, { upstream, ahead: 1, merged: undefined })

  // Upstream squashes the pull request, then releases with more of its own.
  git(work, ['fetch', '-q', fork, 'fix-page'])
  git(work, ['merge', '-q', '--squash', 'FETCH_HEAD'])
  git(work, ['commit', '-qm', 'Fix the page (#1)'])
  release({ 'README.md': 'more\n' }, '1.0.1')

  state = inspect(module(root))
  assert.deepEqual(state.available, ['v1.0.1'])
  assert.equal(state.fork.merged, 'v1.0.1')

  const back = unforkModule(root, state)
  assert.deepEqual(back, { url: upstream, to: 'v1.0.1' })
  assert.equal(git(root, ['config', '-f', '.gitmodules', 'submodule.apps/widget.url']), upstream)
  assert.throws(() => git(root, ['config', '-f', '.gitmodules', 'submodule.apps/widget.upstream']))
  assert.equal(git(widget, ['rev-parse', 'HEAD']), git(widget, ['rev-parse', 'v1.0.1^{commit}']))
  assert.equal(git(widget, ['remote', 'get-url', 'origin']), upstream)
  assert.equal(module(root).upstream, undefined)
})

test('a fork that keeps its own work takes upstream releases by merging them', () => {
  const { root, fork, widget, release } = setup()
  forkModule(root, module(root), fork)
  commit(widget, { 'lib/ours.ts': 'export const ours = true\n' }, 'Something of our own')
  const ours = git(widget, ['rev-parse', 'HEAD'])

  release({ 'app/page.tsx': 'export default 3\n' }, '1.1.0')
  const state = inspect(module(root))
  assert.equal(state.upgrades.minor, 'v1.1.0')
  assert.equal(state.fork.merged, undefined)

  const done = integrate(root, state, 'v1.1.0')
  assert.deepEqual(done, { how: 'merged', pushed: 'acme-core' })
  const head = git(widget, ['rev-parse', 'HEAD'])
  // Both the release and our own commit, and the version upstream released.
  git(widget, ['merge-base', '--is-ancestor', 'v1.1.0', head])
  git(widget, ['merge-base', '--is-ancestor', ours, head])
  assert.equal(JSON.parse(readFileSync(path.join(widget, 'package.json'), 'utf8')).version, '1.1.0')
  assert.equal(git(fork, ['rev-parse', 'acme-core']), head)

  const after = inspect(module(root))
  assert.equal(after.current, 'v1.1.0')
  assert.equal(after.fork.ahead, 1)
  assert.equal(after.pushed, true)
})

test('a fork whose work upstream has released just moves to the release', () => {
  const { root, fork, widget, work, release } = setup()
  forkModule(root, module(root), fork)
  commit(widget, { 'app/page.tsx': 'export default 2\n' }, 'Fix the page')
  git(widget, ['push', '-q', 'origin', 'HEAD:refs/heads/acme-core'])

  git(work, ['fetch', '-q', fork, 'acme-core'])
  git(work, ['merge', '-q', '--squash', 'FETCH_HEAD'])
  git(work, ['commit', '-qm', 'Fix the page (#1)'])
  release({}, '1.0.1')

  const state = inspect(module(root))
  assert.deepEqual(integrate(root, state, 'v1.0.1'), { how: 'moved', pushed: 'v1.0.1' })
  assert.equal(git(widget, ['rev-parse', 'HEAD']), git(widget, ['rev-parse', 'v1.0.1^{commit}']))
  // The fork has the release now, since that is what is pinned.
  assert.equal(git(fork, ['rev-parse', 'v1.0.1^{commit}']), git(widget, ['rev-parse', 'HEAD']))
})

test('going back refuses to drop what upstream does not have, unless told to', () => {
  const { root, fork, widget } = setup()
  forkModule(root, module(root), fork)
  commit(widget, { 'lib/ours.ts': 'export const ours = true\n' }, 'Something of our own')

  const state = inspect(module(root))
  assert.throws(() => unforkModule(root, state), /has not taken everything[\s\S]*Something of our own/)
  assert.throws(() => unforkModule(root, state, { to: 'v1.0.0' }), /does not have everything/)
  assert.deepEqual(unforkModule(root, state, { to: 'v1.0.0', force: true }).to, 'v1.0.0')
})

test('a pinned commit nobody pushed is reported', () => {
  const { root, widget } = setup()
  commit(widget, { 'lib/local.ts': 'export {}\n' }, 'Only here')
  assert.equal(inspect(module(root)).pushed, false)
  assert.equal(inspect(module(root), { fetch: false }).pushed, undefined)
})

test('contribute wants a branch and a clean checkout', () => {
  const { root, fork, widget } = setup()
  forkModule(root, module(root), fork)
  assert.throws(() => contribute(root, module(root)), /not on a branch/)
  git(widget, ['switch', '-q', '-c', 'change'])
  write(widget, { 'app/page.tsx': 'dirty\n' })
  assert.throws(() => contribute(root, module(root)), /uncommitted changes/)
})

test("the distribution's changelog notes forking, taking releases, and going back", () => {
  const { root, upstream, fork, widget, work, release } = setup()
  const notes = () => notesFor(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '26.09.01-alpha.0')

  forkModule(root, module(root), fork)
  assert.match(notes(), new RegExp(`- \`@acme/widget\` forked to ${fork}, from ${upstream}\n`))

  commit(widget, { 'lib/ours.ts': 'export {}\n' }, 'Ours')
  release({ 'app/page.tsx': 'export default 3\n' }, '1.1.0')
  integrate(root, inspect(module(root)), 'v1.1.0')
  assert.match(notes(), /- `@acme\/widget` 1\.0\.0 → 1\.1\.0, merged into the fork\n/)

  // Upstream takes our commit, and releases it.
  git(work, ['fetch', '-q', fork, 'acme-core'])
  git(work, ['merge', '-q', 'FETCH_HEAD'])
  release({}, '1.2.0')
  unforkModule(root, inspect(module(root)))
  assert.match(notes(), new RegExp(`- \`@acme/widget\` back to ${upstream} at 1\.2\.0, which has everything the fork added\n`))
})
