import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractModule } from '../dist/extract.js'
import { submodules } from '../dist/submodules.js'

// extractModule commits, and it must sign when the user has configured signing
// — that is correct for a real extract and wrong for a test run, which would
// wake the GPG agent. These reach the git processes it spawns, unlike a `-c`
// flag on this file's own helper.
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
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

/** A distribution with a directory that grew inside it. */
const grown = ({ version = '0.3.0', name = '@acme/charts', at = 'packages/charts' } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'grow-'))
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/core' }))

  mkdirSync(path.join(root, at, 'src'), { recursive: true })
  writeFileSync(path.join(root, at, 'package.json'), JSON.stringify({ name, version }))
  writeFileSync(path.join(root, at, 'src', 'index.js'), 'export const x = 1\n')

  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'developed in place'])
  return root
}

const URL = 'https://example.com/acme/charts.git'

test('turns a directory into its own repository and a submodule', async () => {
  const root = grown()
  const result = await extractModule(root, 'packages/charts', { url: URL })

  assert.equal(result.relativePath, 'packages/charts')
  assert.equal(result.packageName, '@acme/charts')
  assert.equal(result.initialised, true)

  const [module] = submodules(root)
  assert.equal(module.relativePath, 'packages/charts')
  assert.equal(module.url, URL)
})

test('keeps the files exactly where they were, cloning nothing', async () => {
  const root = grown()
  await extractModule(root, 'packages/charts', { url: URL })
  assert.equal(
    readFileSync(path.join(root, 'packages/charts/src/index.js'), 'utf8'),
    'export const x = 1\n'
  )
  assert.ok(existsSync(path.join(root, 'packages/charts/.git')))
})

test('tags the version its manifest declares, so sync can track it', async () => {
  const root = grown({ version: '1.2.3' })
  const result = await extractModule(root, 'packages/charts', { url: URL })
  assert.equal(result.tagged, 'v1.2.3')
  assert.match(git(path.join(root, 'packages/charts'), ['tag', '--list']), /v1\.2\.3/)
})

test('skips tagging a version that is not semver', async () => {
  const root = grown({ version: 'nightly' })
  const result = await extractModule(root, 'packages/charts', { url: URL })
  assert.equal(result.tagged, undefined)
})

test('rewrites an ssh url, since a submodule is cloned without a key', async () => {
  const root = grown()
  const result = await extractModule(root, 'packages/charts', {
    url: 'git@github.com:acme/charts.git',
  })
  assert.equal(result.url, 'https://github.com/acme/charts.git')
  assert.equal(result.rewritten, true)
})

test('records an ssh url as given when asked', async () => {
  const root = grown()
  const result = await extractModule(root, 'packages/charts', {
    url: 'git@github.com:acme/charts.git',
    ssh: true,
  })
  assert.equal(result.url, 'git@github.com:acme/charts.git')
  assert.equal(result.rewritten, false)
})

test('refuses a directory that is already a submodule', async () => {
  const root = grown()
  await extractModule(root, 'packages/charts', { url: URL })
  await assert.rejects(
    extractModule(root, 'packages/charts', { url: URL }),
    /already a submodule/
  )
})

test('refuses something that is not a directory here', async () => {
  const root = grown()
  await assert.rejects(
    extractModule(root, 'packages/nothing', { url: URL }),
    /is not a directory/
  )
  await assert.rejects(extractModule(root, '../elsewhere', { url: URL }), /outside/)
})

test('keeps an existing repository and its history', async () => {
  const root = grown()
  const full = path.join(root, 'packages/charts')
  git(full, ['init', '-q', '-b', 'main'])
  git(full, ['add', '-A'])
  git(full, ['commit', '-qm', 'its own first commit'])

  const result = await extractModule(root, 'packages/charts', { url: URL })
  assert.equal(result.initialised, false)
  assert.match(git(full, ['log', '--oneline']), /its own first commit/)
})

test('refuses to mount a module that has no package name', async () => {
  // a bare string in the config is read back as a package name, so a path
  // would not resolve
  const { addModule } = await import('../dist/add-module.js')
  const base = mkdtempSync(path.join(tmpdir(), 'nameless-'))

  const remote = path.join(base, 'remote')
  mkdirSync(path.join(remote, 'app'), { recursive: true })
  writeFileSync(path.join(remote, 'app', 'page.tsx'), '')
  git(remote, ['init', '-q', '-b', 'main'])
  git(remote, ['add', '-A'])
  git(remote, ['commit', '-qm', 'init'])

  const root = path.join(base, 'mono')
  mkdirSync(path.join(root, 'apps', 'monolith'), { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  writeFileSync(
    path.join(root, 'apps/monolith/package.json'),
    JSON.stringify({ name: 'mono' })
  )
  writeFileSync(
    path.join(root, 'apps/monolith/next.config.ts'),
    `import { withMonolith } from '@fairgarden/monolith'\nexport default withMonolith({}, {})\n`
  )
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])

  const result = await addModule(root, remote, {})
  assert.equal(result.mounted, false)
  assert.match(result.mountError, /no package name/)
})
