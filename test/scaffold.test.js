import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  monolithRepo,
  moduleRepo,
  distributionRepo,
  write,
  isEmpty,
} from '../dist/scaffold.js'
import { nameFromUrl, findMonolith } from '../dist/add-module.js'

const scaffold = async (files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'scaffold-'))
  await write(root, files)
  return root
}

const readJson = (root, file) =>
  JSON.parse(readFileSync(path.join(root, file), 'utf8'))

test('a monolith repo has a workspace, a turbo config and a monolith app', async () => {
  const root = await scaffold(monolithRepo('acme'))

  const workspace = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /apps\/\*/)
  assert.match(workspace, /packages\/\*\/docs/)

  const app = readJson(root, 'apps/monolith/package.json')
  assert.equal(app.name, 'acme-monolith')
  assert.ok(app.dependencies['@fairgarden/monolith'])

  const config = readFileSync(path.join(root, 'apps/monolith/next.config.ts'), 'utf8')
  assert.match(config, /withMonolith\(/)
})

test('a repo keeps the workspace protocol, so no version is written back in', () => {
  // Modules are pinned by their submodule commit, and versioned by the
  // package.json inside that checkout. A version here would be a stale copy.
  for (const files of [monolithRepo('acme'), distributionRepo('@acme/core')]) {
    assert.match(files['.npmrc'], /link-workspace-packages=true/)
    assert.match(files['.npmrc'], /save-workspace-protocol=true/)
  }
})

test('a monolith repo ignores the derived mount trees', async () => {
  const root = await scaffold(monolithRepo('acme'))
  const ignore = readFileSync(path.join(root, 'apps/monolith/.gitignore'), 'utf8')
  assert.match(ignore, /^\/app\/$/m)
  assert.match(ignore, /^\/pages\/$/m)
})

test('a module repo wires up portability, lint and a portable Link', async () => {
  const root = await scaffold(moduleRepo('@acme/widget'))

  assert.match(
    readFileSync(path.join(root, 'next.config.ts'), 'utf8'),
    /withMonolithicPortability/
  )
  assert.match(
    readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8'),
    /monolith\.configs\.recommended/
  )

  const link = readFileSync(path.join(root, 'lib/link.ts'), 'utf8')
  assert.match(link, /createLink\('@acme\/widget'\)/)
  assert.match(link, /createHref\('@acme\/widget'\)/)
})

test('a module can import itself by package name', async () => {
  const root = await scaffold(moduleRepo('@acme/widget'))
  const tsconfig = readJson(root, 'tsconfig.json')
  assert.deepEqual(tsconfig.compilerOptions.paths, { '@acme/widget/*': ['./*'] })
  // which is what the generated page relies on
  assert.match(
    readFileSync(path.join(root, 'app/page.tsx'), 'utf8'),
    /from '@acme\/widget\/lib\/link'/
  )
})

test('every scaffolded package.json is valid JSON', async () => {
  for (const files of [monolithRepo('acme'), moduleRepo('@acme/widget')]) {
    for (const [name, contents] of Object.entries(files)) {
      if (name.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(contents))
    }
  }
})

test('an empty directory is empty, and a git-only one still counts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'empty-'))
  assert.equal(await isEmpty(root), true)
  mkdirSync(path.join(root, '.git'))
  assert.equal(await isEmpty(root), true)
  writeFileSync(path.join(root, 'README.md'), '')
  assert.equal(await isEmpty(root), false)
})

test('reads a repository name out of any url shape', () => {
  assert.equal(nameFromUrl('git@github.com:fairgarden/id.git'), 'id')
  assert.equal(nameFromUrl('https://github.com/fairgarden/id.git'), 'id')
  assert.equal(nameFromUrl('https://github.com/fairgarden/id'), 'id')
  assert.equal(nameFromUrl('../relative/widget'), 'widget')
})

test('finds the app that composes modules, wherever it lives', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'find-'))
  mkdirSync(path.join(root, 'apps/site'), { recursive: true })
  mkdirSync(path.join(root, 'apps/widget'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))

  // A module depends on the package too, for portability and links, so the
  // dependency cannot be what identifies the composing app.
  writeFileSync(
    path.join(root, 'apps/widget/package.json'),
    JSON.stringify({
      name: '@acme/widget',
      devDependencies: { '@fairgarden/monolith': '^0.1.0' },
    })
  )
  writeFileSync(
    path.join(root, 'apps/widget/next.config.ts'),
    `import { withMonolithicPortability } from '@fairgarden/monolith'\nexport default withMonolithicPortability({})\n`
  )

  writeFileSync(
    path.join(root, 'apps/site/package.json'),
    JSON.stringify({ name: 'site' })
  )
  writeFileSync(
    path.join(root, 'apps/site/next.config.ts'),
    `import { withMonolith } from '@fairgarden/monolith'\nexport default withMonolith({}, {})\n`
  )

  assert.equal(await findMonolith(root, root), path.join(root, 'apps/site'))
})

test('returns nothing when no app composes modules', async () => {
  // which is a distribution whose apps are each deployed on their own
  const root = mkdtempSync(path.join(tmpdir(), 'none-'))
  mkdirSync(path.join(root, 'apps/widget'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  writeFileSync(
    path.join(root, 'apps/widget/package.json'),
    JSON.stringify({
      name: '@acme/widget',
      devDependencies: { '@fairgarden/monolith': '^0.1.0' },
    })
  )
  assert.equal(await findMonolith(root, root), undefined)
})

test('records where a scaffolded repository will live', async () => {
  const root = await scaffold(moduleRepo('@acme/widget', 'https://github.com/acme/widget.git'))
  assert.deepEqual(readJson(root, 'package.json').repository, {
    type: 'git',
    url: 'https://github.com/acme/widget.git',
  })
})

test('leaves out the repository field when no remote is known', async () => {
  const root = await scaffold(moduleRepo('@acme/widget'))
  assert.equal(readJson(root, 'package.json').repository, undefined)
})

test('records the remote on a monolith too', async () => {
  const root = await scaffold(monolithRepo('acme', 'https://github.com/acme/acme.git'))
  assert.equal(readJson(root, 'package.json').repository.url, 'https://github.com/acme/acme.git')
})

test('a distribution ships a monolith app by default', async () => {
  const root = await scaffold(distributionRepo('@acme/core'))
  assert.doesNotThrow(() => readJson(root, 'apps/monolith/package.json'))
  assert.match(readFileSync(path.join(root, 'Readme.md'), 'utf8'), /deploys as one Next app/)
})

test('a distribution can have no monolith, for apps deployed separately', async () => {
  const root = await scaffold(distributionRepo('@acme/enterprise', undefined, undefined, { monolith: false }))
  assert.throws(() => readJson(root, 'apps/monolith/package.json'))
  // it is still a workspace, so modules land under apps/ as submodules
  assert.match(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), /apps\/\*/)
  assert.match(readFileSync(path.join(root, 'Readme.md'), 'utf8'), /deployed on its own/)
})

test('a distribution is versioned by date, not semver', async () => {
  const root = await scaffold(distributionRepo('@acme/core'))
  assert.match(readJson(root, 'package.json').version, /^\d{4}\.\d{2}\.\d{2}$/)
})

test('a distribution records what it extends', async () => {
  const root = await scaffold(distributionRepo('@acme/core', undefined, '@fg/core'))
  const pkg = readJson(root, 'package.json')
  assert.equal(pkg.distribution.extends, '@fg/core')
  assert.ok(pkg.dependencies['@fg/core'])
})

test("a distribution has a place for the organization's policy, built once by turbo", async () => {
  for (const monolith of [true, false]) {
    const root = await scaffold(distributionRepo('@acme/core', 'https://github.com/acme/core.git', undefined, { monolith }))
    assert.match(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), /- "policies"/)
    assert.deepEqual(readJson(root, 'policies/.manifest'), {
      metadata: { organization: '@acme/core', source: 'https://github.com/acme/core' },
    })
    const policies = readJson(root, 'policies/package.json')
    assert.equal(policies.name, '@acme/core-policies')
    assert.equal(policies.scripts.build, 'fg-dist policy build')
    assert.ok(policies.devDependencies['@fairgarden/policy'])
  }
  const root = await scaffold(distributionRepo('@acme/core'))
  assert.match(readJson(root, 'apps/monolith/package.json').scripts.build, /^fg-dist policy use && next build$/)
})
