import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Applies and rolls back an app's migrations: the ones drizzle-kit writes into
 * its `drizzle/` folder.
 *
 * drizzle-kit writes each forward migration from the schema, and lists them
 * in `meta/_journal.json`, which is the order they run in. Rolling one back
 * runs the `<tag>.down.sql` beside it, written by hand. A migration without
 * one cannot be rolled back.
 *
 * Every migration runs in its own transaction, under a lock, so two builds
 * migrating at once take turns. What ran is recorded with a hash in the app's
 * own journal table, and a migration edited after it ran is refused rather
 * than skipped. Each app has its own table and lock, so several can share one
 * database — as a monolith's apps do.
 *
 * Imported by the apps themselves, to migrate their embedded development
 * database, so it keeps to Node's own modules.
 */

/** Where an app records what has run, and the lock it migrates under. */
export interface Journal {
  table: string
  lock: number
}

/** What an app declares in package.json, under `fairgarden.migrations`. */
export interface MigrationsDeclaration extends Journal {
  /** The folder drizzle-kit writes into, relative to the package. */
  directory: string
  /** Environment variables naming its database, the first one set winning. */
  database: string[]
}

/** An app's migrations, found from its package. */
export interface Migrations extends Journal {
  /** The package they belong to. */
  name: string
  root: string
  /** The migrations folder. */
  directory: string
  database: string[]
}

/** What this needs of a `pg` pool: one client, held for the lock. */
export interface MigrationPool {
  connect(): Promise<MigrationClient>
}

export interface MigrationClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
  release(): void
}

export interface Migration {
  tag: string
  up: string[]
  down: string[] | undefined
  hash: string
}

export interface MigrationStatus {
  tag: string
  state: 'applied' | 'pending' | 'edited' | 'unknown'
  appliedAt: Date | undefined
  reversible: boolean
}

const BREAKPOINT = '--> statement-breakpoint'
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * The migrations a package declares, or undefined when it declares none.
 *
 * Read from its package.json rather than its code, so a monolith can migrate
 * an app without loading it — or its configuration, which a build host may
 * not have.
 */
export const declaredMigrations = (root: string): Migrations | undefined => {
  let manifest: { name?: unknown; fairgarden?: { migrations?: Partial<MigrationsDeclaration> } }
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const declared = manifest.fairgarden?.migrations
  if (!declared) return undefined

  const name = typeof manifest.name === 'string' ? manifest.name : root
  const { directory, table, lock, database } = declared
  const wrong = (what: string): Error =>
    new Error(`${name} declares its migrations in package.json, but ${what}.`)
  if (typeof directory !== 'string') throw wrong('not their "directory"')
  // Written into SQL, so only a plain identifier will do.
  if (typeof table !== 'string' || !IDENTIFIER.test(table)) throw wrong('"table" is not a plain lower-case name')
  if (typeof lock !== 'number' || !Number.isSafeInteger(lock)) throw wrong('"lock" is not an integer')
  if (!Array.isArray(database) || database.length === 0 || !database.every((each) => typeof each === 'string')) {
    throw wrong('"database" does not name the variables its database URL is in')
  }
  return { name, root, directory: path.resolve(root, directory), table, lock, database }
}

const statements = (sql: string): string[] =>
  sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    // A stub, or a chunk of nothing but comments, runs nothing.
    .filter((statement) => statement.replace(/--.*$/gm, '').trim().length > 0)

export const readMigrations = (directory: string): Migration[] => {
  const journal = JSON.parse(
    readFileSync(path.join(directory, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ idx: number; tag: string }> }

  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => {
      const up = readFileSync(path.join(directory, `${tag}.sql`), 'utf8')
      const downFile = path.join(directory, `${tag}.down.sql`)
      const down = existsSync(downFile) ? statements(readFileSync(downFile, 'utf8')) : []
      return {
        tag,
        up: statements(up),
        down: down.length > 0 ? down : undefined,
        hash: createHash('sha256').update(up).digest('hex'),
      }
    })
}

interface AppliedRow {
  tag: string
  hash: string
  applied_at: Date
}

const withLock = async <T>(
  pool: MigrationPool,
  { table, lock }: Journal,
  fn: (client: MigrationClient) => Promise<T>
): Promise<T> => {
  if (!IDENTIFIER.test(table)) throw new Error(`${table} is not a plain lower-case table name.`)
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [lock])
    try {
      await client.query(`
        create table if not exists ${table} (
          tag text primary key,
          hash text not null,
          applied_at timestamptz not null default now()
        )
      `)
      return await fn(client)
    } finally {
      await client.query('select pg_advisory_unlock($1)', [lock])
    }
  } finally {
    client.release()
  }
}

const readApplied = async (client: MigrationClient, table: string): Promise<Map<string, AppliedRow>> => {
  const { rows } = await client.query(`select tag, hash, applied_at from ${table}`)
  return new Map((rows as AppliedRow[]).map((row) => [row.tag, row]))
}

const inTransaction = async (client: MigrationClient, fn: () => Promise<void>): Promise<void> => {
  await client.query('begin')
  try {
    await fn()
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  }
}

export const status = (pool: MigrationPool, directory: string, journal: Journal): Promise<MigrationStatus[]> =>
  withLock(pool, journal, async (client) => {
    const migrations = readMigrations(directory)
    const applied = await readApplied(client, journal.table)
    const known = new Set(migrations.map((migration) => migration.tag))
    return [
      ...migrations.map((migration): MigrationStatus => {
        const row = applied.get(migration.tag)
        return {
          tag: migration.tag,
          state: !row ? 'pending' : row.hash === migration.hash ? 'applied' : 'edited',
          appliedAt: row ? new Date(row.applied_at) : undefined,
          reversible: migration.down !== undefined,
        }
      }),
      ...[...applied.values()]
        .filter((row) => !known.has(row.tag))
        .map((row): MigrationStatus => ({
          tag: row.tag,
          state: 'unknown',
          appliedAt: new Date(row.applied_at),
          reversible: false,
        })),
    ]
  })

/** Apply every pending migration, in order. Returns the tags applied. */
export const migrate = (pool: MigrationPool, directory: string, journal: Journal): Promise<string[]> =>
  withLock(pool, journal, async (client) => {
    const migrations = readMigrations(directory)
    const applied = await readApplied(client, journal.table)
    const known = new Set(migrations.map((migration) => migration.tag))

    const unknown = [...applied.keys()].filter((tag) => !known.has(tag))
    if (unknown.length > 0) {
      throw new Error(
        `The database has migrations this version does not know (${unknown.join(', ')}). ` +
          'Run a newer version, or roll them back with it first.'
      )
    }
    for (const migration of migrations) {
      const row = applied.get(migration.tag)
      if (row && row.hash !== migration.hash) {
        throw new Error(
          `${migration.tag} changed after it was applied. Revert the edit and add a new migration instead.`
        )
      }
    }

    const ran: string[] = []
    for (const migration of migrations.filter((migration) => !applied.has(migration.tag))) {
      await inTransaction(client, async () => {
        for (const statement of migration.up) await client.query(statement)
        await client.query(`insert into ${journal.table} (tag, hash) values ($1, $2)`, [
          migration.tag,
          migration.hash,
        ])
      })
      ran.push(migration.tag)
    }
    return ran
  })

/**
 * Roll back the latest migrations: one by default, `steps` of them, or every
 * one after `to`. Returns the tags rolled back, newest first.
 */
export const rollback = (
  pool: MigrationPool,
  directory: string,
  journal: Journal,
  { steps, to }: { steps?: number; to?: string } = {}
): Promise<string[]> =>
  withLock(pool, journal, async (client) => {
    const migrations = readMigrations(directory)
    const applied = await readApplied(client, journal.table)
    const newestFirst = migrations.filter((migration) => applied.has(migration.tag)).reverse()

    let targets: Migration[]
    if (to !== undefined) {
      const index = newestFirst.findIndex((migration) => migration.tag === to)
      if (index === -1 && to !== '0') throw new Error(`${to} is not an applied migration`)
      targets = index === -1 ? newestFirst : newestFirst.slice(0, index)
    } else {
      targets = newestFirst.slice(0, steps ?? 1)
    }

    const irreversible = targets.filter((migration) => !migration.down)
    if (irreversible.length > 0) {
      throw new Error(
        `No down migration for ${irreversible.map((migration) => migration.tag).join(', ')}. ` +
          `Write ${path.basename(directory)}/<tag>.down.sql first.`
      )
    }

    for (const migration of targets) {
      await inTransaction(client, async () => {
        for (const statement of migration.down!) await client.query(statement)
        await client.query(`delete from ${journal.table} where tag = $1`, [migration.tag])
      })
    }
    return targets.map((migration) => migration.tag)
  })
