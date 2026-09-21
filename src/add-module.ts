import { execFileSync } from 'node:child_process'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'

import path from 'node:path'
import { writeOverrides } from './overrides.ts'
import { repositoryRoot } from './submodules.ts'
import { readPackageName } from './scaffold.ts'
import { addMount, ConfigEditError, declaresMonolith } from './config-edit.ts'
import { toHttps } from './git-url.ts'

const CONFIG_FILES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
]

const git = (cwd: string, args: string[]): string => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (cause) {
    const stderr =
      cause instanceof Error && 'stderr' in cause ? String(cause.stderr).trim() : ''
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`, { cause })
  }
}

/** `git@host:owner/name.git` or `https://host/owner/name(.git)` -> `name`. */
export const nameFromUrl = (url: string): string => {
  const last = url.replace(/\.git$/, '').split(/[/:]/).pop() ?? ''
  return last || 'module'
}

export interface AddModuleOptions {
  /** Where the submodule goes, relative to the repository. Defaults to `apps/<name>`. */
  at?: string
  /** Mount name, which becomes the URL segment. Defaults to the repository name. */
  mount?: string
  /** The monolith whose package.json gains the dependency. Found when omitted. */
  monolith?: string
  /**
   * Record the URL as given instead of rewriting it to HTTPS. Only do this
   * when nothing but a developer's machine will ever clone the submodule.
   */
  ssh?: boolean
}

/**
 * Whether a directory holds the app that composes modules.
 *
 * Identified by its Next config calling `withMonolith`. A module depends on
 * this package as well, so the dependency alone would match every module.
 */
const composesModules = async (dir: string): Promise<boolean> => {
  for (const file of CONFIG_FILES) {
    const source = await readFile(path.join(dir, file), 'utf8').catch(() => undefined)
    if (source !== undefined) return declaresMonolith(source)
  }
  return false
}

/**
 * The app that composes the modules, or undefined when there is none.
 *
 * A distribution too complex to serve from one deployment has no monolith at
 * all; each app under `apps/` is deployed on its own.
 */
export const findMonolith = async (
  root: string,
  from: string
): Promise<string | undefined> => {
  if (await composesModules(from)) return from

  const candidates = [path.join(root, 'apps', 'monolith')]
  for (const parent of ['apps', 'packages']) {
    const entries = await readdir(path.join(root, parent), {
      withFileTypes: true,
    }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(root, parent, entry.name))
    }
  }

  for (const candidate of candidates) {
    if (await composesModules(candidate)) return candidate
  }
  return undefined
}

export interface AddModuleResult {
  /** Whether the workspace overrides were updated to include this module. */
  overrides: boolean
  /** Why they were not, when the workspace could not be edited. */
  overridesError: string | undefined
  mount: string
  relativePath: string
  packageName: string | undefined
  version: string | undefined
  /** Whether the monolith's package.json was changed. */
  linked: boolean
  /** The monolith package.json that was, or should be, updated. */
  monolithPackageJson: string | undefined
  /** The config the mount was written into. */
  monolithConfig: string | undefined
  /** Whether the mount was added; false when it was already declared. */
  mounted: boolean
  /** Why the config could not be edited, when it could not be. */
  mountError: string | undefined
  /** The URL recorded in .gitmodules, which may differ from the one given. */
  url: string
  /** Whether that URL was rewritten from SSH. */
  rewritten: boolean
  /** Whether the module has routes, and so is mounted rather than depended on. */
  isApp: boolean
}

/**
 * Add a module repository as a submodule and wire it into the monolith.
 *
 * The submodule is what pins the version, and the dependency is what makes the
 * module resolvable by package name. The mount itself is declared in the
 * monolith's Next config, which is left alone — rewriting someone's config is
 * not something a command should do quietly.
 */
export const addModule = async (
  cwd: string,
  url: string,
  options: AddModuleOptions = {}
): Promise<AddModuleResult> => {
  const root = repositoryRoot(cwd)
  if (!root) throw new Error(`${cwd} is not inside a git repository.`)

  const name = nameFromUrl(url)
  // Where it lands is decided after cloning, since only the contents say
  // whether this is an app to deploy or a package apps depend on.
  const relativePath = options.at ?? path.join('apps', name)
  const full = path.join(root, relativePath)

  // .gitmodules is committed, so this URL is what every later clone uses.
  const recorded = options.ssh ? url : toHttps(url)
  const rewritten = recorded !== url

  git(root, ['submodule', 'add', recorded, relativePath])
  git(root, ['submodule', 'update', '--init', '--recursive', relativePath])

  let placedAt = relativePath
  let placedFull = full

  // A distribution is apps and the packages they share. An app has routes; a
  // package does not, and belongs beside the others rather than under apps/.
  const isApp = await hasRoutes(full)
  if (!options.at && !isApp) {
    const packagePath = path.join('packages', name)
    try {
      await mkdir(path.join(root, 'packages'), { recursive: true })
      git(root, ['mv', relativePath, packagePath])
      placedAt = packagePath
      placedFull = path.join(root, packagePath)
    } catch {
      // Leaving it under apps/ is wrong but harmless; say nothing and carry on.
    }
  }

  const packageName = await readPackageName(placedFull)
  const version = await readVersion(placedFull)

  const monolithRoot = options.monolith
    ? path.resolve(cwd, options.monolith)
    : await findMonolith(root, cwd)
  const monolithPackageJson = monolithRoot
    ? path.join(monolithRoot, 'package.json')
    : undefined

  // Linked through the workspace, so the version is irrelevant here — only
  // the name is. Guarding on the version left a module with none mounted but
  // never depended on.
  let linked = false
  if (packageName && monolithPackageJson && monolithRoot !== root) {
    linked = await addDependency(monolithPackageJson, packageName)
  }

  const mount = options.mount ?? name
  // Only an app is mounted at a path. A package is depended on, not served.
  // A mount is written into the config as a bare string, which is read back as
  // a package name. Without one there is nothing valid to write, so say so
  // rather than record a path that will not resolve.
  const { config, mounted, error } =
    monolithRoot && isApp
      ? packageName
        ? await declareMount(monolithRoot, mount, packageName)
        : {
            config: undefined,
            mounted: false,
            error:
              'It has no package name, so there is nothing to mount it by. ' +
              'Give it one, or mount it by path yourself.',
          }
      : { config: undefined, mounted: false, error: undefined }

  // The distribution resolves its own modules from the tree, not from their
  // declared ranges — which stop matching as soon as a submodule is bumped
  // past them.
  // The repository, not where the command was run: adding a module from
  // apps/monolith is a supported path, and `cwd` there is not the root.
  //
  // Last, and after everything that matters. The submodule is added and the
  // mount is written by now, so a workspace this cannot edit — a sibling with
  // no checkout, an `overrides:` key someone else wrote — is something to
  // report, not something to fail the whole command over.
  const overrides = await writeOverrides(repositoryRoot(cwd) ?? cwd).catch(
    (error: unknown) => ({
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    })
  )

  return {
    overrides: overrides.changed,
    overridesError: 'error' in overrides ? overrides.error : undefined,
    mount,
    relativePath: placedAt,
    packageName,
    version,
    linked,
    monolithPackageJson,
    monolithConfig: config,
    mounted,
    mountError: error,
    url: recorded,
    rewritten,
    isApp,
  }
}

/**
 * Write the mount into the monolith's Next config.
 *
 * Reports rather than throws when the config is shaped in a way it cannot
 * edit — the submodule is already added by then, and failing the whole command
 * over a line someone can paste would be worse than saying so.
 */
const declareMount = async (
  monolithRoot: string,
  mount: string,
  module: string
): Promise<{ config: string | undefined; mounted: boolean; error: string | undefined }> => {
  for (const file of CONFIG_FILES) {
    const full = path.join(monolithRoot, file)
    let source: string
    try {
      source = await readFile(full, 'utf8')
    } catch {
      continue
    }

    try {
      const result = addMount(source, mount, module)
      if (result.changed) await writeFile(full, result.source)
      return { config: full, mounted: result.changed, error: undefined }
    } catch (cause) {
      return {
        config: full,
        mounted: false,
        error:
          cause instanceof ConfigEditError
            ? cause.message
            : `The config could not be edited: ${String(cause)}`,
      }
    }
  }

  return { config: undefined, mounted: false, error: 'No Next config was found.' }
}

const isDirectory = async (candidate: string): Promise<boolean> =>
  (await stat(candidate).catch(() => undefined))?.isDirectory() === true

/** Whether a checkout is an app, meaning it has routes Next would serve. */
const hasRoutes = async (root: string): Promise<boolean> => {
  for (const dir of ['app', 'pages', path.join('src', 'app'), path.join('src', 'pages')]) {
    if (await isDirectory(path.join(root, dir))) return true
  }
  return false
}

const readVersion = async (root: string): Promise<string | undefined> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Depend on the module through the workspace, not on a version.
 *
 * Nothing in a distribution repository pins a module version: the submodule
 * commit is the pin, and the version is whatever the package.json inside that
 * checkout says. `workspace:*` is how that is spelled, and it keeps the
 * repository from carrying a second, stale copy of the same fact.
 */
const addDependency = async (
  packageJsonPath: string,
  name: string
): Promise<boolean> => {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  } catch {
    return false
  }

  const dependencies = { ...((pkg.dependencies as Record<string, string>) ?? {}) }
  if (dependencies[name] === 'workspace:*') return false

  dependencies[name] = 'workspace:*'
  pkg.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
  )

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
  return true
}
