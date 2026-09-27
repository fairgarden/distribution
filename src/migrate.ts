import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  declaredMigrations,
  migrate,
  rollback,
  status,
  type MigrationPool,
  type Migrations,
  type MigrationStatus,
} from './migrations.ts'
import { packageDir } from './packages.ts'

/**
 * Migrate the databases of the apps a build ships, as part of the build.
 *
 * Run where an app is built, it migrates that app. Run where a monolith is
 * built, it migrates every app the monolith depends on that declares
 * migrations — each against its own database, which may be the same one.
 *
 * In a build it runs after `next build`, so a build that fails to compile
 * changes nothing, and only where a build is meant to: see `inBuild`. A
 * migration has to work with the release before it too, because a Vercel
 * rollback promotes an older deployment without running a build.
 */

type Env = Record<string, string | undefined>

/** The apps to migrate from `root`: itself, or what it depends on. */
export const migrationTargets = (root: string): Migrations[] => {
  const own = declaredMigrations(root)
  if (own) return [own]

  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const found: Migrations[] = []
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const dir = packageDir(root, name)
    const declared = dir ? declaredMigrations(dir) : undefined
    if (declared) found.push(declared)
  }
  return found
}

export interface BuildDecision {
  migrate: boolean
  /** Why, in words for the build log. */
  reason: string
}

/**
 * Whether this build migrates.
 *
 * A production build on Vercel does. A preview build does only when told to,
 * with `FG_MIGRATE=build` for the Preview environment — which is right once
 * each preview has a database of its own, and wrong while previews share
 * production's, where a branch's migrations would reach it before the branch
 * does. `FG_MIGRATE=skip` turns it off anywhere.
 */
export const inBuild = (env: Env): BuildDecision => {
  if (env.FG_MIGRATE === 'skip') return { migrate: false, reason: 'FG_MIGRATE is skip' }
  if (env.FG_MIGRATE === 'build') return { migrate: true, reason: 'FG_MIGRATE is build' }
  if (env.FG_MIGRATE) {
    return { migrate: false, reason: `FG_MIGRATE is ${env.FG_MIGRATE}, which is neither build nor skip` }
  }
  if (env.VERCEL_ENV === 'production') return { migrate: true, reason: 'this is a Vercel production build' }
  if (env.VERCEL_ENV === 'preview') {
    return {
      migrate: false,
      reason:
        'a preview build only migrates with FG_MIGRATE=build, set for Preview once each preview has its own database',
    }
  }
  return { migrate: false, reason: 'this is not a Vercel production build; FG_MIGRATE=build migrates here' }
}

export interface Database {
  /** The variable the URL came from. */
  variable: string
  url: string
}

/**
 * The database an app uses, as the app itself picks it — the first of its
 * variables that is set — but connected to directly where one is offered.
 *
 * Neon's pooled URL runs through PgBouncer, which does not keep the session
 * the migration lock belongs to, so its `_UNPOOLED` (or Vercel Postgres's
 * `_NON_POOLING`) sibling is used instead. Only the chosen variable's own
 * sibling: another variable may name another database.
 */
export const databaseOf = (variables: string[], env: Env): Database | undefined => {
  for (const variable of variables) {
    if (!env[variable]) continue
    for (const direct of [`${variable}_UNPOOLED`, `${variable}_NON_POOLING`]) {
      if (env[direct]) return { variable: direct, url: env[direct]! }
    }
    return { variable, url: env[variable]! }
  }
  return undefined
}

interface NextEnv {
  loadEnvConfig(
    dir: string,
    dev?: boolean,
    log?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  ): { loadedEnvFiles: Array<{ path: string }> }
}

/** Next's own loader: the project's, from the `next` it builds with, or this package's. */
const nextEnv = (root: string): NextEnv => {
  try {
    const next = createRequire(path.join(root, 'package.json')).resolve('next/package.json')
    return createRequire(next)('@next/env') as NextEnv
  } catch {
    return createRequire(import.meta.url)('@next/env') as NextEnv
  }
}

/**
 * Read the environment files the way Next does for a build (or, with `dev`,
 * for `next dev`): the same files, the same precedence below what is already
 * set, and `$VARIABLE` references expanded — by Next's own loader, so this
 * connects to the database the app will. Returns the files read.
 */
export const loadEnvFiles = (root: string, { dev }: { dev: boolean }): string[] => {
  const { loadedEnvFiles } = nextEnv(root).loadEnvConfig(root, dev, {
    info: () => {},
    error: (...args) => console.error(...args),
  })
  return loadedEnvFiles.map((file) => file.path)
}

export type MigrateAction =
  | { kind: 'migrate' }
  | { kind: 'status' }
  | { kind: 'rollback'; steps?: number; to?: string }

export interface MigrateResult {
  target: Migrations
  database: Database | undefined
  /** Tags applied or rolled back. */
  changed: string[]
  status?: MigrationStatus[]
  /** Why nothing was done, when nothing was. */
  skipped?: string
}

export interface MigrateOptions {
  action: MigrateAction
  /** As part of a build: decide by `inBuild`, and let an app without a database pass. */
  build?: boolean
  env?: Env
  /** How to reach a database; a single-connection `pg` pool by default. */
  connect?: (url: string) => Promise<MigrationPool & { end(): Promise<void> }>
}

const connectWithPg = async (url: string): Promise<MigrationPool & { end(): Promise<void> }> => {
  const { default: pg } = await import('pg')
  // One connection: the lock belongs to its session.
  return new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 })
}

export class MigrateError extends Error {}

/** Run `action` against every target's database, one after another. */
export const runMigrations = async (
  targets: Migrations[],
  { action, build = false, env = process.env, connect = connectWithPg }: MigrateOptions
): Promise<MigrateResult[]> => {
  const results: MigrateResult[] = []
  for (const target of targets) {
    const database = databaseOf(target.database, env)
    if (!database) {
      // Only a build on a host with nowhere else to put it has to have one:
      // anywhere else the app starts its embedded database, which migrates
      // itself.
      if (build && !env.VERCEL) {
        results.push({ target, database, changed: [], skipped: 'no database is set; its embedded one migrates itself' })
        continue
      }
      throw new MigrateError(
        `No database for ${target.name}: set ${target.database[0]}` +
          (target.database.length > 1 ? `, or ${target.database.slice(1).join(' or ')}` : '') +
          (env.VERCEL ? ' — connecting Neon sets DATABASE_URL.' : '.')
      )
    }

    const pool = await connect(database.url)
    try {
      if (action.kind === 'status') {
        results.push({ target, database, changed: [], status: await status(pool, target.directory, target) })
      } else if (action.kind === 'rollback') {
        const changed = await rollback(pool, target.directory, target, { steps: action.steps, to: action.to })
        results.push({ target, database, changed })
      } else {
        results.push({ target, database, changed: await migrate(pool, target.directory, target) })
      }
    } catch (error) {
      throw new MigrateError(`${target.name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await pool.end()
    }
  }
  return results
}
