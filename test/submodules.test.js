import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { submodules, inspect, target, moveTo, repositoryRoot } from '../dist/submodules.js'

// Signing is off because it cannot prompt here, and file transport is allowed
// so a submodule can point at a sibling directory.
const git = (cwd, args) =>
  execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'protocol.file.allow=always', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      },
    }
  ).trim()

let root
let modules

before(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'submod-'))

  const remote = (name, tags) => {
    const dir = path.join(base, 'remotes', name)
    execFileSync('mkdir', ['-p', dir])
    git(dir, ['init', '-q', '-b', 'main'])
    writeFileSync(path.join(dir, 'f.txt'), 'x')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'init'])
    for (const tag of tags) {
      appendFileSync(path.join(dir, 'f.txt'), `${tag}\n`)
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-qm', `release ${tag}`])
      git(dir, ['tag', tag])
    }
    return dir
  }

  remote('id', ['v1.0.0', 'v1.0.1', 'v1.1.0', 'v2.0.0'])
  remote('design', ['v0.3.0', 'v0.3.1'])
  remote('members', [])

  root = path.join(base, 'mono')
  execFileSync('mkdir', ['-p', root])
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(root, 'README.md'), 'root')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  for (const name of ['id', 'design', 'members']) {
    git(root, ['submodule', 'add', '-q', `../remotes/${name}`, `modules/${name}`])
  }
  git(root, ['commit', '-qm', 'add submodules'])
  git(path.join(root, 'modules/id'), ['checkout', '-q', 'refs/tags/v1.0.0'])
  git(path.join(root, 'modules/design'), ['checkout', '-q', 'refs/tags/v0.3.0'])

  modules = Object.fromEntries(submodules(root).map((m) => [m.name, m]))
})

const state = (name) => inspect(modules[name], { fetch: false })

test('finds every submodule with its url and pinned commit', () => {
  const found = submodules(root)
  assert.deepEqual(found.map((m) => m.name).sort(), ['design', 'id', 'members'])
  assert.match(found.find((m) => m.name === 'id').url, /remotes\/id$/)
  assert.match(found.find((m) => m.name === 'id').pinned, /^[0-9a-f]{40}$/)
})

test('finds the repository root from a nested directory', () => {
  assert.equal(repositoryRoot(path.join(root, 'modules')), root)
})

test('reads the pinned version and what is newer', () => {
  const id = state('id')
  assert.equal(id.current, 'v1.0.0')
  assert.equal(id.exact, true)
  assert.deepEqual(id.available, ['v2.0.0', 'v1.1.0', 'v1.0.1'])
})

test('classifies each upgrade, keeping the newest of each kind', () => {
  assert.deepEqual(state('id').upgrades, {
    patch: 'v1.0.1',
    minor: 'v1.1.0',
    major: 'v2.0.0',
  })
})

test('reports a module with no newer versions as current', () => {
  const design = state('design')
  assert.equal(design.current, 'v0.3.0')
  assert.deepEqual(design.available, ['v0.3.1'])
  assert.equal(target(design), 'v0.3.1')
})

test('reports a module with no tags at all', () => {
  const members = state('members')
  assert.equal(members.current, undefined)
  assert.deepEqual(members.available, [])
  assert.equal(target(members), undefined)
})

test('holds majors back unless asked', () => {
  assert.equal(target(state('id')), 'v1.1.0')
  assert.equal(target(state('id'), { major: true }), 'v2.0.0')
})

test('notices uncommitted changes, which make a bump unsafe', () => {
  assert.equal(state('id').dirty, false)
  appendFileSync(path.join(root, 'modules/id/f.txt'), 'scratch\n')
  assert.equal(state('id').dirty, true)
  git(path.join(root, 'modules/id'), ['checkout', 'f.txt'])
  assert.equal(state('id').dirty, false)
})

test('moves the checkout to a tag', () => {
  moveTo(modules['id'], 'v1.1.0')
  const after = state('id')
  assert.equal(after.current, 'v1.1.0')
  assert.deepEqual(after.available, ['v2.0.0'])
  assert.equal(target(after), undefined) // only a major is left
  assert.equal(target(after, { major: true }), 'v2.0.0')
  moveTo(modules['id'], 'v1.0.0')
})

test('refuses to move to a tag that does not exist', () => {
  assert.throws(() => moveTo(modules['id'], 'v9.9.9'), /Could not check out v9\.9\.9/)
})

test('skips fetching when asked, and reports when it was not attempted', () => {
  assert.equal(state('id').fetched, undefined)
})
