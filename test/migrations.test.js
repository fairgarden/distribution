import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import pg from 'pg'
import { declaredMigrations, migrate, rollback, status, withoutComments } from '../dist/migrations.js'
import { databaseOf, inBuild, migrationTargets, runMigrations } from '../dist/migrate.js'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/** A migrations folder shaped like drizzle-kit's. */
const folder = (migrations, directory = mkdtempSync(path.join(tmpdir(), 'migrations-'))) => {
  mkdirSync(path.join(directory, 'meta'), { recursive: true })
  writeFileSync(
    path.join(directory, 'meta', '_journal.json'),
    JSON.stringify({ entries: migrations.map(({ tag }, idx) => ({ idx, tag })) })
  )
  for (const { tag, up, down } of migrations) {
    writeFileSync(path.join(directory, `${tag}.sql`), up)
    if (down !== undefined) writeFileSync(path.join(directory, `${tag}.down.sql`), down)
  }
  return directory
}

/** A package that declares its migrations, as an app does. */
const app = (dir, name, { table, lock, database, migrations }) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, fairgarden: { migrations: { directory: 'drizzle', table, lock, database } } })
  )
  folder(migrations, path.join(dir, 'drizzle'))
  return dir
}

/** A real Postgres wire protocol over PGlite, which is what `pg` and the CLI talk to. */
const useDatabase = () => {
  const database = { url: '', pool: undefined }
  let pglite
  let server
  before(async () => {
    pglite = await PGlite.create()
    server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 8 })
    await server.start()
    database.url = `postgres://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`
    database.pool = new pg.Pool({ connectionString: database.url, max: 1 })
  })
  after(async () => {
    await database.pool?.end()
    await server?.stop()
    await pglite?.close()
  })
  return database
}

const tables = async (database, prefix) =>
  (
    await database.pool.query(
      `select table_name as name from information_schema.tables
       where table_schema = 'public' and table_name like $1 order by 1`,
      [`${prefix}%`]
    )
  ).rows.map((row) => row.name)

const JOURNAL = { table: 't_migrations', lock: 42 }

describe('the migrator', () => {
  const database = useDatabase()

  test('applies, reports and rolls back migrations in order', async () => {
    const directory = folder([
      { tag: '0000_a', up: 'create table t_a (id int);\n--> statement-breakpoint\ncreate table t_b (id int);', down: 'drop table t_b;\n--> statement-breakpoint\ndrop table t_a;' },
      { tag: '0001_c', up: 'create table t_c (id int);', down: 'drop table t_c;' },
    ])

    assert.deepEqual(await migrate(database.pool, directory, JOURNAL), ['0000_a', '0001_c'])
    assert.deepEqual(await migrate(database.pool, directory, JOURNAL), [])
    assert.deepEqual(await tables(database, 't\\_'), ['t_a', 't_b', 't_c', 't_migrations'])
    assert.deepEqual((await status(database.pool, directory, JOURNAL)).map((row) => row.state), ['applied', 'applied'])

    assert.deepEqual(await rollback(database.pool, directory, JOURNAL), ['0001_c'])
    assert.deepEqual((await status(database.pool, directory, JOURNAL)).map((row) => row.state), ['applied', 'pending'])

    await migrate(database.pool, directory, JOURNAL)
    assert.deepEqual(await rollback(database.pool, directory, JOURNAL, { to: '0' }), ['0001_c', '0000_a'])
    assert.deepEqual(await tables(database, 't\\_'), ['t_migrations'])
  })

  test('refuses a migration edited after it ran', async () => {
    const journal = { table: 'e_migrations', lock: 43 }
    const beforeEdit = folder([{ tag: '0000_x', up: 'create table e_x (id int);', down: 'drop table e_x;' }])
    await migrate(database.pool, beforeEdit, journal)
    const edited = folder([{ tag: '0000_x', up: 'create table e_x (id bigint);', down: 'drop table e_x;' }])
    assert.equal((await status(database.pool, edited, journal))[0].state, 'edited')
    await assert.rejects(migrate(database.pool, edited, journal), /changed after it was applied/)
  })

  test('refuses to roll back without a down migration, and changes nothing', async () => {
    const journal = { table: 'r_migrations', lock: 44 }
    const directory = folder([
      { tag: '0000_y', up: 'create table r_y (id int);', down: 'drop table r_y;' },
      { tag: '0001_z', up: 'create table r_z (id int);', down: '-- nothing written yet\n' },
    ])
    await migrate(database.pool, directory, journal)
    await assert.rejects(rollback(database.pool, directory, journal, { steps: 2 }), /No down migration for 0001_z/)
    assert.deepEqual(await tables(database, 'r\\_'), ['r_migrations', 'r_y', 'r_z'])

    // and a version that is behind the database refuses to run against it
    const older = folder([{ tag: '0000_y', up: 'create table r_y (id int);', down: 'drop table r_y;' }])
    await assert.rejects(migrate(database.pool, older, journal), /does not know \(0001_z\)/)
  })

  test('two apps share a database, each with its own journal', async () => {
    // Both start at 0000_init, as id and members do: one journal would collide.
    const one = folder([{ tag: '0000_init', up: 'create table one_things (id int);' }])
    const two = folder([{ tag: '0000_init', up: 'create table two_things (id int);' }])
    assert.deepEqual(await migrate(database.pool, one, { table: 'one_migrations', lock: 1 }), ['0000_init'])
    assert.deepEqual(await migrate(database.pool, two, { table: 'two_migrations', lock: 2 }), ['0000_init'])
    assert.deepEqual(await tables(database, 'one\\_'), ['one_migrations', 'one_things'])
    assert.deepEqual(await tables(database, 'two\\_'), ['two_migrations', 'two_things'])
  })

  test('looking at a database changes nothing, not even to create its journal', async () => {
    const journal = { table: 'fresh_migrations', lock: 45 }
    const directory = folder([{ tag: '0000_f', up: 'create table fresh_f (id int);' }])
    assert.deepEqual((await status(database.pool, directory, journal)).map((row) => row.state), ['pending'])
    assert.deepEqual(await tables(database, 'fresh\\_'), [])
  })

  test('runs nothing a branch put before what has run already', async () => {
    const journal = { table: 'g_migrations', lock: 49 }
    const first = { tag: '0000_a', up: 'create table g_a (id int);', down: 'drop table g_a;' }
    const later = { tag: '0002_c', up: 'create table g_c (id int);', down: 'drop table g_c;' }
    await migrate(database.pool, folder([first, later]), journal)
    const merged = folder([first, { tag: '0001_b', up: 'create table g_b (id int);', down: 'drop table g_b;' }, later])
    await assert.rejects(migrate(database.pool, merged, journal), /0001_b comes before 0002_c, which ran, and it has not/)
    assert.deepEqual(await tables(database, 'g\\_'), ['g_a', 'g_c', 'g_migrations'])
  })

  test('neither migrates nor rolls back a history moved about since it ran', async () => {
    const journal = { table: 'o_migrations', lock: 50 }
    const a = { tag: '0000_a', up: 'create table o_a (id int);', down: 'drop table o_a;' }
    const b = { tag: '0001_b', up: 'create table o_b (id int);', down: 'drop table o_b;' }
    const c = { tag: '0002_c', up: 'create table o_c (id int);', down: 'drop table o_c;' }
    await migrate(database.pool, folder([a, b]), journal)
    const moved = folder([b, a, c])
    await assert.rejects(migrate(database.pool, moved, journal), /0000_a ran before 0001_b, but the history now puts it after/)
    await assert.rejects(rollback(database.pool, moved, journal), /0000_a ran before 0001_b/)
    assert.deepEqual(await tables(database, 'o\\_'), ['o_a', 'o_b', 'o_migrations'])
  })

  test('rolls nothing back under migrations only a newer version knows', async () => {
    const journal = { table: 'n_migrations', lock: 46 }
    const newer = folder([
      { tag: '0000_a', up: 'create table n_a (id int);', down: 'drop table n_a;' },
      { tag: '0001_b', up: 'create table n_b (id int);', down: 'drop table n_b;' },
    ])
    await migrate(database.pool, newer, journal)
    const older = folder([{ tag: '0000_a', up: 'create table n_a (id int);', down: 'drop table n_a;' }])
    await assert.rejects(rollback(database.pool, older, journal), /does not know \(0001_b\)/)
    assert.deepEqual(await tables(database, 'n\\_'), ['n_a', 'n_b', 'n_migrations'])
  })

  test('rolls nothing back with a down file for a migration edited since it ran', async () => {
    const journal = { table: 'd_migrations', lock: 47 }
    await migrate(database.pool, folder([{ tag: '0000_a', up: 'create table d_a (id int);', down: 'drop table d_a;' }]), journal)
    const edited = folder([{ tag: '0000_a', up: 'create table d_other (id int);', down: 'drop table d_other;' }])
    await assert.rejects(rollback(database.pool, edited, journal), /changed after it was applied, so its down migration may not undo what ran/)
    assert.deepEqual(await tables(database, 'd\\_'), ['d_a', 'd_migrations'])
  })

  test('takes a down file of nothing but comments of either kind for no way back', async () => {
    const journal = { table: 'b_migrations', lock: 48 }
    const directory = folder([
      { tag: '0000_a', up: 'create table b_a (id int);', down: '/* TODO: drop b_a */\n-- and anything else' },
    ])
    await migrate(database.pool, directory, journal)
    assert.equal((await status(database.pool, directory, journal))[0].reversible, false)
    await assert.rejects(rollback(database.pool, directory, journal), /No down migration for 0000_a/)
    assert.deepEqual(await tables(database, 'b\\_'), ['b_a', 'b_migrations'])
  })

  test('keeps its journal under a name that is also a keyword', async () => {
    const journal = { table: 'user', lock: 49 }
    const directory = folder([{ tag: '0000_k', up: 'create table k_things (id int);', down: 'drop table k_things;' }])
    assert.deepEqual(await migrate(database.pool, directory, journal), ['0000_k'])
    assert.deepEqual((await status(database.pool, directory, journal)).map((row) => row.state), ['applied'])
    assert.deepEqual(await rollback(database.pool, directory, journal), ['0000_k'])
  })

  test('takes no table name it would have to quote', async () => {
    await assert.rejects(
      migrate(database.pool, folder([]), { table: 'x; drop table t_migrations', lock: 1 }),
      /not a plain lower-case table name/
    )
  })
})

describe('what is a comment', () => {
  test('as PostgreSQL reads it: both kinds, nested, and never inside quotes', () => {
    assert.equal(withoutComments('/* a /* nested */ comment */').trim(), '')
    assert.equal(withoutComments('drop table t; -- done').trim(), 'drop table t;')
    for (const text of [
      "select '/* not a comment */'",
      'select "-- a column"',
      "select 'it''s -- text'",
      "select E'it\\'s -- text'",
      'create function f() returns int as $body$ select 1 /* kept */ $body$ language sql',
    ]) {
      assert.equal(withoutComments(text), text)
    }
  })
})

describe('what an app declares', () => {
  test('is read from its package.json, with the folder made absolute', () => {
    const root = app(mkdtempSync(path.join(tmpdir(), 'declared-')), '@acme/id', {
      table: 'id_migrations',
      lock: 7031000001,
      database: ['ACME_ID_DATABASE_URL', 'DATABASE_URL'],
      migrations: [],
    })
    assert.deepEqual(declaredMigrations(root), {
      name: '@acme/id',
      root,
      directory: path.join(root, 'drizzle'),
      table: 'id_migrations',
      lock: 7031000001,
      database: ['ACME_ID_DATABASE_URL', 'DATABASE_URL'],
    })
  })

  test('refuses a journal name PostgreSQL would cut short', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'declared-'))
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@acme/id', fairgarden: { migrations: { directory: 'drizzle', table: 'a'.repeat(64), lock: 1, database: ['X'] } } })
    )
    assert.throws(() => declaredMigrations(root), /at most 63 characters/)
  })

  test('says what is wrong with a declaration', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'declared-'))
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@acme/id', fairgarden: { migrations: { directory: 'drizzle', table: 'Id-Migrations', lock: 1, database: ['X'] } } })
    )
    assert.throws(() => declaredMigrations(root), /"table" is not a plain lower-case name/)
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@acme/id', fairgarden: { migrations: { directory: 'drizzle', table: 'id_migrations', lock: 1, database: ['DATABASE-URL'] } } })
    )
    assert.throws(() => declaredMigrations(root), /"database" does not name the variables/)
  })
})

describe('which builds migrate', () => {
  test('a production build does; a preview only when told to; anywhere else only when told to', () => {
    assert.equal(inBuild({ VERCEL_ENV: 'production' }).migrate, true)
    assert.equal(inBuild({ VERCEL_ENV: 'preview' }).migrate, false)
    assert.match(inBuild({ VERCEL_ENV: 'preview' }).reason, /FG_MIGRATE=build/)
    assert.equal(inBuild({ VERCEL_ENV: 'preview', FG_MIGRATE: 'build' }).migrate, true)
    assert.equal(inBuild({}).migrate, false)
    assert.equal(inBuild({ FG_MIGRATE: 'build' }).migrate, true)
    assert.equal(inBuild({ VERCEL_ENV: 'production', FG_MIGRATE: 'skip' }).migrate, false)
    // a typo is not a yes
    assert.equal(inBuild({ VERCEL_ENV: 'production', FG_MIGRATE: 'yes' }).migrate, false)
  })
})

describe("an app's database", () => {
  test('is the first variable set, connected to directly when that one offers it', () => {
    const variables = ['FG_ID_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL']
    assert.deepEqual(databaseOf(variables, { DATABASE_URL: 'pooled', DATABASE_URL_UNPOOLED: 'direct' }), {
      variable: 'DATABASE_URL_UNPOOLED',
      url: 'direct',
    })
    assert.deepEqual(databaseOf(variables, { POSTGRES_URL: 'pooled', POSTGRES_URL_NON_POOLING: 'direct' }), {
      variable: 'POSTGRES_URL_NON_POOLING',
      url: 'direct',
    })
    // Another variable's direct URL may be another database: never borrowed.
    assert.deepEqual(databaseOf(variables, { FG_ID_DATABASE_URL: 'own', DATABASE_URL_UNPOOLED: 'shared' }), {
      variable: 'FG_ID_DATABASE_URL',
      url: 'own',
    })
    assert.equal(databaseOf(variables, {}), undefined)
  })
})

/** A monolith depending on two apps, the way pnpm lays one out. */
const monolith = () => {
  const base = mkdtempSync(path.join(tmpdir(), 'monolith-'))
  const id = app(path.join(base, 'id'), '@acme/id', {
    table: 'mid_migrations',
    lock: 11,
    database: ['ACME_ID_DATABASE_URL', 'DATABASE_URL'],
    migrations: [{ tag: '0000_init', up: 'create table mid_accounts (id int);', down: 'drop table mid_accounts;' }],
  })
  const members = app(path.join(base, 'members'), '@acme/members', {
    table: 'mmembers_migrations',
    lock: 12,
    database: ['ACME_MEMBERS_DATABASE_URL', 'DATABASE_URL'],
    migrations: [{ tag: '0000_init', up: 'create table mmembers_members (id int);', down: 'drop table mmembers_members;' }],
  })
  const root = path.join(base, 'monolith')
  mkdirSync(path.join(root, 'node_modules', '@acme'), { recursive: true })
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'mono', dependencies: { '@acme/id': '*', '@acme/members': '*', next: '*' } })
  )
  // What makes it a monolith, as the scaffold writes it.
  writeFileSync(path.join(root, 'next.config.ts'), "import { withMonolith } from '@fairgarden/monolith'\nexport default withMonolith({})\n")
  symlinkSync(id, path.join(root, 'node_modules', '@acme', 'id'), 'dir')
  symlinkSync(members, path.join(root, 'node_modules', '@acme', 'members'), 'dir')
  return { root, id, members }
}

/**
 * The CLI, as a build runs it. Asynchronously: the database is served from
 * this process, which has to keep answering while the CLI talks to it.
 */
const fgDist = async (cwd, args, env) => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      // Only what the test gives it: none of the host's database variables.
      env: { PATH: process.env.PATH, ...env },
    })
    return { status: 0, stdout }
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

describe('migrating a monolith', () => {
  const database = useDatabase()

  test("finds the apps it ships, and migrates each into the database it would use", async () => {
    const { root } = monolith()
    assert.deepEqual(migrationTargets(root).map((target) => target.name), ['@acme/id', '@acme/members'])

    const results = await runMigrations(migrationTargets(root), {
      action: { kind: 'migrate' },
      env: { DATABASE_URL: database.url },
    })
    assert.deepEqual(results.map((result) => [result.target.name, result.changed]), [
      ['@acme/id', ['0000_init']],
      ['@acme/members', ['0000_init']],
    ])
    assert.deepEqual(await tables(database, 'mid\\_'), ['mid_accounts', 'mid_migrations'])
    assert.deepEqual(await tables(database, 'mmembers\\_'), ['mmembers_members', 'mmembers_migrations'])
  })

  test('migrates its own too, when it has any, beside the apps it mounts', () => {
    const { root } = monolith()
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    manifest.fairgarden = { migrations: { directory: 'drizzle', table: 'mono_migrations', lock: 13, database: ['DATABASE_URL'] } }
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest))
    assert.deepEqual(migrationTargets(root).map((target) => target.name), ['mono', '@acme/id', '@acme/members'])
  })

  test('migrates nothing an app only depends on', () => {
    const { id } = monolith()
    const site = mkdtempSync(path.join(tmpdir(), 'site-'))
    mkdirSync(path.join(site, 'node_modules', '@acme'), { recursive: true })
    writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: '@acme/site', dependencies: { '@acme/id': '*' } }))
    symlinkSync(id, path.join(site, 'node_modules', '@acme', 'id'), 'dir')
    assert.deepEqual(migrationTargets(site), [])
  })

  test('a build on a host with nowhere else to put it has to have a database', async () => {
    const { root } = monolith()
    const targets = migrationTargets(root)
    // Locally, an app without one starts its embedded database.
    const local = await runMigrations(targets, { action: { kind: 'migrate' }, build: true, env: {} })
    assert.ok(local.every((result) => result.skipped))
    // On Vercel it cannot.
    await assert.rejects(
      runMigrations(targets, { action: { kind: 'migrate' }, build: true, env: { VERCEL: '1' } }),
      /No database for @acme\/id: set ACME_ID_DATABASE_URL, or DATABASE_URL — connecting Neon sets DATABASE_URL/
    )
  })

  test('the command migrates in a production build, and says why not in a preview', async () => {
    const { root } = monolith()
    const preview = await fgDist(root, ['migrate', '--build'], { VERCEL: '1', VERCEL_ENV: 'preview', DATABASE_URL: database.url })
    assert.equal(preview.status, 0)
    assert.match(preview.stdout, /Not migrating: a preview build only migrates with FG_MIGRATE=build/)

    const production = await fgDist(root, ['migrate', '--build'], { VERCEL: '1', VERCEL_ENV: 'production', DATABASE_URL: database.url })
    assert.equal(production.status, 0, production.stderr)
    assert.match(production.stdout, /@acme\/id\s+up to date\s+\(DATABASE_URL\)/)

    const listed = await fgDist(root, ['migrate', '--status'], { DATABASE_URL: database.url })
    assert.match(listed.stdout, /@acme\/members\s+\(DATABASE_URL\)\n\s+applied\s+0000_init/)
  })

  test('rolls back one app, which it has to be told the name of', async () => {
    const { root } = monolith()
    const unnamed = await fgDist(root, ['migrate', '--rollback'], { DATABASE_URL: database.url })
    assert.notEqual(unnamed.status, 0)
    assert.match(unnamed.stderr, /Name the app to roll back: @acme\/id, @acme\/members/)

    const named = await fgDist(root, ['migrate', '--rollback', '@acme/members'], { DATABASE_URL: database.url })
    assert.equal(named.status, 0, named.stderr)
    assert.match(named.stdout, /@acme\/members\s+rolled back 0000_init/)
  })

  test('reads the database from the files Next reads for a build', async () => {
    const { root } = monolith()
    writeFileSync(path.join(root, '.env.production'), `DATABASE_URL=${database.url}\n`)
    const result = await fgDist(root, ['migrate', '--build'], { FG_MIGRATE: 'build' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /@acme\/members\s+applied 0000_init\s+\(DATABASE_URL\)/)
  })

  test('a build migrates, and nothing else', async () => {
    const { root } = monolith()
    for (const flag of ['--rollback', '--status']) {
      const result = await fgDist(root, ['migrate', '--build', flag, '@acme/id'], {
        VERCEL: '1',
        VERCEL_ENV: 'production',
        DATABASE_URL: database.url,
      })
      assert.notEqual(result.status, 0, flag)
      assert.match(result.stderr, /--build migrates, and nothing else/)
    }
  })

  test('refuses --to without a migration after it, rather than rolling back one', async () => {
    const { root } = monolith()
    await fgDist(root, ['migrate'], { DATABASE_URL: database.url })
    const result = await fgDist(root, ['migrate', '--rollback', '@acme/id', '--to'], { DATABASE_URL: database.url })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--to needs a value/)
    const listed = await fgDist(root, ['migrate', '--status', '@acme/id'], { DATABASE_URL: database.url })
    assert.match(listed.stdout, /applied\s+0000_init/)
  })

  test('expands $VARIABLE references in environment files, as Next does', async () => {
    const { root } = monolith()
    // the monolith here has no `next`: this is the loader fg-dist carries
    writeFileSync(path.join(root, '.env.production'), `PRIMARY=${database.url}\nDATABASE_URL=$PRIMARY\n`)
    const result = await fgDist(root, ['migrate', '--build'], { FG_MIGRATE: 'build' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /@acme\/id\s+(applied 0000_init|up to date)\s+\(DATABASE_URL\)/)
  })

  test('refuses how far to roll back without rolling back, rather than migrating forward', async () => {
    const { root } = monolith()
    const alone = await fgDist(root, ['migrate', '--steps', '2'], { DATABASE_URL: database.url })
    assert.notEqual(alone.status, 0)
    assert.match(alone.stderr, /--steps and --to say how far to roll back: they need --rollback/)
    const both = await fgDist(root, ['migrate', '--rollback', '@acme/id', '--steps', '1', '--to', '0'], { DATABASE_URL: database.url })
    assert.match(both.stderr, /--steps or --to, not both/)
  })

  test('says which app a database it could not reach was for', async () => {
    const { root } = monolith()
    await assert.rejects(
      runMigrations(migrationTargets(root), {
        action: { kind: 'migrate' },
        env: { DATABASE_URL: 'postgres://nowhere' },
        connect: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      }),
      /^MigrateError: @acme\/id: connect ECONNREFUSED|@acme\/id: connect ECONNREFUSED/
    )
  })
})

