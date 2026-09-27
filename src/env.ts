import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { declaredMigrations, type Migrations } from './migrations.ts'
import { pointerVariable, SLOTS, slotVariable } from './secrets.ts'
import { composesApps, packageDir } from './packages.ts'
import { submodules, uninitialised } from './submodules.ts'

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
   * Kept in two slots, `NAME_A` and `NAME_B`, with `NAME_CURRENT` saying which
   * is in use (see secrets.ts): the app accepts both, so rotating one — a new
   * value in the other slot, never reading the old — fails nothing signed or
   * sent with it during the switch.
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
  /** The variable to set: the first of `anyOf`, or a rotated secret's name. */
  variable: string
  /** Any of these does. */
  anyOf: string[]
  /** An app's database, which is connected rather than set. */
  database?: boolean
  /** The apps that need it. */
  apps: string[]
  /**
   * Each of those apps' `unless`: it is excused only when every app needing
   * it is, whichever declared it first.
   */
  excusedBy: string[][]
  declaration: EnvDeclaration
}

const VARIABLE = /^[A-Z_][A-Z0-9_]*$/
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/

const is = (what: string, test: (value: unknown) => boolean) => ({ what, test })
const aVariable = (value: unknown) => typeof value === 'string' && VARIABLE.test(value)

/** Every field a declaration may have, and what each has to be. */
const FIELDS: Record<keyof EnvDeclaration, { what: string; test: (value: unknown) => boolean }> = {
  description: is('text', (value) => typeof value === 'string' && value.trim().length > 0),
  required: is('deployed or production', (value) => value === 'deployed' || value === 'production'),
  deployment: is('a package name', (value) => typeof value === 'string' && PACKAGE.test(value)),
  sensitive: is('true or false', (value) => typeof value === 'boolean'),
  generate: is('"secret"', (value) => value === 'secret'),
  rotate: is('true or false', (value) => typeof value === 'boolean'),
  value: is('text', (value) => typeof value === 'string'),
  example: is('text', (value) => typeof value === 'string'),
  unless: is('a list of variable names', (value) => Array.isArray(value) && value.every(aVariable)),
  unlessMounted: is('a package name', (value) => typeof value === 'string' && PACKAGE.test(value)),
  sameAs: is('a variable name', aVariable),
  verifies: is('true or false', (value) => typeof value === 'boolean'),
}

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
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Error(`${name} has a fairgarden.env that is not an object of variables.`)
  }
  for (const [variable, declaration] of Object.entries(env)) {
    const wrong = (what: string) => new Error(`${name} declares ${variable} in fairgarden.env, but ${what}.`)
    if (!VARIABLE.test(variable)) throw wrong('that is not an environment variable name')
    if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
      throw wrong('not as an object')
    }
    // package.json is whatever was typed, so every field is checked here —
    // not where it is first used, which may be a deployment later.
    const known = new Set(Object.keys(FIELDS))
    const stray = Object.keys(declaration).filter((field) => !known.has(field))
    if (stray.length > 0) throw wrong(`with ${stray.map((field) => `"${field}"`).join(', ')}, which fg-dist does not know`)
    for (const [field, valid] of Object.entries(FIELDS)) {
      const value = (declaration as unknown as Record<string, unknown>)[field]
      if (value !== undefined && !valid.test(value)) throw wrong(`"${field}" is not ${valid.what}`)
    }
    if (typeof declaration.description !== 'string') throw wrong('without a description of what it is for')
    if (declaration.rotate && !declaration.generate) throw wrong('only a generated secret can be rotated')
    // One value is made for a tied group only where it is a rotated secret;
    // anything else would be made, or asked for, once for each side.
    if (declaration.sameAs && !declaration.rotate) throw wrong('"sameAs" ties rotated secrets, and this is not one')
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
  // An app deploys itself, and nothing it merely depends on. A monolith
  // deploys every app it mounts — and itself, when it declares anything too.
  const apps: EnvApp[] = own ? [own] : []
  if (!composesApps(root)) return { name, root, apps }
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
  // A module not checked out says nothing about what it needs, and would be
  // passed over as if it needed nothing.
  const absent = uninitialised(distribution)
  if (absent.length > 0) {
    throw new Error(
      `These submodules are not checked out, so what they need cannot be read: ${absent.join(', ')}.\n` +
        'Run `git submodule update --init` first.'
    )
  }
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

/** What decides how a variable is set and rotated, which two apps sharing it have to say alike. */
const DECISIVE = ['sensitive', 'generate', 'rotate', 'value', 'sameAs', 'verifies'] as const

/** Two apps declaring one variable for one deployment have to mean the same by it. */
export const assertAgree = (variable: string, known: Requirement, app: string, declaration: EnvDeclaration): void => {
  const differ = DECISIVE.filter((field) => known.declaration[field] !== declaration[field])
  if (differ.length > 0) {
    throw new Error(
      `${known.apps[0]} and ${app} both declare ${variable}, but differently (${differ.join(', ')}). ` +
        'Whichever was set would be wrong for the other.'
    )
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
      // A rotated secret is set by hand, or in either slot.
      const anyOf = declaration.rotate ? [variable, slotVariable(variable, 'A'), slotVariable(variable, 'B')] : [variable]
      if (known) {
        assertAgree(variable, known, app.name, declaration)
        known.apps.push(app.name)
        known.excusedBy.push(declaration.unless ?? [])
      } else found.set(variable, { variable, anyOf, apps: [app.name], excusedBy: [declaration.unless ?? []], declaration })
    }
  }

  // Every app with a database needs one, on a host with nowhere to keep it.
  for (const app of deployment.apps) {
    if (!app.migrations) continue
    const key = app.migrations.database.join(' ')
    const known = found.get(key)
    if (known) {
      known.apps.push(app.name)
      known.excusedBy.push([])
      continue
    }
    found.set(key, {
      variable: app.migrations.database[0],
      anyOf: app.migrations.database,
      database: true,
      apps: [app.name],
      excusedBy: [[]],
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

/**
 * What a variable Vercel will not show reads as, in an environment made from
 * a listing: set, value unknown.
 */
export const UNREADABLE = '\u0000unreadable'

const isSet = (env: Env, variable: string): boolean => Boolean(env[variable]?.trim())

/**
 * Whether a rotated secret is usable, as the app reads it: set by hand, or the
 * slot its pointer names is set. A slot with no pointer at it is no secret at
 * all — as when setting one up stopped between the two. A pointer that cannot
 * be read is taken at its word.
 */
const rotatedIsSet = (env: Env, variable: string): boolean => {
  if (isSet(env, variable)) return true
  const pointer = env[pointerVariable(variable)]?.trim()
  if (pointer === UNREADABLE) return SLOTS.some((slot) => isSet(env, slotVariable(variable, slot)))
  return (pointer === 'A' || pointer === 'B') && isSet(env, slotVariable(variable, pointer))
}

/** The requirements `env` does not meet. */
export const missing = (requirements: Requirement[], env: Env): Requirement[] =>
  requirements.filter(
    (requirement) =>
      !(requirement.declaration.rotate
        ? rotatedIsSet(env, requirement.variable)
        : requirement.anyOf.some((variable) => isSet(env, variable))) &&
      !requirement.excusedBy.every((unless) => unless.some((variable) => isSet(env, variable)))
  )

/** What to do about one missing variable, in words for a build log. */
const howToSet = (requirement: Requirement): string => {
  const { declaration } = requirement
  if (requirement.database && requirement.anyOf.length > 1) return `Or any of ${requirement.anyOf.slice(1).join(', ')}.`
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
