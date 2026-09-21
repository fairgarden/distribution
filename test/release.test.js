import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  planRelease,
  planPrerelease,
  setVersion,
  readRelease,
  release,
  startPrerelease,
} from '../dist/release.js'
import {
  publishWorkflow,
  writeWorkflows,
  updateManifest,
  releaseScripts,
} from '../dist/workflows.js'
import { nextCanary, stampCanary } from '../dist/canary.js'
import { checkReleasable } from '../dist/release.js'
import { releasingSection } from '../dist/readme.js'
import { moduleRepo } from '../dist/scaffold.js'

// `release` commits, and it must sign when the user has configured signing —
// correct for a real release, and wrong for a test run, which would wake the
// GPG agent. These reach the git processes it spawns, unlike a `-c` flag on
// this file's own helper.
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
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

/** A module repository sitting on a version, optionally tagged as released. */
const module_ = ({ version = '1.6.0', tag = true, name = '@acme/widget' } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-'))
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name, version, main: 'index.js' }, null, 2)}\n`
  )
  writeFileSync(path.join(root, 'Readme.md'), `# ${name}\n`)
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'init'])
  if (tag) git(root, ['tag', `v${version}`])
  return root
}

const versionOf = (root) => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

test('a release opens the next minor on main and a maintenance branch behind it', () => {
  const plan = planRelease('1.6.0', { bump: 'minor' })
  assert.equal(plan.next.version, '1.7.0')
  assert.equal(plan.next.branch, 'release/v1.7.0')
  assert.equal(plan.maintenance.branch, 'v1-6')
  assert.equal(plan.maintenance.version, '1.6.1')
})

test('a patch release stays on its line instead of branching behind it', () => {
  // 1.6.1 released from v1-6, taking the next patch: that branch *is* the
  // 1.6.x line, so nothing needs to stay behind for it.
  const plan = planRelease('1.6.1', { bump: 'patch' })
  assert.equal(plan.maintenance, undefined)
  assert.equal(plan.next.version, '1.6.2')
})

test('a minor from a maintenance branch does leave one behind', () => {
  const plan = planRelease('1.6.1', { bump: 'minor' })
  assert.equal(plan.maintenance.branch, 'v1-6')
  assert.equal(plan.maintenance.version, '1.6.2')
})

test('which way main moves on is asked for, not guessed', () => {
  assert.throws(() => planRelease('1.6.0'), /--patch, --minor or --major/)
  // A prerelease has only one way to go, so it does not have to be told.
  assert.equal(planRelease('2.0.0-alpha.0').next.version, '2.0.0-alpha.1')
})

test('--major takes the next major rather than the next minor', () => {
  assert.equal(planRelease('1.6.0', { bump: 'major' }).next.version, '2.0.0')
  assert.equal(planRelease('1.6.0', { bump: 'major' }).maintenance.branch, 'v1-6')
})

test('a prerelease has no line to maintain', () => {
  const plan = planRelease('0.1.0-alpha.0')
  assert.equal(plan.maintenance, undefined)
  assert.equal(plan.next.version, '0.1.0-alpha.1')
})

test('a prerelease can move on to the next identifier', () => {
  assert.equal(planRelease('2.0.0-alpha.3', { id: 'beta' }).next.version, '2.0.0-beta.0')
  // Already on that identifier, so it just counts up.
  assert.equal(planRelease('2.0.0-beta.0', { id: 'beta' }).next.version, '2.0.0-beta.1')
})

test('an unreleasable version is refused rather than guessed at', () => {
  assert.throws(() => planRelease('latest', { bump: 'minor' }), /not a version/)
})

test('setting the version leaves the rest of the manifest alone', () => {
  const source = '{\n  "name": "@acme/widget",\n  "version": "1.6.0",\n  "main": "index.js"\n}\n'
  const updated = setVersion(source, '1.7.0')
  assert.equal(
    updated,
    '{\n  "name": "@acme/widget",\n  "version": "1.7.0",\n  "main": "index.js"\n}\n'
  )
})

test('the maintenance branch is cut from the release tag, not from main', async () => {
  const root = module_()
  // Main moves on after the release, the way it does while a release is being
  // dispatched. Those commits are not part of 1.6.x.
  writeFileSync(path.join(root, 'after.txt'), 'work that came later\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'later'])

  const outcome = await release(root, { bump: 'minor', push: false })

  assert.equal(outcome.plan.tagged, true)
  assert.equal(outcome.plan.base, 'v1.6.0')
  assert.deepEqual(outcome.created, ['v1-6', 'release/v1.7.0'])

  assert.equal(
    git(root, ['show', 'v1-6:package.json']).includes('"version": "1.6.1"'),
    true
  )
  // Cut from the tag, so the later commit is not on it.
  assert.equal(existsSync(path.join(root, 'after.txt')), true)
  assert.throws(() => git(root, ['cat-file', '-e', 'v1-6:after.txt']))
  assert.equal(git(root, ['cat-file', '-t', 'release/v1.7.0:after.txt']), 'blob')
})

test('a release leaves you where you started, on the version main now carries', async () => {
  const root = module_()
  await release(root, { bump: 'minor', push: false })

  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
  // main itself is untouched: the bump is on a branch, for review.
  assert.equal(versionOf(root), '1.6.0')
  assert.equal(git(root, ['show', 'release/v1.7.0:package.json']).includes('"version": "1.7.0"'), true)
})

test('both branches record their version in the readme', async () => {
  const root = module_()
  await release(root, { bump: 'minor', push: false })

  assert.match(git(root, ['show', 'v1-6:Readme.md']), /Version \*\*1\.6\.1\*\*/)
  assert.match(git(root, ['show', 'release/v1.7.0:Readme.md']), /Version \*\*1\.7\.0\*\*/)
})

test('an untagged release still works, and says the tag was missing', async () => {
  const root = module_({ tag: false })
  const outcome = await release(root, { bump: 'minor', push: false })

  assert.equal(outcome.plan.tagged, false)
  assert.equal(outcome.plan.base, 'HEAD')
  assert.equal(git(root, ['show', 'v1-6:package.json']).includes('"version": "1.6.1"'), true)
})

test('a dirty tree is refused, so nothing uncommitted is swept into a release', async () => {
  const root = module_()
  writeFileSync(path.join(root, 'scratch.txt'), 'not ready\n')

  await assert.rejects(() => release(root, { bump: 'minor', push: false }), /uncommitted changes/)
  assert.deepEqual(git(root, ['branch', '--format=%(refname:short)']).split('\n'), ['main'])
})

test('an existing branch is refused rather than moved', async () => {
  const root = module_()
  git(root, ['branch', 'v1-6'])

  await assert.rejects(() => release(root, { bump: 'minor', push: false }), /v1-6.*already exists/)
})

test('a dry run reports the plan and writes nothing', async () => {
  const root = module_()
  const outcome = await release(root, { bump: 'minor', dryRun: true })

  assert.equal(outcome.created.length, 0)
  assert.deepEqual(git(root, ['branch', '--format=%(refname:short)']).split('\n'), ['main'])
  assert.equal(outcome.plan.next.version, '1.7.0')
})

test('reading a release changes nothing', async () => {
  const root = module_()
  const plan = await readRelease(root, { bump: 'minor' })

  assert.equal(plan.released, '1.6.0')
  assert.equal(git(root, ['status', '--porcelain']), '')
})

test('the publish workflow names the package it is trusted to publish', () => {
  const files = publishWorkflow('@acme/widget')
  const workflow = files['.github/workflows/publish.yml']

  assert.match(workflow, /@acme\/widget@\$\{\{ steps\.canary\.outputs\.version \}\}/)
  assert.match(workflow, /npm publish --tag canary --provenance/)
  // Trusted publishing over OIDC, so there is no token anywhere in the file.
  assert.equal(/NPM_TOKEN|NODE_AUTH_TOKEN/.test(workflow), false)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /^permissions: \{\}$/m)
  assert.ok(files['.github/actions/publish-prepare/action.yml'])
})

test('the workflow calls named scripts, not logic of its own', () => {
  const workflow = publishWorkflow('@acme/widget')['.github/workflows/publish.yml']

  assert.match(workflow, /run: pnpm run canary/)
  assert.match(workflow, /run: pnpm run release:check/)
  // The two files a module carries, and nothing else to keep in step.
  assert.deepEqual(Object.keys(publishWorkflow('@acme/widget')).sort(), [
    '.github/actions/publish-prepare/action.yml',
    '.github/workflows/publish.yml',
  ])
})

test('the tool cannot depend on itself being published to release itself', () => {
  assert.equal(releaseScripts('@acme/widget').canary, 'fg-dist canary')
  assert.equal(releaseScripts('@fairgarden/distribution').canary, 'node dist/cli.js canary')
})

test('a scaffolded module can publish itself', () => {
  const files = moduleRepo('@acme/widget', 'https://github.com/acme/widget.git')
  assert.ok(files['.github/workflows/publish.yml'])

  const manifest = JSON.parse(files['package.json'])
  // A module is installed as a package when a submodule cannot be reached, so
  // it cannot be private.
  assert.equal(manifest.private, undefined)
  assert.equal(manifest.publishConfig.access, 'restricted')
  assert.deepEqual(manifest.files, ['app', 'lib', 'pages', 'public', 'next.config.ts'])
})

/** A distribution with two modules as submodules. */
const distribution = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dist-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: '@acme/core', version: '2026.1.0', packageManager: 'pnpm@10.28.0' }, null, 2)}\n`
  )

  const lines = []
  for (const [at, name] of [['apps/widget', '@acme/widget'], ['packages/design', '@acme/design']]) {
    const full = path.join(root, at)
    mkdirSync(full, { recursive: true })
    writeFileSync(
      path.join(full, 'package.json'),
      `${JSON.stringify({ name, version: '1.0.0' }, null, 2)}\n`
    )
    // A real checkout: an uninitialised submodule is skipped, on purpose.
    git(full, ['init', '--quiet', '--initial-branch=main'])
    git(full, ['add', '-A'])
    git(full, ['commit', '-m', 'init'])
    lines.push(`[submodule "${at}"]\n\tpath = ${at}\n\turl = https://example.invalid/${name}.git\n`)
  }
  writeFileSync(path.join(root, '.gitmodules'), lines.join(''))
  return root
}

test('workflows gives every module one, named for its own package', async () => {
  const root = distribution()
  const updates = await writeWorkflows(root)

  assert.deepEqual(
    updates.map((update) => update.relativePath).sort(),
    ['apps/widget', 'packages/design']
  )
  assert.equal(updates.every((update) => !update.skipped), true)

  assert.match(
    readFileSync(path.join(root, 'apps/widget/.github/workflows/publish.yml'), 'utf8'),
    /@acme\/widget@\$\{\{ steps\.canary\.outputs\.version \}\}/
  )
  assert.match(
    readFileSync(path.join(root, 'packages/design/.github/workflows/publish.yml'), 'utf8'),
    /@acme\/design@\$\{\{ steps\.canary\.outputs\.version \}\}/
  )
})

test('a module is given the scripts the workflow calls, and the tool to run them', async () => {
  const root = distribution()
  const updates = await writeWorkflows(root)

  assert.equal(updates.every((update) => !update.skipped), true)
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps/widget/package.json'), 'utf8'))

  assert.equal(manifest.scripts.canary, 'fg-dist canary')
  assert.equal(manifest.scripts.release, 'fg-dist release')
  assert.equal(manifest.scripts['release:check'], 'fg-dist release --check')
  // Pinned to the CLI that set it up, not to a version written down somewhere.
  assert.match(manifest.devDependencies['@fairgarden/distribution'], /^\^\d/)
})

test('a stale copy of the old stamper is taken away with it', async () => {
  const root = distribution()
  const stale = path.join(root, 'apps/widget/scripts/stampCanaryVersion.mjs')
  mkdirSync(path.dirname(stale), { recursive: true })
  writeFileSync(stale, '// written by an earlier fg-dist\n')

  await writeWorkflows(root)
  assert.equal(existsSync(stale), false)
})

test('a script the module already defines is left alone', async () => {
  const root = distribution()
  const file = path.join(root, 'apps/widget/package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.scripts = { release: 'make release' }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)

  await writeWorkflows(root)
  const updated = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(updated.scripts.release, 'make release')
  assert.equal(updated.scripts.canary, 'fg-dist canary')
})

test('a workflow that is already there is left alone unless forced', async () => {
  const root = distribution()
  await writeWorkflows(root)

  const file = path.join(root, 'apps/widget/.github/workflows/publish.yml')
  writeFileSync(file, 'name: Publish\n# edited by hand\n')

  const second = await writeWorkflows(root)
  assert.equal(second.every((update) => update.skipped), true)
  assert.match(readFileSync(file, 'utf8'), /edited by hand/)

  await writeWorkflows(root, { force: true })
  assert.equal(/edited by hand/.test(readFileSync(file, 'utf8')), false)
})

test('a module is given the pnpm the distribution builds with', async () => {
  const root = distribution()
  const updates = await writeWorkflows(root)

  assert.equal(updates.every((update) => !update.skipped), true)
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'apps/widget/package.json'), 'utf8')
  )
  // pnpm/action-setup reads this, and refuses to run without it.
  assert.equal(manifest.packageManager, 'pnpm@10.28.0')
  assert.equal(manifest.name, '@acme/widget')
  assert.ok(updates[0].files.includes('package.json'))
})

test('a module that pins its own pnpm keeps it', async () => {
  const root = module_({ tag: false })
  const file = path.join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.packageManager = 'pnpm@9.0.0'
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)

  await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).packageManager, 'pnpm@9.0.0')
})

test('a private module cannot publish, so private comes off', async () => {
  const root = module_({ tag: false })
  const file = path.join(root, 'package.json')
  writeFileSync(
    file,
    `${JSON.stringify({ name: '@acme/widget', version: '1.0.0', private: true }, null, 2)}\n`
  )

  const change = await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))

  assert.equal(change.unprivated, true)
  assert.equal(manifest.private, undefined)
  // Not guessed at: npm takes an explicit access value as an instruction to
  // change an existing package's visibility, so writing one could make a
  // public package private on its next publish.
  assert.equal(manifest.publishConfig, undefined)
  assert.equal(change.missingAccess, true)
})

test('an access that is already set is left alone and not reported', async () => {
  const root = module_({ tag: false })
  const file = path.join(root, 'package.json')
  writeFileSync(
    file,
    `${JSON.stringify(
      { name: '@acme/widget', version: '1.0.0', publishConfig: { access: 'public' } },
      null,
      2
    )}\n`
  )

  const change = await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')
  assert.equal(change.missingAccess, false)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).publishConfig.access, 'public')
})

test('a manifest with no files list is reported, not guessed at', async () => {
  const root = module_({ tag: false })
  const change = await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')
  assert.equal(change.missingFiles, true)
})

test('every edit lands in one pass, so none of them undoes another', async () => {
  const root = module_({ tag: false })
  await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')

  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.packageManager, 'pnpm@10.28.0')
  assert.equal(manifest.scripts.canary, 'fg-dist canary')
  assert.equal(manifest.devDependencies['@fairgarden/distribution'], '^1.0.0')
  assert.equal(manifest.name, '@acme/widget')
})

test('nothing to change means the file is left alone', async () => {
  const root = module_({ tag: false })
  await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')
  const once = readFileSync(path.join(root, 'package.json'), 'utf8')

  const again = await updateManifest(root, '@acme/widget', '1.0.0', 'pnpm@10.28.0')
  assert.equal(again.changed, false)
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), once)
})

test('a prerelease branch starts the next line beside main', () => {
  const plan = planPrerelease('1.6.0', { bump: 'major' })

  assert.equal(plan.version, '2.0.0-alpha.0')
  // Named for the line it will become, not for the prerelease it starts as.
  assert.equal(plan.branch, 'v2')
  assert.equal(plan.from, '1.6.0')
})

test('a minor can be started early too, on the branch that minor would get', () => {
  const plan = planPrerelease('1.6.0', { bump: 'minor' })
  assert.equal(plan.version, '1.7.0-alpha.0')
  assert.equal(plan.branch, 'v1-7')
})

test('the prerelease identifier is the caller\'s to pick', () => {
  assert.equal(planPrerelease('1.6.0', { bump: 'major', id: 'rc' }).version, '2.0.0-rc.0')
})

test('a prerelease is not branched from a prerelease', () => {
  assert.throws(
    () => planPrerelease('2.0.0-alpha.0', { bump: 'major' }),
    /already a prerelease/
  )
})

test('starting a line leaves the branch you are on exactly as it was', async () => {
  const root = module_()
  const before = readFileSync(path.join(root, 'package.json'), 'utf8')

  const { plan } = await startPrerelease(root, { bump: 'major', push: false })

  assert.equal(plan.branch, 'v2')
  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before)
  assert.match(git(root, ['show', 'v2:package.json']), /2\.0\.0-alpha\.0/)
  assert.match(git(root, ['show', 'v2:Readme.md']), /Version \*\*2\.0\.0-alpha\.0\*\*/)
})

test('a line that has already been started is not started again', async () => {
  const root = module_()
  await startPrerelease(root, { bump: 'major', push: false })

  await assert.rejects(
    () => startPrerelease(root, { bump: 'major', push: false }),
    /has been started/
  )
})

test('a version written on one line is still found', () => {
  const source = '{"name":"@acme/widget","version":"1.6.0","main":"index.js"}'
  assert.equal(
    setVersion(source, '2.0.0-alpha.0'),
    '{"name":"@acme/widget","version":"2.0.0-alpha.0","main":"index.js"}'
  )
})

test('a dependency pinned to the same version is not mistaken for the field', () => {
  // The real field comes first in any manifest npm writes, but anchoring on
  // the parsed value is what makes that not matter.
  const source = '{"name":"@acme/id","version":"1.6.0","dependencies":{"@acme/design":"1.6.0"}}'
  const updated = setVersion(source, '1.7.0')
  assert.equal(JSON.parse(updated).version, '1.7.0')
  assert.equal(JSON.parse(updated).dependencies['@acme/design'], '1.6.0')
})

test('a beta never goes back to an alpha', () => {
  // Defaulting the identifier to `alpha` took 2.0.0-beta.2 to 2.0.0-alpha.0,
  // which is lower than what is already published.
  assert.equal(planRelease('2.0.0-beta.2').next.version, '2.0.0-beta.3')
  assert.equal(planRelease('2.0.0-rc.0').next.version, '2.0.0-rc.1')
  assert.throws(() => planRelease('2.0.0-beta.2', { id: 'alpha' }), /backwards/)
})

test('a failed push still leaves you where you started', async () => {
  const root = module_()
  // No origin, so the push fails the way an expired credential would.
  await assert.rejects(() => release(root, { bump: 'minor' }))

  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
})

test('a tag that is already here is refused before anything publishes', async () => {
  // `extract` tags the initial commit, so a first release would publish and
  // only then fail on `git tag` — after the irreversible half.
  const root = module_({ tag: true })

  await assert.rejects(
    () => checkReleasable(root, { published: () => undefined }),
    /v1\.6\.0 already exists/
  )
})

test('a distribution is not somewhere to start a line', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dist-pre-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(path.join(root, 'package.json'), '{"name":"@acme/core","version":"2026.1.0"}\n')
  writeFileSync(
    path.join(root, '.gitmodules'),
    '[submodule "apps/id"]\n\tpath = apps/id\n\turl = https://example.invalid/id.git\n'
  )

  await assert.rejects(
    () => startPrerelease(root, { bump: 'major', push: false }),
    /versioned by date/
  )
})

test('an uninitialised clone is still a distribution', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shallow-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(path.join(root, 'package.json'), '{"name":"@acme/core","version":"2026.1.0"}\n')
  // .gitmodules is committed; the checkouts are not there.
  writeFileSync(
    path.join(root, '.gitmodules'),
    '[submodule "apps/id"]\n\tpath = apps/id\n\turl = https://example.invalid/id.git\n'
  )

  const { writeReadmes } = await import('../dist/readme.js')
  // Not "this is a module, here is your version block" written over the
  // distribution's own readme.
  await assert.rejects(() => writeReadmes(root), /not checked out/)
})

test('a README.md is the file that gets edited, not a second one beside it', async () => {
  const root = module_({ tag: false })
  const { writeReadmes } = await import('../dist/readme.js')

  const shouty = path.join(root, 'README.md')
  writeFileSync(shouty, '# @acme/widget\n\nAlready written.\n')

  const { updates } = await writeReadmes(root)
  assert.deepEqual(
    updates.map((update) => path.basename(update.file)),
    ['README.md']
  )
  assert.match(readFileSync(shouty, 'utf8'), /Version \*\*1\.6\.0\*\*/)
})

test('a readme is reported once, not once per block', async () => {
  const root = module_({ tag: false })
  const { writeReadmes } = await import('../dist/readme.js')

  const { updates } = await writeReadmes(root)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].changed, true)
})

test('a canary of a prerelease sorts below every real prerelease of it', async () => {
  const semver = (await import('semver')).default
  const canary = nextCanary('0.1.0-alpha.1', '0.1.0-0.canary.2')

  // A numeric first identifier ranks below any named one, which is the only
  // slot in semver that is under the floor of every prerelease range.
  assert.equal(canary, '0.1.0-0.canary.3')
  for (const real of ['0.1.0-alpha.0', '0.1.0-alpha.1', '0.1.0-beta.0', '0.1.0-rc.0']) {
    assert.equal(semver.lt(canary, real), true, `${canary} should be below ${real}`)
  }
  assert.equal(semver.lt(canary, '0.1.0'), true)
})

test('a canary is never what a prerelease range resolves to', async () => {
  const semver = (await import('semver')).default
  const all = ['0.1.0-0.canary.3', '0.1.0-0.canary.4', '0.1.0-alpha.0', '0.1.0-alpha.1']

  for (const range of ['^0.1.0-alpha.0', '^0.1.0-alpha.1', '>=0.1.0-alpha.0 <0.2.0']) {
    assert.equal(semver.maxSatisfying(all, range), '0.1.0-alpha.1', range)
  }
})

test('a stable target takes the same shape as a prerelease one', async () => {
  const semver = (await import('semver')).default

  // `1.7.0-canary.3` would be below 1.7.0 but above 1.7.0-beta.2, because
  // `canary` beats `beta` as a string. One shape for every target means there
  // is no case where this is nearly right.
  assert.equal(nextCanary('1.7.0', undefined), '1.7.0-0.canary.0')
  assert.equal(nextCanary('1.0.0+build-1', undefined), '1.0.0-0.canary.0')
  assert.equal(
    semver.maxSatisfying(['2.0.0-beta.2', nextCanary('2.0.0', undefined)], '^2.0.0-beta.2'),
    '2.0.0-beta.2'
  )
})

test('the count carries across identifiers instead of restarting', () => {
  // The prefix ignores the prerelease, so alpha to beta to the release itself
  // is one run of canaries rather than three that collide at .0.
  assert.equal(nextCanary('2.0.0-beta.0', '2.0.0-0.canary.7'), '2.0.0-0.canary.8')
  assert.equal(nextCanary('2.0.0', '2.0.0-0.canary.7'), '2.0.0-0.canary.8')
})

test('canary --dry-run leaves the manifest alone', async () => {
  const root = module_({ tag: false })
  const file = path.join(root, 'package.json')
  const before = readFileSync(file, 'utf8')

  const result = await stampCanary(root, { sha: 'abc', published: {}, dryRun: true })
  assert.equal(result.version, '1.6.0-0.canary.0')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a failed commit does not carry staged edits back to main', async () => {
  const root = module_()
  // A hook that refuses, the way a missing identity or a lint hook would.
  const hook = path.join(root, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  await assert.rejects(() => release(root, { bump: 'minor', push: false }))

  git(root, ['checkout', 'main'])
  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(versionOf(root), '1.6.0')
})

test('provenance is claimed only where npm will generate it', async () => {
  const { isPublic } = await import('../dist/canary.js')

  assert.equal(isPublic({ name: '@acme/id', publishConfig: { access: 'restricted' } }), false)
  assert.equal(isPublic({ name: '@acme/id', publishConfig: { access: 'public' } }), true)
  assert.equal(isPublic({ name: '@acme/id', private: true }), false)
  // A scoped package is restricted unless it says otherwise.
  assert.equal(isPublic({ name: '@acme/id' }), false)
  assert.equal(isPublic({ name: 'widget' }), true)
})

test('the version field is found past a nested one that shadows it', () => {
  const source =
    '{\n  "volta": {\n    "version": "20.0.0"\n  },\n  "name": "x",\n  "version": "1.6.0"\n}\n'
  const updated = setVersion(source, '1.7.0')

  assert.equal(JSON.parse(updated).version, '1.7.0')
  assert.equal(JSON.parse(updated).volta.version, '20.0.0')
})

test('--dry-run writes nothing', async () => {
  const root = distribution()
  const before = readFileSync(path.join(root, 'apps/widget/package.json'), 'utf8')

  const updates = await writeWorkflows(root, { dryRun: true })
  assert.ok(updates.length > 0)
  assert.equal(existsSync(path.join(root, 'apps/widget/.github/workflows/publish.yml')), false)
  assert.equal(readFileSync(path.join(root, 'apps/widget/package.json'), 'utf8'), before)
})
