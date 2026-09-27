import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  aheadEntry,
  bumpEntry,
  checkChangelog,
  crossedReleases,
  newChangelog,
  notesFor,
  renameTop,
  topVersion,
  withEntry,
  withSection,
} from '../dist/changelog.js'
import { releaseDistribution } from '../dist/release.js'
import { writeDistributionChecks, writeWorkflows } from '../dist/workflows.js'

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
    writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

const commit = (dir, files, message) => {
  write(dir, files)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', message])
}

const PR = 'https://github.com/acme/widget/pull/42'

test('entries go under the top section, which is the version being worked on', () => {
  let text = newChangelog('1.1.0')
  text = withEntry(text, '1.1.0', `Fix the login ([#42](${PR}))`)
  text = withEntry(text, '1.1.0', 'Faster sign-in')
  text = withEntry(text, '1.1.0', 'Faster sign-in') // once only
  assert.equal(topVersion(text), '1.1.0')
  assert.equal(notesFor(text, '1.1.0'), `- Fix the login ([#42](${PR}))\n- Faster sign-in\n`)

  // The next version opens above it, and the older section keeps its lines.
  text = withEntry(withSection(text, '1.2.0'), '1.2.0', 'New thing')
  assert.match(text, /## 1\.2\.0\n\n- New thing\n\n## 1\.1\.0\n\n- Fix the login/)
  assert.equal(notesFor(text, '1.1.0'), `- Fix the login ([#42](${PR}))\n- Faster sign-in\n`)
  assert.equal(notesFor(text, '1.3.0'), undefined)
})

test("a distribution's notes are found whichever way the version is spelled", () => {
  const text = withEntry(newChangelog('26.09.01-alpha.0'), '26.09.01-alpha.0', '`@acme/id` 1.0.0 → 1.1.0')
  assert.equal(notesFor(text, '26.9.1-alpha.0'), '- `@acme/id` 1.0.0 → 1.1.0\n')
  assert.equal(topVersion(renameTop(text, '26.09.01-alpha.0', '26.10.01-alpha.0')), '26.10.01-alpha.0')
})

/** A module with a changelog on main, and a pull request branch off it. */
const moduleRepo = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'changelog-'))
  git(root, ['init', '-q', '-b', 'main'])
  commit(
    root,
    {
      'package.json': { name: '@acme/widget', version: '1.1.0' },
      'CHANGELOG.md': withEntry(withSection(newChangelog('1.0.0'), '1.1.0'), '1.1.0', 'Earlier change'),
    },
    'init'
  )
  const base = git(root, ['rev-parse', 'HEAD'])
  git(root, ['switch', '-q', '-c', 'fix-login'])
  commit(root, { 'app/page.tsx': 'fixed\n' }, 'Fix the login')
  return { root, base }
}

const check = (root, base, extra = {}) =>
  checkChangelog(root, { pullRequest: 42, repository: 'acme/widget', base, distribution: false, ...extra })

test('a pull request needs a line linking itself under the top section', () => {
  const { root, base } = moduleRepo()
  let result = check(root, base)
  assert.equal(result.ok, false)
  assert.match(result.message, /under 1\.1\.0[\s\S]*\(\[#42\]\(https:\/\/github\.com\/acme\/widget\/pull\/42\)\)/)

  const file = path.join(root, 'CHANGELOG.md')
  commit(root, { 'CHANGELOG.md': withEntry(readFileSync(file, 'utf8'), '1.1.0', `Fix the login ([#42](${PR}))`) }, 'Note it')
  result = check(root, base)
  assert.deepEqual([result.ok, result.required], [true, true])
})

test('a line under a version already released does not count', () => {
  const { root, base } = moduleRepo()
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(
    '## 1.0.0\n',
    `## 1.0.0\n\n- Fix the login ([#42](${PR}))\n`
  )
  commit(root, { 'CHANGELOG.md': text }, 'Note it in the wrong place')
  const result = check(root, base)
  assert.equal(result.ok, false)
  assert.match(result.message, /not under 1\.1\.0/)
})

test('a pull request labelled "skip changelog" needs none', () => {
  const { root, base } = moduleRepo()
  assert.deepEqual(check(root, base, { labels: ['skip changelog'] }).ok, true)
})

test("in a distribution, only a pull request changing its policy needs a line", () => {
  const root = mkdtempSync(path.join(tmpdir(), 'changelog-dist-'))
  git(root, ['init', '-q', '-b', 'main'])
  commit(root, { 'package.json': { name: '@acme/core', version: '26.09.01-alpha.0' }, 'CHANGELOG.md': newChangelog('26.09.01-alpha.0') }, 'init')
  const base = git(root, ['rev-parse', 'HEAD'])
  const distribution = { distribution: true, repository: 'acme/core' }
  const link = 'https://github.com/acme/core/pull/42'

  commit(root, { 'apps/monolith/next.config.ts': 'export default {}\n' }, 'Not policy')
  assert.deepEqual(check(root, base, distribution).required, false)

  commit(root, { 'policies/acme/members.rego': 'package fairgarden.members\n' }, 'A rule of our own')
  assert.equal(check(root, base, distribution).ok, false)

  const text = withEntry(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '26.09.01-alpha.0', `Members need a referral ([#42](${link}))`)
  commit(root, { 'CHANGELOG.md': text }, 'Note it')
  assert.equal(check(root, base, distribution).ok, true)
})

test("releasing a distribution opens the next version's section, or renames one never published", async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'changelog-release-'))
  git(root, ['init', '-q', '-b', 'main'])
  write(root, {
    'package.json': { name: '@acme/core', version: '26.09.01-alpha.0' },
    'CHANGELOG.md': withEntry(newChangelog('26.09.01-alpha.0'), '26.09.01-alpha.0', 'First'),
    '.gitmodules': '[submodule "apps/x"]\n\tpath = apps/x\n\turl = https://example.invalid/x.git\n',
  })
  const nothing = () => undefined
  const september = new Date('2026-09-20T12:00:00Z')

  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  git(root, ['tag', 'v26.09.01-alpha.0'])
  await releaseDistribution(root, { on: september, published: nothing })
  let text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.equal(topVersion(text), '26.09.01-alpha.1')
  assert.equal(notesFor(text, '26.09.01-alpha.0'), '- First\n')

  // Never published, and October now: the section moves with it.
  await releaseDistribution(root, { on: new Date('2026-10-02T12:00:00Z'), published: nothing })
  text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.equal(topVersion(text), '26.10.01-alpha.0')
  assert.equal(text.includes('## 26.09.01-alpha.1'), false)
})

test('workflows gives modules a changelog check and a changelog, and the distribution its own', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'changelog-workflows-'))
  git(root, ['init', '-q', '-b', 'main'])
  write(root, { 'package.json': { name: '@acme/core', version: '26.09.01-alpha.0', private: true } })
  const widget = path.join(root, 'apps/widget')
  mkdirSync(widget, { recursive: true })
  git(widget, ['init', '-q', '-b', 'main'])
  // One that publishes already, from an earlier fg-dist.
  commit(widget, { 'package.json': { name: '@acme/widget', version: '1.1.0' }, '.github/workflows/publish.yml': 'name: Publish\n' }, 'init')
  write(root, { '.gitmodules': '[submodule "apps/widget"]\n\tpath = apps/widget\n\turl = https://example.invalid/widget.git\n' })

  const [update] = await writeWorkflows(root)
  assert.deepEqual(update.files, ['.github/actions/publish-prepare/action.yml', '.github/workflows/changelog.yml', '.github/workflows/verify.yml', 'CHANGELOG.md', 'package.json'])
  assert.equal(readFileSync(path.join(widget, '.github/workflows/publish.yml'), 'utf8'), 'name: Publish\n')
  assert.equal(topVersion(readFileSync(path.join(widget, 'CHANGELOG.md'), 'utf8')), '1.1.0')
  assert.equal(JSON.parse(readFileSync(path.join(widget, 'package.json'), 'utf8')).scripts.changelog, 'fg-dist changelog')
  assert.doesNotMatch(readFileSync(path.join(widget, '.github/workflows/changelog.yml'), 'utf8'), /submodules: true/)
  // A module's readme says only what its manifest does: no modules, no tags.
  const moduleVerify = readFileSync(path.join(widget, '.github/workflows/verify.yml'), 'utf8')
  assert.match(moduleVerify, /run: pnpm run dist verify/)
  assert.doesNotMatch(moduleVerify, /submodules: true|fetch-depth/)
  assert.equal(JSON.parse(readFileSync(path.join(widget, 'package.json'), 'utf8')).scripts.dist, 'fg-dist')

  const own = await writeDistributionChecks(root)
  assert.deepEqual(own.files, ['.github/workflows/changelog.yml', '.github/workflows/verify.yml', 'CHANGELOG.md', 'package.json'])
  assert.match(readFileSync(path.join(root, '.github/workflows/changelog.yml'), 'utf8'), /submodules: true/)
  // Its readme says whether each pin is a release, which takes the modules' tags.
  assert.match(readFileSync(path.join(root, '.github/workflows/verify.yml'), 'utf8'), /fetch-depth: 0[^\n]*\n\s+submodules: true/)
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.changelog, 'fg-dist changelog')
  assert.equal(manifest.scripts.dist, 'fg-dist')
  // Checking its changelog makes nothing public.
  assert.equal(manifest.private, true)
  assert.equal((await writeDistributionChecks(root)).skipped, true)
  assert.ok(existsSync(path.join(root, 'CHANGELOG.md')))
})

test("moving a module on opens the next version's section, on the branch that moves main", async () => {
  const { release } = await import('../dist/release.js')
  const root = mkdtempSync(path.join(tmpdir(), 'changelog-module-release-'))
  git(root, ['init', '-q', '-b', 'main'])
  commit(
    root,
    {
      'package.json': { name: '@acme/widget', version: '1.0.0-alpha.0' },
      'CHANGELOG.md': withEntry(newChangelog('1.0.0-alpha.0'), '1.0.0-alpha.0', `Fix the login ([#42](${PR}))`),
    },
    'init'
  )
  git(root, ['tag', 'v1.0.0-alpha.0'])

  const outcome = await release(root, { push: false })
  const text = git(root, ['show', `${outcome.created.at(-1)}:CHANGELOG.md`])
  assert.equal(topVersion(text), '1.0.0-alpha.1')
  assert.equal(notesFor(text, '1.0.0-alpha.0'), `- Fix the login ([#42](${PR}))\n`)
})

test('a change shipped ahead of a release says what it is, and links where it is read about', () => {
  assert.equal(
    aheadEntry('@fairgarden/members', 'Referral links expire after 30 days', {
      text: 'fairgarden/members#12',
      url: 'https://github.com/fairgarden/members/pull/12',
    }),
    '`@fairgarden/members` ahead of its next release: Referral links expire after 30 days ' +
      '([fairgarden/members#12](https://github.com/fairgarden/members/pull/12))'
  )
  assert.equal(aheadEntry('@acme/widget', 'Fix the page'), '`@acme/widget` ahead of its next release: Fix the page')
})

test('a bump links the notes of every release it takes in, prereleases too', () => {
  const newer = ['v2.0.0', 'v1.4.0', 'v1.3.0', 'v1.3.0-beta.0']
  assert.deepEqual(crossedReleases(newer, 'v1.4.0'), ['v1.3.0-beta.0', 'v1.3.0', 'v1.4.0'])

  const id = 'https://github.com/fairgarden/id.git'
  const notes = (tag) => `https://github.com/fairgarden/id/releases/tag/${tag}`
  assert.equal(
    bumpEntry('@fairgarden/id', 'v1.2.0', 'v1.4.0', id, crossedReleases(newer, 'v1.4.0')),
    '`@fairgarden/id` 1.2.0 → 1.4.0 (release notes: ' +
      `[1.3.0-beta.0](${notes('v1.3.0-beta.0')}), [1.3.0](${notes('v1.3.0')}), [1.4.0](${notes('v1.4.0')}))`
  )
  // One release is one link.
  assert.equal(
    bumpEntry('@fairgarden/id', 'v1.3.0', 'v1.4.0', id, ['v1.4.0']),
    `\`@fairgarden/id\` 1.3.0 → 1.4.0 ([release notes](${notes('v1.4.0')}))`
  )
})

test('nothing merges while the version its base is at is already released', () => {
  const { root, base } = moduleRepo()
  git(root, ['tag', 'v1.1.0', base])
  const result = check(root, base, { labels: ['skip changelog'] })
  assert.equal(result.ok, false)
  assert.match(result.message, /at 1\.1\.0, which is released/)
})

/** 1.1.0 released, and a branch off it that starts 1.2.0 as `next-version` does. */
const starting = () => {
  const { root, base } = moduleRepo()
  git(root, ['tag', 'v1.1.0', base])
  git(root, ['switch', '-q', '-c', 'start-1.2.0', base])
  const file = path.join(root, 'CHANGELOG.md')
  commit(
    root,
    {
      'package.json': { name: '@acme/widget', version: '1.2.0' },
      'CHANGELOG.md': withSection(readFileSync(file, 'utf8'), '1.2.0'),
      'Readme.md': '# @acme/widget\n\nVersion **1.2.0**\n',
    },
    'Start 1.2.0'
  )
  return { root, base }
}

test('the pull request that starts the next version needs no line of its own', () => {
  const { root, base } = starting()
  const result = check(root, base)
  assert.deepEqual([result.ok, result.required], [true, false])
  assert.match(result.message, /starts 1\.2\.0/)
})

test('a change that comes with starting the next version still needs its line', () => {
  // as when a fix and the bump that unblocks it land in one pull request
  const { root, base } = starting()
  commit(root, { 'app/page.tsx': 'fixed\n' }, 'Fix the login')
  let result = check(root, base)
  assert.deepEqual([result.ok, result.required], [false, true])
  assert.match(result.message, /under 1\.2\.0/)

  const file = path.join(root, 'CHANGELOG.md')
  commit(root, { 'CHANGELOG.md': withEntry(readFileSync(file, 'utf8'), '1.2.0', `Fix the login ([#42](${PR}))`) }, 'Note it')
  result = check(root, base)
  assert.deepEqual([result.ok, result.required], [true, true])
})

test('a dependency moved alongside the version is a change too', () => {
  const { root, base } = starting()
  commit(root, { 'package.json': { name: '@acme/widget', version: '1.2.0', dependencies: { next: '^16.3.6' } } }, 'Bump next')
  assert.equal(check(root, base).required, true)
})

test('the check builds fg-dist where it is the workspace root, which pnpm filters leave out', async () => {
  const { changelogWorkflow } = await import('../dist/workflows.js')
  const workflow = changelogWorkflow({ submodules: false })['.github/workflows/changelog.yml']
  assert.match(workflow, /pnpm --filter @fairgarden\/distribution --include-workspace-root run --if-present build/)
})
