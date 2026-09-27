import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { deploymentAt, envApp, missing, requirementsFor } from '../dist/env.js'

process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' })

/** An identity service, and an app that signs in with it — as id and members are. */
const ID = {
  name: '@acme/id',
  fairgarden: {
    migrations: { directory: 'drizzle', table: 'aid_migrations', lock: 1, database: ['ACME_ID_DATABASE_URL', 'DATABASE_URL'] },
    env: {
      ACME_ID_SMTP_URL: {
        description: 'Sends sign-in codes.',
        required: 'deployed',
        sensitive: true,
        example: 'smtps://user:password@smtp.example.com:465',
        unless: ['ACME_ID_MOCK_EMAIL'],
      },
    },
  },
}
const MEMBERS = {
  name: '@acme/members',
  fairgarden: {
    idClient: { clientId: 'members', name: 'Members', claims: 'membership' },
    env: {
      ACME_MEMBERS_SECRET: { description: 'Encrypts sessions.', required: 'deployed', generate: 'secret', rotate: true },
      ACME_MEMBERS_ID_URL: { description: 'The issuer.', required: 'deployed', unlessMounted: '@acme/id' },
      ACME_MEMBERS_CLIENT_SECRET: {
        description: 'Signs in to id.',
        required: 'deployed',
        generate: 'secret',
        rotate: true,
        sameAs: 'ACME_ID_SERVICE_MEMBERS_SECRET',
        unlessMounted: '@acme/id',
      },
      ACME_ID_SERVICE_MEMBERS_SECRET: {
        description: 'What id knows members by.',
        deployment: '@acme/id',
        required: 'deployed',
        generate: 'secret',
        rotate: true,
        verifies: true,
      },
      ACME_ID_SERVICE_MEMBERS_CLAIMS: {
        description: 'What members answers for.',
        deployment: '@acme/id',
        required: 'deployed',
        value: 'membership',
        unlessMounted: '@acme/id',
      },
    },
  },
}

/** An app checked out as a submodule would be: a repository of its own. */
const checkout = (dir, manifest) => {
  mkdirSync(dir, { recursive: true })
  json(path.join(dir, 'package.json'), manifest)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
}

/** A distribution shipping id and members, deployed as a monolith or as two projects. */
const distribution = ({ monolith }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'env-'))
  checkout(path.join(root, 'apps', 'id'), ID)
  checkout(path.join(root, 'apps', 'members'), MEMBERS)
  writeFileSync(
    path.join(root, '.gitmodules'),
    ['id', 'members'].map((app) => `[submodule "apps/${app}"]\n\tpath = apps/${app}\n\turl = https://example.invalid/${app}.git\n`).join('')
  )
  const projects = monolith ? { 'apps/monolith': 'acme-core' } : { 'apps/id': 'acme-id', 'apps/members': 'acme-members' }
  json(path.join(root, 'package.json'), { name: '@acme/core', distribution: { vercel: { projects } } })
  if (monolith) {
    const dir = path.join(root, 'apps', 'monolith')
    mkdirSync(path.join(dir, 'node_modules', '@acme'), { recursive: true })
    json(path.join(dir, 'package.json'), { name: '@acme/core-monolith', dependencies: { '@acme/id': '*', '@acme/members': '*' } })
    for (const app of ['id', 'members']) symlinkSync(path.join(root, 'apps', app), path.join(dir, 'node_modules', '@acme', app), 'dir')
  }
  return root
}

/**
 * A stand-in for the Vercel CLI: projects' variables in a JSON file, and every
 * call it was given in a log.
 */
const fakeVercel = (projects = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vercel-'))
  const state = path.join(dir, 'state.json')
  json(state, { projects, log: [] })
  const bin = path.join(dir, 'vercel')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'))
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const stdin = () => { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }
state.log.push(args.filter((arg) => !arg.startsWith('--')).join(' '))
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state, null, 2))
const project = () => (state.projects[flag('--project')] ??= {})
const [command, sub, name, environment] = args
if (command === 'env' && sub === 'list') {
  const envs = Object.entries(project()).flatMap(([key, targets]) =>
    targets[name] ? [{ key, value: targets[name].sensitive ? undefined : targets[name].value, type: targets[name].sensitive ? 'sensitive' : 'encrypted', target: [name] }] : [])
  process.stdout.write(JSON.stringify({ envs }))
} else if (command === 'env' && (sub === 'add' || sub === 'update')) {
  const variable = (project()[name] ??= {})
  if (sub === 'add' && variable[environment]) { process.stderr.write('exists'); process.exit(1) }
  variable[environment] = { value: stdin(), sensitive: sub === 'add' ? args.includes('--sensitive') : variable[environment].sensitive }
} else if (command === 'api') {
  const id = decodeURIComponent(sub.split('/').pop())
  process.stdout.write(JSON.stringify({ targets: { production: { id: 'dpl_' + id } } }))
} else if (command === 'redeploy') {
  process.stdout.write('https://' + sub + '.vercel.app')
} else { process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1) }
save()
`
  )
  chmodSync(bin, 0o755)
  return {
    bin,
    read: () => JSON.parse(readFileSync(state, 'utf8')),
    value: (project, key, environment = 'production') => JSON.parse(readFileSync(state, 'utf8')).projects[project]?.[key]?.[environment],
  }
}

const fgDist = async (cwd, args, env) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

describe('what a deployment needs', () => {
  test("a monolith needs what its apps do, less what they work out from being mounted together", () => {
    const root = distribution({ monolith: true })
    const needed = requirementsFor(deploymentAt(path.join(root, 'apps', 'monolith')), 'production')
    assert.deepEqual(
      needed.map((requirement) => requirement.variable),
      ['ACME_ID_SMTP_URL', 'ACME_MEMBERS_SECRET', 'ACME_ID_SERVICE_MEMBERS_SECRET', 'ACME_ID_DATABASE_URL']
    )
  })

  test('apart, each needs its own, and id what members says id needs to know about it', () => {
    const root = distribution({ monolith: false })
    const id = envApp(path.join(root, 'apps', 'id'))
    const members = envApp(path.join(root, 'apps', 'members'))
    const alone = (app, peer) => requirementsFor({ name: app.name, root: app.root, apps: [app] }, 'production', [peer])
    assert.deepEqual(alone(id, members).map((each) => each.variable), [
      'ACME_ID_SMTP_URL',
      'ACME_ID_SERVICE_MEMBERS_SECRET',
      'ACME_ID_SERVICE_MEMBERS_CLAIMS',
      'ACME_ID_DATABASE_URL',
    ])
    assert.deepEqual(alone(members, id).map((each) => each.variable), [
      'ACME_MEMBERS_SECRET',
      'ACME_MEMBERS_ID_URL',
      'ACME_MEMBERS_CLIENT_SECRET',
    ])
  })

  test('is met by any of its variables, or excused by what it is not needed alongside', () => {
    const root = distribution({ monolith: true })
    const needed = requirementsFor(deploymentAt(path.join(root, 'apps', 'monolith')), 'production')
    const absent = missing(needed, { DATABASE_URL: 'postgres://', ACME_ID_MOCK_EMAIL: 'true', ACME_MEMBERS_SECRET: 'x' })
    assert.deepEqual(absent.map((requirement) => requirement.variable), ['ACME_ID_SERVICE_MEMBERS_SECRET'])
  })
})

describe('the build', () => {
  test('refuses to deploy without what the apps need, and says exactly what to add', async () => {
    const root = distribution({ monolith: true })
    const result = await fgDist(path.join(root, 'apps', 'monolith'), ['env', 'check', '--build'], {
      VERCEL: '1',
      VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://db',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /@acme\/core-monolith is missing what a production deployment needs/)
    assert.match(result.stderr, /ACME_ID_SMTP_URL {2}\(@acme\/id\)\n {4}Sends sign-in codes\.\n {4}For example smtps:/)
    assert.match(result.stderr, /ACME_MEMBERS_SECRET {2}\(@acme\/members\)[\s\S]*pnpm dist env setup` makes one/)
    assert.doesNotMatch(result.stderr, /ACME_MEMBERS_ID_URL|DATABASE_URL {2}/)
  })

  test('deploys once it has them, and checks nothing where nothing is deployed', async () => {
    const root = distribution({ monolith: true })
    const env = {
      VERCEL: '1',
      VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://db',
      ACME_ID_SMTP_URL: 'smtps://mail',
      ACME_MEMBERS_SECRET: 'a',
      ACME_ID_SERVICE_MEMBERS_SECRET: 'b',
    }
    const monolith = path.join(root, 'apps', 'monolith')
    assert.equal((await fgDist(monolith, ['env', 'check', '--build'], env)).status, 0)
    const local = await fgDist(monolith, ['env', 'check', '--build'], {})
    assert.equal(local.status, 0)
    assert.match(local.stdout, /not a Vercel build/)
  })
})

describe('setting up Vercel', () => {
  test('generates the secrets, sets fixed values, and says what it cannot know', async () => {
    const root = distribution({ monolith: false })
    const vercel = fakeVercel()
    const result = await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    assert.equal(result.status, 1, result.stderr)

    // one value, set alike in both projects: members signs in with what id checks
    const shared = vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET')
    assert.ok(shared.value.length >= 40)
    assert.equal(vercel.value('acme-members', 'ACME_MEMBERS_CLIENT_SECRET').value, shared.value)
    // rotated secrets stay readable, so rotating can keep the one before
    assert.equal(shared.sensitive, false)
    assert.equal(vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_CLAIMS').value, 'membership')

    assert.match(result.stderr, /acme-id {2}ACME_ID_SMTP_URL: nothing to set it to/)
    assert.match(result.stderr, /acme-id {2}ACME_ID_DATABASE_URL: connect Neon/)
    assert.match(result.stderr, /acme-members {2}ACME_MEMBERS_ID_URL: nothing to set it to/)
  })

  test('matches a shared secret one side already has', async () => {
    const root = distribution({ monolith: false })
    const vercel = fakeVercel({ 'acme-id': { ACME_ID_SERVICE_MEMBERS_SECRET: { production: { value: 'existing', sensitive: false } } } })
    await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    assert.equal(vercel.value('acme-members', 'ACME_MEMBERS_CLIENT_SECRET').value, 'existing')
  })
})

describe('rotating', () => {
  const setUp = async (monolith) => {
    const root = distribution({ monolith })
    const vercel = fakeVercel()
    await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    vercel.before = vercel.read()
    return { root, vercel }
  }

  test('checks before it sends: id takes the new secret before members sends it', async () => {
    const { root, vercel } = await setUp(false)
    const old = vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET').value
    const result = await fgDist(root, ['env', 'rotate', '--yes'], { VERCEL_CLI: vercel.bin })
    assert.equal(result.status, 0, result.stderr)

    const [fresh, kept] = vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET').value.split(' ')
    assert.equal(kept, old)
    assert.equal(vercel.value('acme-members', 'ACME_MEMBERS_CLIENT_SECRET').value.split(' ')[0], fresh)

    const log = vercel.read().log.slice(vercel.before.log.length)
    const step = (entry) => {
      const at = log.findIndex((line) => line.startsWith(entry))
      assert.notEqual(at, -1, `${entry} never happened: ${log.join(' | ')}`)
      return at
    }
    // what checks it is redeployed with both before anything sends the new one
    assert.ok(step('env update ACME_ID_SERVICE_MEMBERS_SECRET') < step('redeploy dpl_acme-id'))
    assert.ok(step('redeploy dpl_acme-id') < step('env update ACME_MEMBERS_CLIENT_SECRET'))
    assert.ok(step('env update ACME_MEMBERS_CLIENT_SECRET') < log.lastIndexOf('redeploy dpl_acme-members production'))
    // members' own session key waits for its client secret: one redeploy for both
    assert.equal(log.filter((line) => line.startsWith('redeploy dpl_acme-members')).length, 1)
    assert.ok(step('env update ACME_MEMBERS_SECRET') > step('redeploy dpl_acme-id'))
  })

  test('keeps one value before the new one, and drops the rest', async () => {
    const { root, vercel } = await setUp(true)
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy'], { VERCEL_CLI: vercel.bin })
    const second = vercel.value('acme-core', 'ACME_MEMBERS_SECRET').value.split(' ')
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy'], { VERCEL_CLI: vercel.bin })
    const third = vercel.value('acme-core', 'ACME_MEMBERS_SECRET').value.split(' ')
    assert.equal(third.length, 2)
    assert.equal(third[1], second[0])
  })

  test('asks first, and without anyone to ask, does nothing', async () => {
    const { root, vercel } = await setUp(true)
    const result = await fgDist(root, ['env', 'rotate'], { VERCEL_CLI: vercel.bin })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /Pass --yes/)
    assert.deepEqual(vercel.read().projects, vercel.before.projects)
  })
})
