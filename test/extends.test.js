import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readDistribution,
  findFloorViolations,
  inspectExtends,
  assertExtends,
} from '../dist/extends.js'

/** A distribution on disk, optionally with its parent installed beside it. */
const distribution = ({ modules, extendsName, parent }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dist-'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@acme/core',
      version: '2024.06.01',
      dependencies: { ...modules, ...(extendsName ? { [extendsName]: 'latest' } : {}) },
      ...(extendsName ? { distribution: { extends: extendsName } } : {}),
    })
  )

  if (parent) {
    const dir = path.join(root, 'node_modules', ...extendsName.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: extendsName,
        version: parent.version ?? '2024.01.01',
        dependencies: parent.modules,
      })
    )
  }

  return root
}

test('reads the modules a distribution ships, excluding its parent', () => {
  const root = distribution({
    modules: { '@fg/id': '1.2.3' },
    extendsName: '@fg/core',
  })
  const read = readDistribution(root)
  assert.equal(read.version, '2024.06.01')
  assert.equal(read.extends, '@fg/core')
  assert.deepEqual(read.modules, { '@fg/id': '1.2.3' })
})

test('accepts an extension that ships the same versions', () => {
  const ours = { name: 'ours', version: '1', modules: { '@fg/id': '1.2.3' }, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: { '@fg/id': '1.2.3' }, extends: undefined }
  assert.deepEqual(findFloorViolations(ours, parent), [])
})

test('accepts an extension that has moved ahead', () => {
  const ours = { name: 'ours', version: '1', modules: { '@fg/id': '1.4.0' }, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: { '@fg/id': '1.2.3' }, extends: undefined }
  assert.deepEqual(findFloorViolations(ours, parent), [])
})

test('rejects an extension that ships something older', () => {
  const ours = { name: 'ours', version: '1', modules: { '@fg/id': '1.1.0' }, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: { '@fg/id': '1.2.3' }, extends: undefined }
  const [violation] = findFloorViolations(ours, parent)
  assert.equal(violation.module, '@fg/id')
  assert.equal(violation.reason, 'behind')
  assert.equal(violation.ours, '1.1.0')
  assert.equal(violation.parent, '1.2.3')
})

test('rejects an extension that drops an inherited module', () => {
  const ours = { name: 'ours', version: '1', modules: {}, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: { '@fg/id': '1.2.3' }, extends: undefined }
  const [violation] = findFloorViolations(ours, parent)
  assert.equal(violation.reason, 'missing')
})

test('ignores modules the parent does not ship', () => {
  const ours = { name: 'ours', version: '1', modules: { '@acme/extra': '0.1.0' }, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: {}, extends: undefined }
  assert.deepEqual(findFloorViolations(ours, parent), [])
})

test('compares ranges by the oldest version they allow', () => {
  const ours = { name: 'ours', version: '1', modules: { '@fg/id': '^1.1.0' }, extends: undefined }
  const parent = { name: 'parent', version: '1', modules: { '@fg/id': '^1.2.0' }, extends: undefined }
  // ^1.1.0 could resolve to 1.1.0, which is older than anything ^1.2.0 allows.
  assert.equal(findFloorViolations(ours, parent).length, 1)
})

test('reads the parent from node_modules and compares against it', () => {
  const root = distribution({
    modules: { '@fg/id': '1.1.0' },
    extendsName: '@fg/core',
    parent: { modules: { '@fg/id': '1.2.3' } },
  })
  const report = inspectExtends(root)
  assert.equal(report.parent.name, '@fg/core')
  assert.equal(report.violations.length, 1)
  assert.throws(() => assertExtends(root), /cannot ship anything older/)
})

test('says nothing when a distribution extends nothing', () => {
  const root = distribution({ modules: { '@fg/id': '1.0.0' } })
  const report = inspectExtends(root)
  assert.equal(report.parent, undefined)
  assert.deepEqual(report.violations, [])
  assert.doesNotThrow(() => assertExtends(root))
})

test('reports a parent that is declared but not installed', () => {
  const root = distribution({ modules: { '@fg/id': '1.0.0' }, extendsName: '@fg/core' })
  const report = inspectExtends(root)
  assert.equal(report.unresolved, '@fg/core')
  assert.deepEqual(report.violations, [])
})

test('names every module that is behind', () => {
  const root = distribution({
    modules: { '@fg/id': '1.1.0', '@fg/design': '0.9.0' },
    extendsName: '@fg/core',
    parent: { modules: { '@fg/id': '1.2.3', '@fg/design': '1.0.0' } },
  })
  assert.throws(
    () => assertExtends(root),
    (error) => /@fg\/id/.test(error.message) && /@fg\/design/.test(error.message)
  )
})

import { execFileSync } from 'node:child_process'

const git = (cwd, args) =>
  execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args],
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
  )

/** A distribution whose modules are real submodules, as a repository has. */
const withSubmodule = (moduleVersion) => {
  const base = mkdtempSync(path.join(tmpdir(), 'submod-dist-'))

  const remote = path.join(base, 'remote')
  mkdirSync(remote, { recursive: true })
  git(remote, ['init', '-q', '-b', 'main'])
  writeFileSync(
    path.join(remote, 'package.json'),
    JSON.stringify({ name: '@fg/id', version: moduleVersion })
  )
  git(remote, ['add', '-A'])
  git(remote, ['commit', '-qm', 'init'])

  const root = path.join(base, 'dist')
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@acme/core',
      version: '2024.06.01',
      // No module versions here: the submodule is the pin.
      dependencies: { '@fairgarden/core': 'latest' },
      distribution: { extends: '@fairgarden/core' },
    })
  )
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  git(root, ['submodule', 'add', '-q', remote, 'packages/id'])

  const parent = path.join(root, 'node_modules', '@fairgarden', 'core')
  mkdirSync(parent, { recursive: true })
  writeFileSync(
    path.join(parent, 'package.json'),
    JSON.stringify({
      name: '@fairgarden/core',
      version: '2024.01.01',
      dependencies: { '@fg/id': '1.2.0' },
    })
  )

  return root
}

test('takes module versions from the checkouts, not the manifest', () => {
  const root = withSubmodule('1.5.0')
  const read = readDistribution(root)
  assert.deepEqual(read.modules, { '@fg/id': '1.5.0' })
})

test('compares the checked-out version against what the parent ships', () => {
  assert.deepEqual(inspectExtends(withSubmodule('1.5.0')).violations, [])

  const behind = inspectExtends(withSubmodule('1.1.0'))
  assert.equal(behind.violations.length, 1)
  assert.equal(behind.violations[0].ours, '1.1.0')
  assert.equal(behind.violations[0].parent, '1.2.0')
})

test('ignores workspace links, which name no version', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@acme/core',
      version: '2024.06.01',
      dependencies: { '@fg/id': 'workspace:*', '@fg/design': 'link:../design' },
    })
  )
  assert.deepEqual(readDistribution(root).modules, {})
})
