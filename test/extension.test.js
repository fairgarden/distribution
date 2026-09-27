import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stampCanary } from '../dist/canary.js'
import { inspectExtends } from '../dist/extends.js'
import { forkModule, integrate } from '../dist/forks.js'
import { inherit } from '../dist/inherit.js'
import { stampModules } from '../dist/manifest.js'
import { firstRelease, npmVersion } from '../dist/calver.js'
import { checkReleasable, releaseDistribution } from '../dist/release.js'
import { inspect, submodules } from '../dist/submodules.js'
import { writeDistributionWorkflow } from '../dist/workflows.js'

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
    writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

const commit = (dir, files, message) => {
  write(dir, files)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', message])
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** A module's repository with a v1.0.0 release, served bare as a host would. */
const moduleRepo = (base, name, files = {}) => {
  const work = path.join(base, `${name}-work`)
  mkdirSync(work)
  git(work, ['init', '-q', '-b', 'main'])
  commit(work, { 'package.json': { name: `@fair/${name}`, version: '1.0.0' }, ...files }, 'init')
  git(work, ['tag', 'v1.0.0'])
  const bare = path.join(base, `${name}.git`)
  git(base, ['clone', '-q', '--bare', work, bare])
  git(work, ['remote', 'add', 'origin', bare])
  const release = (version, more = {}) => {
    commit(work, { ...more, 'package.json': { name: `@fair/${name}`, version } }, `Release ${version}`)
    git(work, ['tag', `v${version}`])
    git(work, ['push', '-q', 'origin', 'main', '--tags'])
  }
  return { bare, work, release }
}

const distribution = (base, name, manifest) => {
  const root = path.join(base, name)
  mkdirSync(root)
  git(root, ['init', '-q', '-b', 'main'])
  commit(root, { 'package.json': manifest }, 'init')
  return root
}

/**
 * `@fair/core`, shipping a widget app from upstream and a kit package it has
 * forked, published; and `@acme/core`, a new distribution extending it with
 * the published manifest installed.
 */
const setup = () => {
  const base = mkdtempSync(path.join(tmpdir(), 'extension-'))
  const widget = moduleRepo(base, 'widget', { 'app/page.tsx': 'export default 1\n' })
  const kit = moduleRepo(base, 'kit', { 'index.ts': 'export {}\n' })
  const kitFork = path.join(base, 'kit-fork.git')
  git(base, ['clone', '-q', '--bare', kit.bare, kitFork])

  const parent = distribution(base, 'fair-core', { name: '@fair/core', version: '26.09.01-alpha.0' })
  git(parent, ['submodule', 'add', '-q', widget.bare, 'apps/widget'])
  git(parent, ['submodule', 'add', '-q', kit.bare, 'packages/kit'])
  forkModule(parent, submodules(parent).find((s) => s.name === 'kit'), kitFork)
  git(parent, ['add', '-A'])
  git(parent, ['commit', '-qm', 'modules'])

  const child = distribution(base, 'acme-core', {
    name: '@acme/core',
    version: '26.09.01-alpha.0',
    dependencies: { '@fair/core': '26.9.1-alpha.0' },
    distribution: { extends: '@fair/core' },
  })

  /** What `npm publish` then `pnpm install` would put in the child. */
  const publish = async () => {
    await stampModules(parent)
    write(child, { 'node_modules/@fair/core/package.json': readFileSync(path.join(parent, 'package.json'), 'utf8') })
    git(parent, ['checkout', '-q', 'package.json'])
  }

  return { base, widget, kit, kitFork, parent, child, publish }
}

test('a published distribution records every module: version, place, repository, commit', async () => {
  const { parent, widget, kit, kitFork } = setup()
  const modules = await stampModules(parent, { version: '26.9.1-alpha.0' })
  const pinned = (name) => submodules(parent).find((s) => s.name === name).pinned

  assert.deepEqual(modules, {
    '@fair/widget': { version: '1.0.0', path: 'apps/widget', repository: widget.bare, commit: pinned('widget') },
    '@fair/kit': {
      version: '1.0.0',
      path: 'packages/kit',
      repository: kitFork,
      upstream: kit.bare,
      commit: pinned('kit'),
    },
  })
  assert.deepEqual(readJson(path.join(parent, 'package.json')).distribution.modules, modules)
})

test('an extension inherits what its parent ships, forks included, and passes the floor', async () => {
  const { child, publish, kit, kitFork, parent } = setup()
  await publish()

  assert.equal(inspectExtends(child).violations.length, 2)
  const result = await inherit(child)
  assert.deepEqual(result.added.map((module) => module.path).sort(), ['apps/widget', 'packages/kit'])

  const shipped = submodules(child)
  for (const name of ['widget', 'kit']) {
    const ours = shipped.find((s) => s.name === name)
    assert.equal(ours.pinned, submodules(parent).find((s) => s.name === name).pinned)
  }
  const ourKit = shipped.find((s) => s.name === 'kit')
  assert.equal(ourKit.url, kitFork)
  assert.equal(ourKit.upstream, kit.bare)

  assert.deepEqual(inspectExtends(child).violations, [])
  const log = readFileSync(path.join(child, 'CHANGELOG.md'), 'utf8')
  assert.match(log, /- `@fair\/widget` 1\.0\.0 added, as @fair\/core ships it, from /)
  assert.match(log, /- `@fair\/kit` 1\.0\.0 added, as @fair\/core ships it, from .*kit-fork\.git, a fork of .*kit\.git/)
  const again = await inherit(child)
  assert.deepEqual(again.added, [])
  assert.deepEqual(again.shipped.sort(), ['@fair/kit', '@fair/widget'])
})

test("an extension's own fork keeps up with a parent that moves ahead", async () => {
  const { base, child, publish, parent, widget } = setup()
  await publish()
  await inherit(child)

  // The extension forks the widget and ships a change of its own.
  const widgetFork = path.join(base, 'widget-fork.git')
  git(base, ['clone', '-q', '--bare', widget.bare, widgetFork])
  forkModule(child, submodules(child).find((s) => s.name === 'widget'), widgetFork)
  const ours = path.join(child, 'apps/widget')
  commit(ours, { 'lib/ours.ts': 'export const ours = 1\n' }, 'Ours')

  // Upstream releases, the parent takes it and publishes again.
  widget.release('1.1.0', { 'app/page.tsx': 'export default 2\n' })
  const theirs = path.join(parent, 'apps/widget')
  git(theirs, ['fetch', '-q', '--tags'])
  git(theirs, ['checkout', '-q', 'v1.1.0'])
  await publish()

  const behind = inspectExtends(child).violations
  assert.deepEqual(behind.map((v) => [v.module, v.reason]), [['@fair/widget', 'behind']])

  const state = inspect(submodules(child).find((s) => s.name === 'widget'))
  assert.equal(integrate(child, state, 'v1.1.0').how, 'merged')
  assert.deepEqual(inspectExtends(child).violations, [])
  assert.ok(existsSync(path.join(ours, 'lib/ours.ts')))
})

test('a distribution publishes a canary of its next release, recording what it ships', async () => {
  const { parent } = setup()
  write(parent, { 'package.json': { name: '@fair/core', version: firstRelease() } })
  const result = await stampCanary(parent, { sha: 'abc', published: {} })
  assert.equal(result.version, `${npmVersion(firstRelease()).split('-')[0]}-0.canary.0`)
  const manifest = readJson(path.join(parent, 'package.json'))
  assert.equal(manifest.version, result.version)
  assert.deepEqual(Object.keys(manifest.distribution.modules).sort(), ['@fair/kit', '@fair/widget'])
})

test('a distribution publishes its version as npm spells it, and tags it as it is written', async () => {
  const { parent } = setup()
  write(parent, { 'package.json': { name: '@fair/core', version: firstRelease() } })
  const releasable = await checkReleasable(parent, { published: () => undefined })
  assert.equal(releasable.version, npmVersion(firstRelease()))
  assert.equal(releasable.tag, `v${firstRelease()}`)

  // A release of a month that is over is moved on first.
  write(parent, { 'package.json': { name: '@fair/core', version: '20.01.01-alpha.0' } })
  await assert.rejects(checkReleasable(parent, { published: () => undefined }), /month that is over/)
  write(parent, { 'package.json': { name: '@fair/core', version: '2026.9.27' } })
  await assert.rejects(checkReleasable(parent, { published: () => undefined }), /not a distribution version/)
})

test('releasing moves a distribution on: the next alpha, and a new month from the start', async () => {
  const { parent } = setup()
  const september = new Date('2026-09-20T12:00:00Z')
  const october = new Date('2026-10-02T12:00:00Z')
  const nothing = () => undefined
  write(parent, { 'package.json': { name: '@fair/core', version: '26.09.01-alpha.0' } })

  // Not published yet: it is what goes out next.
  let next = await releaseDistribution(parent, { on: september, published: nothing })
  assert.deepEqual([next.published, next.version], [false, '26.09.01-alpha.0'])

  // Published — the workflow tagged it — so it moves on to the next alpha.
  git(parent, ['tag', 'v26.09.01-alpha.0'])
  next = await releaseDistribution(parent, { on: september, published: nothing })
  assert.deepEqual([next.published, next.version], [true, '26.09.01-alpha.1'])
  assert.equal(readJson(path.join(parent, 'package.json')).version, '26.09.01-alpha.1')

  // Never published, and the month has turned: October's first release.
  next = await releaseDistribution(parent, { on: october, published: nothing })
  assert.deepEqual([next.published, next.version], [false, '26.10.01-alpha.0'])

  // On to beta, then stable, when asked.
  next = await releaseDistribution(parent, { on: october, id: 'beta', published: nothing })
  assert.equal(next.version, '26.10.01-beta.0')
  next = await releaseDistribution(parent, { on: october, stable: true, dryRun: true, published: nothing })
  assert.equal(next.version, '26.10.01')
})

test("a distribution's own workflow publishes it with its submodules and its policy", async () => {
  const { parent } = setup()
  write(parent, {
    'package.json': { name: '@fair/core', version: '26.09.01-alpha.0', private: true },
    'policies/.manifest': '{}',
  })
  const update = await writeDistributionWorkflow(parent)
  assert.equal(update.unprivated, true)
  assert.ok(update.files.includes('.github/workflows/publish.yml'))

  const workflow = readFileSync(path.join(parent, '.github/workflows/publish.yml'), 'utf8')
  assert.match(workflow, /submodules: true/)
  assert.match(workflow, /pnpm run canary/)
  assert.doesNotMatch(workflow, /pnpm run --if-present build/)
  // but fg-dist is built where it is a module of the distribution itself
  assert.match(workflow, /pnpm --filter @fairgarden\/distribution --include-workspace-root run --if-present build/)

  const manifest = readJson(path.join(parent, 'package.json'))
  assert.equal(manifest.private, undefined)
  assert.deepEqual(manifest.files, ['policies'])
  assert.equal(manifest.scripts['release:check'], 'fg-dist release --check')

  assert.equal((await writeDistributionWorkflow(parent)).skipped, true)
})
