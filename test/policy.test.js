import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findPolicy, setupTurbo, turboTasks, usePolicy } from '../dist/policy.js'

const write = (root, files) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

/**
 * A distribution with an organization's policy, two modules with their own,
 * one without, a parent it extends, and a stand-in fg-policy that records
 * what it was asked.
 */
const distribution = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dist-policy-'))
  write(root, {
    'package.json': { name: '@acme/core', version: '2026.10.01', distribution: { extends: '@fair/core' } },
    'turbo.json': { tasks: { build: { dependsOn: ['^build'], outputs: ['.next/**'] } } },
    'policies/.manifest': { metadata: { organization: 'Acme' } },
    'policies/package.json': { name: '@acme/core-policies', private: true },
    'policies/acme/id.rego': 'package fairgarden.id',
    'apps/id/package.json': {
      name: '@acme/id',
      scripts: { build: 'fg-dist policy use && next build', dev: 'fg-dist policy use && next dev' },
    },
    'apps/id/policies/id.rego': 'package fairgarden.id',
    'apps/members/package.json': { name: '@acme/members', scripts: { build: 'next build' } },
    'apps/members/policies/members.rego': 'package fairgarden.members',
    'apps/web/package.json': { name: '@acme/web', scripts: { build: 'next build' } },
    'node_modules/@fair/core/package.json': { name: '@fair/core', version: '2026.09.01' },
    'node_modules/@fair/core/policies/.manifest': { metadata: { organization: 'Fair' } },
    'node_modules/@fairgarden/policy/package.json': { name: '@fairgarden/policy', type: 'module', bin: { 'fg-policy': 'cli.js' } },
    'node_modules/@fairgarden/policy/cli.js': `
      import { mkdirSync, writeFileSync } from 'node:fs'
      import path from 'node:path'
      const args = process.argv.slice(2)
      const out = args[args.indexOf('--out') + 1]
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify({ cwd: process.cwd(), args }))
    `,
  })
  return root
}

test('a policy is found from anywhere in its distribution, and nowhere else', () => {
  const root = distribution()
  for (const from of [root, path.join(root, 'apps/id'), path.join(root, 'policies')]) {
    assert.equal(findPolicy(from)?.root, root)
  }
  assert.equal(findPolicy(mkdtempSync(path.join(tmpdir(), 'not-a-distribution-'))), undefined)
})

test("it is built on every module's own rules, and on what it extends", () => {
  const root = distribution()
  const policy = findPolicy(path.join(root, 'apps/id'))
  assert.deepEqual(policy.bases, [path.join(root, 'apps/id/policies'), path.join(root, 'apps/members/policies')])
  assert.deepEqual(policy.parents, [path.join(root, 'node_modules/@fair/core/policies')])
  assert.equal(policy.version, '2026.10.01')
})

test('a service takes a copy to run, built when there is none or it is out of date', () => {
  const root = distribution()
  const project = path.join(root, 'apps/id')
  const used = () => readFileSync(path.join(project, '.policy/policies.tar.gz'), 'utf8')
  const { status } = usePolicy(project)
  assert.equal(status, 0)
  const built = JSON.parse(used())
  assert.equal(built.cwd, root)
  assert.deepEqual(built.args, [
    'build',
    '--dir', 'policies',
    '--base', 'apps/id/policies',
    '--base', 'apps/members/policies',
    '--parent', 'node_modules/@fair/core/policies',
    '--release', '2026.10.01',
    '--out', path.join(root, 'policies/dist/policies.tar.gz'),
  ])

  // Built from the rules as they are — by turbo, say: copied as it is.
  const bundle = path.join(root, 'policies/dist/policies.tar.gz')
  writeFileSync(bundle, 'built by turbo')
  usePolicy(project)
  assert.equal(used(), 'built by turbo')

  // A rule changed since: built again.
  writeFileSync(path.join(root, 'apps/members/policies/members.rego'), 'package fairgarden.members\n# changed')
  usePolicy(project)
  assert.notEqual(used(), 'built by turbo')

  // And a rule deleted, which leaves nothing newer behind to notice.
  writeFileSync(bundle, 'built by turbo')
  usePolicy(project)
  assert.equal(used(), 'built by turbo')
  rmSync(path.join(root, 'policies/acme/id.rego'))
  usePolicy(project)
  assert.notEqual(used(), 'built by turbo')
})

test('a service that leaves a distribution runs no copy from before', () => {
  const root = distribution()
  const project = path.join(root, 'apps/id')
  usePolicy(project)
  rmSync(path.join(root, 'policies/.manifest'))
  assert.deepEqual(usePolicy(project), { status: 0 })
  assert.equal(existsSync(path.join(project, '.policy/policies.tar.gz')), false)
})

test('outside a distribution, a service is left to its built-in rules', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'alone-'))
  assert.deepEqual(usePolicy(project), { status: 0 })
  assert.equal(existsSync(path.join(project, '.policy')), false)
})

test('turbo builds it once, before each service whose build uses it', () => {
  const root = distribution()
  const policy = findPolicy(root)
  const tasks = turboTasks(policy, { dependsOn: ['^build'], outputs: ['.next/**'] })
  assert.deepEqual(Object.keys(tasks), [
    '@acme/core-policies#build',
    '@acme/core-policies#test',
    '@acme/id#build',
    '@acme/id#dev',
  ])
  assert.deepEqual(tasks['@acme/id#build'], {
    dependsOn: ['^build', '@acme/core-policies#build'],
    outputs: ['.next/**', '.policy/**'],
  })
  const build = tasks['@acme/core-policies#build']
  assert.ok(build.inputs.includes('$TURBO_ROOT$/apps/*/policies/**'))
  // The version names each revision, and the parent comes from the lockfile.
  assert.ok(build.inputs.includes('$TURBO_ROOT$/package.json'))
  assert.ok(build.inputs.includes('$TURBO_ROOT$/pnpm-lock.yaml'))
  assert.deepEqual(build.env, ['FG_POLICY_SIGNING_KEY'])
  // A fresh checkout builds the policy before serving anything that runs it.
  assert.deepEqual(tasks['@acme/id#dev'], { persistent: true, cache: false, dependsOn: ['@acme/core-policies#build'] })

  assert.deepEqual(setupTurbo(policy, { check: true }), Object.keys(tasks))
  setupTurbo(policy)
  assert.deepEqual(setupTurbo(policy, { check: true }), [])
  const turbo = JSON.parse(readFileSync(path.join(root, 'turbo.json'), 'utf8'))
  assert.deepEqual(turbo.tasks.build, { dependsOn: ['^build'], outputs: ['.next/**'] })
})
