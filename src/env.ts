import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { declaredMigrations, type Migrations } from './migrations.ts'
import { packageDir } from './packages.ts'
import { submodules } from './submodules.ts'

/**
 * What a deployment needs in its environment, from what its apps declare.
 *
 * An app lists the variables a deployment of it has to have under
 * `fairgarden.env` in its package.json — what each is for, whether it is a
 * secret to generate and rotate, whether it follows from another app being
 * mounted beside it — so a build can refuse to deploy without them and say
 * exactly what to add, and `fg-dist env setup` can add them.
 *
 * A distribution with a monolith deploys it, one project serving every app;
 * without one, each app is a project of its own. A variable can belong to
 * another app's deployment — the one that reads it — which is how an app says
 * what the identity service needs to know about it.
 */

export interface EnvDeclaration {
  /** What it is for, for whoever is asked to set it. */
  description: string
  /** When a deployment has to have it: any deployed build, or production's alone. Otherwise optional. */
  required?: 'deployed' | 'production'
  /** The package whose deployment reads it. The declaring app's own by default. */
  deployment?: string
  /** A secret, which only the app should be able to read back. */
  sensitive?: boolean
  /** A random value, which `setup` makes and `rotate` replaces. */
  generate?: 'secret'
  /**
   * A list, newest first, every value of which the app accepts: rotated by
   * putting a new one first and keeping the one before, so nothing signed or
   * sent with it fails during the switch. Kept readable, since rotating it
   * keeps its current value.
   */
  rotate?: boolean
  /** What it is set to: there is nothing to ask. */
  value?: string
  example?: string
  /** Not needed when any of these is set. */
  unless?: string[]
  /** Not needed when the declaring app and this package share a monolith: the app works it out. */
  unlessMounted?: string
  /** The same value as this other declared variable, which may be in another deployment. */
  sameAs?: string
  /** It checks a shared secret, so it is rotated before the variables that send it. */
  verifies?: boolean
}

export interface EnvApp {
  name: string
  root: string
  env: Record<string, EnvDeclaration>
  migrations: Migrations | undefined
}

export interface Deployment {
  /** The package deployed: an app, or the monolith. */
  name: string
  root: string
  /** The apps it serves. */
  apps: EnvApp[]
}

export interface Requirement {
  /** The variable to set: the first of `anyOf`. */
  variable: string
  /** Any of these does. */
  anyOf: string[]
  /** The apps that need it. */
  apps: string[]
  declaration: EnvDeclaration
}

const VARIABLE = /^[A-Z_][A-Z0-9_]*$/

const readManifest = (root: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** An app that says anything about its environment or its database, or undefined. */
export const envApp = (root: string): EnvApp | undefined => {
  const manifest = readManifest(root)
  const fairgarden = manifest?.fairgarden as { env?: Record<string, EnvDeclaration> } | undefined
  const migrations = declaredMigrations(root)
  if (!fairgarden?.env && !migrations) return undefined
  const name = typeof manifest?.name === 'string' ? manifest.name : root

  const env = fairgarden?.env ?? {}
  for (const [variable, declaration] of Object.entries(env)) {
    const wrong = (what: string) => new Error(`${name} declares ${variable} in fairgarden.env, but ${what}.`)
    if (!VARIABLE.test(variable)) throw wrong('that is not an environment variable name')
    if (typeof declaration?.description !== 'string') throw wrong('without a description of what it is for')
    if (declaration.required && !['deployed', 'production'].includes(declaration.required)) {
      throw wrong('"required" is neither deployed nor production')
    }
    if (declaration.rotate && !declaration.generate) throw wrong('only a generated secret can be rotated')
    if (declaration.rotate && declaration.sensitive) {
      throw wrong('a rotated secret cannot be sensitive: rotating it keeps its current value, which has to be readable')
    }
    if (declaration.sameAs && !VARIABLE.test(declaration.sameAs)) throw wrong('"sameAs" is not a variable name')
  }
  return { name, root, env, migrations }
}

/**
 * What a package deploys: itself, as an app, or — as a monolith — every app it
 * depends on that declares anything.
 */
export const deploymentAt = (root: string): Deployment => {
  const manifest = readManifest(root)
  const name = typeof manifest?.name === 'string' ? manifest.name : root
  const own = envApp(root)
  if (own) return { name, root, apps: [own] }
  const apps: EnvApp[] = []
  for (const dependency of Object.keys((manifest?.dependencies as Record<string, string>) ?? {})) {
    const dir = packageDir(root, dependency)
    const app = dir ? envApp(dir) : undefined
    if (app) apps.push(app)
  }
  return { name, root, apps }
}

/**
 * How a distribution deploys: its monolith, when it has one, serving every
 * app; otherwise each app on its own, a project each.
 */
export const distributionDeployments = (distribution: string): Deployment[] => {
  const monolith = path.join(distribution, 'apps', 'monolith')
  if (existsSync(path.join(monolith, 'package.json'))) return [deploymentAt(monolith)]
  return submodules(distribution)
    .map((module) => envApp(module.path))
    .filter((app): app is EnvApp => app !== undefined)
    .map((app) => ({ name: app.name, root: app.root, apps: [app] }))
}

/** The distribution around `from`, if it is inside one: the nearest directory with submodules. */
export const distributionAround = (from: string): string | undefined => {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.gitmodules'))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

const requiredIn = (declaration: EnvDeclaration, environment: string): boolean =>
  declaration.required === 'deployed' || (declaration.required === 'production' && environment === 'production')

/**
 * What `deployment` has to have set in `environment` (Vercel's `production`
 * or `preview`). `peers` are the other apps of the distribution, whose
 * declarations may be for this deployment.
 */
export const requirementsFor = (
  deployment: Deployment,
  environment: string,
  peers: EnvApp[] = []
): Requirement[] => {
  const here = new Set(deployment.apps.map((app) => app.name))
  const everyApp = [...deployment.apps, ...peers.filter((peer) => !here.has(peer.name))]
  const found = new Map<string, Requirement>()

  for (const app of everyApp) {
    for (const [variable, declaration] of Object.entries(app.env)) {
      if (!here.has(declaration.deployment ?? app.name)) continue
      if (!requiredIn(declaration, environment)) continue
      // Mounted beside that package in this deployment, the app works it out.
      if (declaration.unlessMounted && here.has(app.name) && here.has(declaration.unlessMounted)) continue
      const known = found.get(variable)
      if (known) known.apps.push(app.name)
      else found.set(variable, { variable, anyOf: [variable], apps: [app.name], declaration })
    }
  }

  // Every app with a database needs one, on a host with nowhere to keep it.
  for (const app of deployment.apps) {
    if (!app.migrations) continue
    const key = app.migrations.database.join(' ')
    const known = found.get(key)
    if (known) {
      known.apps.push(app.name)
      continue
    }
    found.set(key, {
      variable: app.migrations.database[0],
      anyOf: app.migrations.database,
      apps: [app.name],
      declaration: {
        description: 'Its database. Connecting Neon to the project sets DATABASE_URL.',
        required: 'deployed',
        sensitive: true,
      },
    })
  }
  return [...found.values()]
}

type Env = Record<string, string | undefined>

const isSet = (env: Env, variable: string): boolean => Boolean(env[variable]?.trim())

/** The requirements `env` does not meet. */
export const missing = (requirements: Requirement[], env: Env): Requirement[] =>
  requirements.filter(
    (requirement) =>
      !requirement.anyOf.some((variable) => isSet(env, variable)) &&
      !(requirement.declaration.unless ?? []).some((variable) => isSet(env, variable))
  )

/** What to do about one missing variable, in words for a build log. */
const howToSet = (requirement: Requirement): string => {
  const { declaration } = requirement
  if (requirement.anyOf.length > 1) return `Or any of ${requirement.anyOf.slice(1).join(', ')}.`
  if (declaration.value !== undefined) return `Set it to ${declaration.value}.`
  if (declaration.sameAs) return `The same value as ${declaration.sameAs}: \`pnpm dist env setup\` sets both.`
  if (declaration.generate) return 'A long random value: `pnpm dist env setup` makes one.'
  if (declaration.example) return `For example ${declaration.example}`
  return ''
}

/** The build's refusal: every missing variable, what it is for, and how to add it. */
export const describeMissing = (deployment: Deployment, environment: string, absent: Requirement[]): string => {
  const lines = [`${deployment.name} is missing what a ${environment} deployment needs:`, '']
  for (const requirement of absent) {
    lines.push(`  ${requirement.variable}  (${requirement.apps.join(', ')})`)
    lines.push(`    ${requirement.declaration.description}`)
    const how = howToSet(requirement)
    if (how) lines.push(`    ${how}`)
  }
  lines.push(
    '',
    `Add them to the Vercel project for ${environment[0].toUpperCase()}${environment.slice(1)}, or run`,
    '`pnpm dist env setup` where the distribution is checked out, which adds them for you.'
  )
  return lines.join('\n')
}
