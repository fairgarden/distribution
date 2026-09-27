import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { newChangelog, notesFor, topVersion, withEntry } from '../dist/changelog.js'
import { release, releaseDistribution } from '../dist/release.js'

process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const write = (dir, files) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
}

/**
 * A repository as the release job has it: cloned from an origin, on main,
 * the version just published and tagged, and a lockfile the job resolved
 * lying untracked beside it.
 */
const released = (manifest, extra = {}) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cycle-'))
  const origin = path.join(base, 'origin.git')
  git(base, ['init', '-q', '--bare', '-b', 'main', origin])
  const root = path.join(base, 'work')
  mkdirSync(root)
  git(root, ['init', '-q', '-b', 'main'])
  write(root, {
    'package.json': manifest,
    'CHANGELOG.md': withEntry(newChangelog(manifest.version), manifest.version, 'What shipped'),
    ...extra,
  })
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  git(root, ['remote', 'add', 'origin', origin])
  git(root, ['tag', `v${manifest.version}`])
  git(root, ['push', '-q', 'origin', 'main', '--tags'])
  write(root, { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
  return { root, origin }
}

const onOrigin = (origin, ref, file) => git(origin, ['show', `${ref}:${file}`])

test('a module moves main on to its next prerelease, pushed, straight after releasing', async () => {
  const { root, origin } = released({ name: '@acme/widget', version: '1.0.0-alpha.0' })
  const outcome = await release(root, { direct: true })

  assert.deepEqual([outcome.base, outcome.pushed, outcome.created], ['main', true, []])
  assert.equal(JSON.parse(onOrigin(origin, 'main', 'package.json')).version, '1.0.0-alpha.1')
  const changelog = onOrigin(origin, 'main', 'CHANGELOG.md')
  assert.equal(topVersion(changelog), '1.0.0-alpha.1')
  assert.equal(notesFor(changelog, '1.0.0-alpha.0'), '- What shipped\n')
  assert.equal(git(origin, ['log', '-1', '--format=%s', 'main']), 'Start 1.0.0-alpha.1')
  // What the job made is not what it commits.
  assert.equal(git(origin, ['ls-tree', '--name-only', 'main']).includes('pnpm-lock.yaml'), false)
})

test('a minor release cuts its maintenance branch, and main starts the next minor', async () => {
  const { root, origin } = released({ name: '@acme/widget', version: '1.0.0' })
  const outcome = await release(root, { direct: true, bump: 'minor' })

  assert.deepEqual(outcome.created, ['v1-0'])
  assert.equal(JSON.parse(onOrigin(origin, 'v1-0', 'package.json')).version, '1.0.1')
  assert.equal(JSON.parse(onOrigin(origin, 'main', 'package.json')).version, '1.1.0')
  assert.equal(topVersion(onOrigin(origin, 'main', 'CHANGELOG.md')), '1.1.0')
})

test('a distribution is dated before it is published, and moved on after', async () => {
  const gitmodules = '[submodule "apps/x"]\n\tpath = apps/x\n\turl = https://example.invalid/x.git\n'
  const { root, origin } = released(
    { name: '@acme/core', version: '26.09.01-alpha.0' },
    { '.gitmodules': gitmodules }
  )
  const october = new Date('2026-10-02T12:00:00Z')
  const nothing = () => undefined

  // September's alpha.0 is out; main moved on to alpha.1, which never went out.
  let next = await releaseDistribution(root, { on: new Date('2026-09-20T12:00:00Z'), direct: true, published: nothing })
  assert.deepEqual([next.version, next.pushed], ['26.09.01-alpha.1', true])

  // October: what goes out is October's first release, pushed before it is.
  next = await releaseDistribution(root, { on: october, direct: true, published: nothing })
  assert.deepEqual([next.published, next.version, next.pushed], [false, '26.10.01-alpha.0', true])
  assert.equal(JSON.parse(onOrigin(origin, 'main', 'package.json')).version, '26.10.01-alpha.0')
  assert.equal(topVersion(onOrigin(origin, 'main', 'CHANGELOG.md')), '26.10.01-alpha.0')

  // Nothing to move while it is still unpublished this month.
  next = await releaseDistribution(root, { on: october, direct: true, published: nothing })
  assert.deepEqual([next.version, next.pushed], ['26.10.01-alpha.0', false])

  // Published and tagged: main starts the next alpha.
  git(root, ['tag', 'v26.10.01-alpha.0'])
  next = await releaseDistribution(root, { on: october, direct: true, published: nothing })
  assert.deepEqual([next.version, next.pushed], ['26.10.01-alpha.1', true])
  assert.equal(git(origin, ['log', '-1', '--format=%s', 'main']), 'Start 26.10.01-alpha.1')
})

test('the release workflows hold pull requests after tagging, and never push to main', async () => {
  const { publishWorkflow, distributionWorkflow } = await import('../dist/workflows.js')
  for (const workflow of [
    publishWorkflow('@acme/widget')['.github/workflows/publish.yml'],
    distributionWorkflow('@acme/core')['.github/workflows/publish.yml'],
  ]) {
    const tag = workflow.indexOf('gh release create "$TAG"')
    const hold = workflow.indexOf('pnpm run changelog hold')
    assert.ok(tag > 0 && tag < hold, 'held once it is released')
    assert.match(workflow, /actions: write/)
    // Its token cannot push to a protected main, so it does not try.
    assert.doesNotMatch(workflow, /--direct|inputs\.next/)
  }
})

test('each open pull request has its latest check on its head run again', async () => {
  const { holdsFor } = await import('../dist/changelog.js')
  const runs = [
    { databaseId: 30, headSha: 'bbb', event: 'pull_request', status: 'in_progress' },
    { databaseId: 20, headSha: 'aaa', event: 'pull_request', status: 'completed' },
    { databaseId: 10, headSha: 'aaa', event: 'pull_request', status: 'completed' },
    { databaseId: 5, headSha: 'ccc', event: 'push', status: 'completed' },
  ]
  const pullRequests = [
    { number: 1, headRefOid: 'aaa' },
    { number: 2, headRefOid: 'bbb' },
    { number: 3, headRefOid: 'ccc' },
  ]
  assert.deepEqual(holdsFor(pullRequests, runs), [
    { pullRequest: 1, run: 20, running: false },
    { pullRequest: 2, run: 30, running: true },
    // Only a push has run on it: its first check will see the release.
    { pullRequest: 3, run: undefined, running: false },
  ])
})
