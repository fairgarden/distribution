import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { deploymentAt, envApp, missing, requirementsFor } from '../dist/env.js'
import { remotesOf } from '../dist/env-vercel.js'
import { secretValues } from '../dist/secrets.js'

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
/**
 * A stand-in for the Vercel CLI: projects' variables in a JSON file, and every
 * call it was given in a log. Like Vercel, it never shows a sensitive value, and
 * says when each variable was set; `policy: 'sensitive'` stores everything
 * sensitive, as a team policy does.
 */
const fakeVercel = (projects = {}, { policy } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vercel-'))
  const state = path.join(dir, 'state.json')
  json(state, { projects, policy, clock: 1, log: [] })
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
    targets[name] ? [{ key, value: targets[name].sensitive ? undefined : targets[name].value, type: targets[name].sensitive ? 'sensitive' : 'encrypted', target: [name], updatedAt: targets[name].updatedAt }] : [])
  process.stdout.write(JSON.stringify({ envs }))
} else if (command === 'env' && (sub === 'add' || sub === 'update')) {
  const variable = (project()[name] ??= {})
  if (sub === 'add' && variable[environment]) { process.stderr.write('exists'); process.exit(1) }
  if (sub === 'update' && !variable[environment]) { process.stderr.write('missing'); process.exit(1) }
  const forced = state.policy === 'sensitive' && environment !== 'development'
  // Like Vercel: an update keeps what it was unless told it is sensitive now.
  const sensitive = forced || args.includes('--sensitive') || (sub === 'update' && variable[environment].sensitive)
  variable[environment] = { value: stdin(), sensitive, updatedAt: state.clock++ }
} else if (command === 'env' && sub === 'remove') {
  delete project()[name]?.[environment]
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
  const read = () => JSON.parse(readFileSync(state, 'utf8'))
  return {
    bin,
    read,
    // What the test can see and the tool never can.
    value: (project, key, environment = 'production') => read().projects[project]?.[key]?.[environment],
    /** A secret's values as the app reads them, newest first. */
    secret: (project, name, environment = 'production') =>
      secretValues(
        name,
        Object.fromEntries(
          Object.entries(read().projects[project] ?? {}).flatMap(([key, targets]) =>
            targets[environment] ? [[key, targets[environment].value]] : []
          )
        )
      ),
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
  test('generates the secrets into their first slot, sensitive, and says what it cannot know', async () => {
    const root = distribution({ monolith: false })
    const vercel = fakeVercel()
    const result = await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    assert.equal(result.status, 1, result.stderr)

    const slot = vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET_A')
    assert.equal(slot.sensitive, true)
    assert.ok(slot.value.length >= 40)
    // the pointer is only a letter, and readable
    assert.deepEqual(vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET_CURRENT').value, 'A')
    // one value, set alike in both projects: members signs in with what id checks
    assert.deepEqual(vercel.secret('acme-members', 'ACME_MEMBERS_CLIENT_SECRET'), [slot.value])
    assert.equal(vercel.value('acme-members', 'ACME_MEMBERS_SECRET_A').sensitive, true)
    assert.equal(vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_CLAIMS').value, 'membership')

    assert.match(result.stderr, /acme-id {2}ACME_ID_SMTP_URL: nothing to set it to/)
    assert.match(result.stderr, /acme-id {2}ACME_ID_DATABASE_URL: connect Neon/)
    assert.match(result.stderr, /acme-members {2}ACME_MEMBERS_ID_URL: nothing to set it to/)
  })

  test('takes a slot nothing points at for no secret, and repairs it', async () => {
    const root = distribution({ monolith: true })
    // as a setup that stopped between the slot and its pointer leaves it
    const stranded = { 'acme-core': { ACME_MEMBERS_SECRET_A: { production: { value: 'x', sensitive: true, updatedAt: 0 } } } }
    const check = await fgDist(path.join(root, 'apps', 'monolith'), ['env', 'check', '--build'], {
      VERCEL: '1',
      VERCEL_ENV: 'production',
      ACME_MEMBERS_SECRET_A: 'x',
    })
    assert.match(check.stderr, /ACME_MEMBERS_SECRET {2}\(@acme\/members\)/)

    const vercel = fakeVercel(stranded)
    const setup = await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    // unresolved only for what it cannot know, and nothing it tried failed
    assert.doesNotMatch(setup.stderr, /failed/)
    const [current] = vercel.secret('acme-core', 'ACME_MEMBERS_SECRET')
    assert.ok(current && current !== 'x')
    assert.equal(vercel.value('acme-core', 'ACME_MEMBERS_SECRET_CURRENT').value, 'B')
  })

  test('fills in a shared secret one side has by moving both to a new one, reading neither', async () => {
    const root = distribution({ monolith: false })
    const vercel = fakeVercel({
      'acme-id': {
        ACME_ID_SERVICE_MEMBERS_SECRET_A: { production: { value: 'unseen', sensitive: true, updatedAt: 0 } },
        ACME_ID_SERVICE_MEMBERS_SECRET_CURRENT: { production: { value: 'A', sensitive: false, updatedAt: 0 } },
      },
    })
    await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    const [fresh, kept] = vercel.secret('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET')
    // id takes the new one and still accepts what it had; members sends the new one
    assert.equal(kept, 'unseen')
    assert.deepEqual(vercel.secret('acme-members', 'ACME_MEMBERS_CLIENT_SECRET'), [fresh])
    assert.equal(vercel.value('acme-members', 'ACME_MEMBERS_CLIENT_SECRET_CURRENT').value, 'B')
  })

  test('a dry run keeps nothing, not even a project it was told', async () => {
    const root = distribution({ monolith: true })
    const manifest = path.join(root, 'package.json')
    json(manifest, { name: '@acme/core' })
    const before = readFileSync(manifest, 'utf8')
    const vercel = fakeVercel()
    const saved = process.env.VERCEL_CLI
    process.env.VERCEL_CLI = vercel.bin
    try {
      const [remote] = await remotesOf(root, 'production', { project: async () => 'acme-core', save: false })
      assert.equal(remote.target.project, 'acme-core')
    } finally {
      if (saved === undefined) delete process.env.VERCEL_CLI
      else process.env.VERCEL_CLI = saved
    }
    assert.equal(readFileSync(manifest, 'utf8'), before)
  })
})

describe('what an app may declare', () => {
  test('ties only rotated secrets together, which are made once for every side', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'declared-'))
    json(path.join(dir, 'package.json'), {
      name: '@acme/app',
      fairgarden: { env: { A_KEY: { description: 'x', generate: 'secret', sameAs: 'B_KEY' } } },
    })
    assert.throws(() => envApp(dir), /"sameAs" ties rotated secrets, and this is not one/)
  })
})

describe('rotating', () => {
  const setUp = async (monolith, options) => {
    const root = distribution({ monolith })
    const vercel = fakeVercel({}, options)
    await fgDist(root, ['env', 'setup'], { VERCEL_CLI: vercel.bin })
    vercel.before = vercel.read()
    return { root, vercel }
  }

  test('checks before it sends, and never reads a secret to do it', async () => {
    const { root, vercel } = await setUp(false)
    const [old] = vercel.secret('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET')
    const result = await fgDist(root, ['env', 'rotate', '--yes'], { VERCEL_CLI: vercel.bin })
    assert.equal(result.status, 0, result.stderr)

    // id checks the new one and the old; members sends the new one
    const [fresh, kept] = vercel.secret('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET')
    assert.equal(kept, old)
    assert.notEqual(fresh, old)
    assert.equal(vercel.secret('acme-members', 'ACME_MEMBERS_CLIENT_SECRET')[0], fresh)
    // the new value went into the other slot, sensitive, and the pointer moved to it
    assert.equal(vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET_B').sensitive, true)
    assert.equal(vercel.value('acme-id', 'ACME_ID_SERVICE_MEMBERS_SECRET_CURRENT').value, 'B')

    const log = vercel.read().log.slice(vercel.before.log.length)
    const step = (entry) => {
      const at = log.findIndex((line) => line.startsWith(entry))
      assert.notEqual(at, -1, `${entry} never happened: ${log.join(' | ')}`)
      return at
    }
    // what checks it is redeployed with both before anything sends the new one
    assert.ok(step('env add ACME_ID_SERVICE_MEMBERS_SECRET_B') < step('redeploy dpl_acme-id'))
    assert.ok(step('redeploy dpl_acme-id') < step('env add ACME_MEMBERS_CLIENT_SECRET_B'))
    // and each value before the pointer at it
    assert.ok(step('env add ACME_MEMBERS_CLIENT_SECRET_B') < step('env update ACME_MEMBERS_CLIENT_SECRET_CURRENT'))
    // members' own session key waits for its client secret: one redeploy for both
    assert.equal(log.filter((line) => line.startsWith('redeploy dpl_acme-members')).length, 1)
  })

  test('keeps one value before the new one, and drops the rest', async () => {
    const { root, vercel } = await setUp(true)
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy'], { VERCEL_CLI: vercel.bin })
    const second = vercel.secret('acme-core', 'ACME_MEMBERS_SECRET')
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy'], { VERCEL_CLI: vercel.bin })
    const third = vercel.secret('acme-core', 'ACME_MEMBERS_SECRET')
    assert.equal(third.length, 2)
    assert.equal(third[1], second[0])
    assert.ok(!third.includes(second[1]))
  })

  test('finds the slot in use from when each was set, where a team policy hides even the pointer', async () => {
    const { root, vercel } = await setUp(true, { policy: 'sensitive' })
    assert.equal(vercel.value('acme-core', 'ACME_MEMBERS_SECRET_CURRENT').sensitive, true)
    for (const expected of ['B', 'A', 'B']) {
      const result = await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy'], { VERCEL_CLI: vercel.bin })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(vercel.value('acme-core', 'ACME_MEMBERS_SECRET_CURRENT').value, expected)
      assert.equal(vercel.secret('acme-core', 'ACME_MEMBERS_SECRET').length, 2)
    }
  })

  test('makes a slot first set readable sensitive, the moment it is rotated into', async () => {
    const root = distribution({ monolith: true })
    // as an earlier fg-dist left them: readable
    const readable = (value, updatedAt) => ({ production: { value, sensitive: false, updatedAt } })
    const vercel = fakeVercel({
      'acme-core': {
        ACME_MEMBERS_SECRET_A: readable('now', 2),
        ACME_MEMBERS_SECRET_B: readable('before', 1),
        ACME_MEMBERS_SECRET_CURRENT: readable('A', 2),
      },
    })
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy', 'ACME_MEMBERS_SECRET'], { VERCEL_CLI: vercel.bin })
    assert.equal(vercel.value('acme-core', 'ACME_MEMBERS_SECRET_B').sensitive, true)
    assert.equal(vercel.value('acme-core', 'ACME_MEMBERS_SECRET_CURRENT').value, 'B')
  })

  test('takes a secret set by hand into its slots, keeping it for one rotation', async () => {
    const root = distribution({ monolith: true })
    const vercel = fakeVercel({
      'acme-core': { ACME_MEMBERS_SECRET: { production: { value: 'by-hand', sensitive: true, updatedAt: 0 } } },
    })
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy', 'ACME_MEMBERS_SECRET'], { VERCEL_CLI: vercel.bin })
    const first = vercel.secret('acme-core', 'ACME_MEMBERS_SECRET')
    assert.equal(first.length, 2)
    assert.equal(first[1], 'by-hand')
    await fgDist(root, ['env', 'rotate', '--yes', '--no-redeploy', 'ACME_MEMBERS_SECRET'], { VERCEL_CLI: vercel.bin })
    assert.equal(vercel.value('acme-core', 'ACME_MEMBERS_SECRET'), undefined)
    assert.ok(!vercel.secret('acme-core', 'ACME_MEMBERS_SECRET').includes('by-hand'))
  })

  test('asks first, and without anyone to ask, does nothing', async () => {
    const { root, vercel } = await setUp(true)
    const result = await fgDist(root, ['env', 'rotate'], { VERCEL_CLI: vercel.bin })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /Pass --yes/)
    assert.deepEqual(vercel.read().projects, vercel.before.projects)
  })
})
