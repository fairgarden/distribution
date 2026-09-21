import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { overridesBlock, writeOverrides } from '../dist/overrides.js'

process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const WORKSPACE = 'packages:\n  - "apps/*"\n  - "packages/*"\n'

const distribution = ({ workspace = WORKSPACE } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ov-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), workspace)

  const lines = []
  for (const [at, name] of [['apps/id', '@acme/id'], ['packages/design', '@acme/design']]) {
    const full = path.join(root, at)
    mkdirSync(full, { recursive: true })
    writeFileSync(
      path.join(full, 'package.json'),
      `${JSON.stringify({ name, version: '1.0.0' }, null, 2)}\n`
    )
    git(full, ['init', '--quiet', '--initial-branch=main'])
    git(full, ['add', '-A'])
    git(full, ['commit', '-m', 'init'])
    lines.push(`[submodule "${at}"]\n\tpath = ${at}\n\turl = https://example.invalid/${name}.git\n`)
  }
  writeFileSync(path.join(root, '.gitmodules'), lines.join(''))
  return root
}

const read = (root) => readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')

test('every module is overridden to the checkout, by name and not by version', async () => {
  const root = distribution()
  const result = await writeOverrides(root)

  assert.equal(result.changed, true)
  assert.deepEqual(result.names, ['@acme/design', '@acme/id'])

  const body = read(root)
  assert.match(body, /^ {2}"@acme\/design": "workspace:\*"$/m)
  assert.match(body, /^ {2}"@acme\/id": "workspace:\*"$/m)
  // The version lives in the submodule pin; restating it here is the thing
  // this whole arrangement exists to avoid.
  assert.equal(/1\.0\.0/.test(body), false)
})

test('the rest of the workspace file is left as it was', async () => {
  const root = distribution({
    workspace: 'packages:\n  - "apps/*"\n\n# a comment worth keeping\nlinkWorkspacePackages: true\n',
  })
  await writeOverrides(root)

  const body = read(root)
  assert.match(body, /# a comment worth keeping/)
  assert.match(body, /^linkWorkspacePackages: true$/m)
  assert.match(body, /^ {2}- "apps\/\*"$/m)
})

test('running it again rewrites nothing', async () => {
  const root = distribution()
  await writeOverrides(root)
  const once = read(root)

  const second = await writeOverrides(root)
  assert.equal(second.changed, false)
  assert.equal(read(root), once)
})

test('a module that joins later replaces the block rather than adding a second', async () => {
  const root = distribution()
  await writeOverrides(root)

  const at = path.join(root, 'apps/members')
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, 'package.json'), '{"name":"@acme/members","version":"1.0.0"}\n')
  git(at, ['init', '--quiet', '--initial-branch=main'])
  git(at, ['add', '-A'])
  git(at, ['commit', '-m', 'init'])
  writeFileSync(
    path.join(root, '.gitmodules'),
    `${readFileSync(path.join(root, '.gitmodules'), 'utf8')}[submodule "apps/members"]\n\tpath = apps/members\n\turl = https://example.invalid/members.git\n`
  )

  await writeOverrides(root)
  const body = read(root)

  assert.equal(body.match(/^overrides:$/gm).length, 1)
  assert.match(body, /"@acme\/members": "workspace:\*"/)
})

test('--check reports without writing', async () => {
  const root = distribution()
  const before = read(root)

  const result = await writeOverrides(root, { check: true })
  assert.equal(result.changed, true)
  assert.equal(read(root), before)
})

test('a repository with no submodules is left alone', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ov-solo-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), WORKSPACE)

  const result = await writeOverrides(root)
  assert.equal(result.changed, false)
  assert.equal(result.names.length, 0)
  // An empty overrides block would be noise, not configuration.
  assert.equal(/overrides:/.test(read(root)), false)
})

test('the block is only names, in a stable order', () => {
  const body = overridesBlock(['@acme/id', '@acme/design'])
  assert.match(body, /overrides:\n {2}"@acme\/id": "workspace:\*"\n {2}"@acme\/design": "workspace:\*"/)
})

test('an overrides key this did not write is not duplicated', async () => {
  const root = distribution({
    workspace: 'packages:\n  - "apps/*"\n\noverrides:\n  "left-pad": "1.0.0"\n',
  })

  await assert.rejects(() => writeOverrides(root), /already has an `overrides:` key/)
  // A second `overrides:` is not a merge, it is a file pnpm reads half of.
  assert.equal(read(root).match(/^overrides:$/gm).length, 1)
})

test('a workspace file that is not there is said to be missing', async () => {
  const root = distribution()
  rmSync(path.join(root, 'pnpm-workspace.yaml'))

  const result = await writeOverrides(root)
  assert.equal(result.missing, true)
  assert.equal(result.changed, false)
})

test('a submodule with no checkout is refused, not silently dropped', async () => {
  const root = distribution()
  // Declared in .gitmodules, never initialised — a plain `git clone`.
  writeFileSync(
    path.join(root, '.gitmodules'),
    `${readFileSync(path.join(root, '.gitmodules'), 'utf8')}[submodule "apps/members"]\n\tpath = apps/members\n\turl = https://example.invalid/members.git\n`
  )

  await assert.rejects(() => writeOverrides(root), /not checked out/)
})
