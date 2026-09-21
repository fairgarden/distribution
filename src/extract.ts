import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { writeOverrides } from './overrides.ts'
import semver from 'semver'
import { repositoryRoot, submodules } from './submodules.ts'
import { toHttps } from './git-url.ts'

/**
 * Turn a directory that grew inside a distribution into a module of its own.
 *
 * An app or package is easier to get working in place, where the workspace
 * already resolves it and there is one repository to run. Once it works it
 * wants its own history and its own version, which is what this does: the
 * directory becomes a repository, and the distribution picks it back up as a
 * submodule. Nothing is re-cloned, so it works before anything is pushed.
 */

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

const quiet = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

export interface ExtractOptions {
  /** Where the new repository will live. Recorded in .gitmodules. */
  url: string
  /** Record the url as given rather than rewriting it to https. */
  ssh?: boolean
  /** Tag the first commit with the version its package.json declares. */
  tag?: boolean
}

export interface ExtractResult {
  /** Why the workspace overrides were not updated, when they could not be. */
  overridesError: string | undefined
  relativePath: string
  packageName: string | undefined
  version: string | undefined
  url: string
  rewritten: boolean
  /** The repository was created here, rather than already existing. */
  initialised: boolean
  /** The version tag written, when one was. */
  tagged: string | undefined
}

const isDirectory = (candidate: string): boolean => {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

const readManifest = async (
  root: string
): Promise<{ name?: string; version?: string }> => {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

export const extractModule = async (
  cwd: string,
  target: string,
  options: ExtractOptions
): Promise<ExtractResult> => {
  const root = repositoryRoot(cwd)
  if (!root) throw new Error(`${cwd} is not inside a git repository.`)

  const full = path.resolve(cwd, target)
  const relativePath = path.relative(root, full)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${target} is outside ${root}.`)
  }
  if (!isDirectory(full)) {
    throw new Error(`${relativePath} is not a directory.`)
  }
  if (submodules(root).some((module) => module.relativePath === relativePath)) {
    throw new Error(`${relativePath} is already a submodule.`)
  }

  const recorded = options.ssh ? options.url : toHttps(options.url)
  const { name, version } = await readManifest(full)

  // An existing repository here is kept: it may already have the history.
  // Looking for `.git` in the directory itself, because `rev-parse` walks up
  // and would find the distribution's repository instead.
  const alreadyRepository = existsSync(path.join(full, '.git'))
  const initialised = !alreadyRepository
  if (initialised) {
    git(full, ['init', '--quiet', '-b', 'main'])
  }

  // The distribution's .gitignore stops applying the moment this is its own
  // repository, so without one of its own the first commit would carry
  // node_modules and build output.
  if (!existsSync(path.join(full, '.gitignore'))) {
    await writeFile(
      path.join(full, '.gitignore'),
      'node_modules\n.next\n.turbo\ndist\nout\nnext-env.d.ts\n*.tsbuildinfo\n'
    )
  }

  // Nested packages — a docs site, most often — were members of the
  // distribution's workspace. Out here nothing says so, and pnpm 10 links
  // nothing across a workspace unless told to, so this repository needs the
  // arrangement written down for itself.
  const nested = await nestedPackages(full)
  if (nested.length > 0 && !existsSync(path.join(full, 'pnpm-workspace.yaml'))) {
    await writeFile(path.join(full, 'pnpm-workspace.yaml'), workspaceFile(nested))
  }

  // Commit whatever is there, so the submodule has something to point at.
  if (quiet(full, ['status', '--porcelain']) !== '') {
    git(full, ['add', '-A'])
    git(full, ['commit', '--quiet', '-m', 'Initial commit'])
  }

  if (quiet(full, ['remote', 'get-url', 'origin']) === undefined) {
    git(full, ['remote', 'add', 'origin', recorded])
  }

  // A module is versioned by tags, so give it the one its manifest declares.
  let tagged: string | undefined
  if (options.tag !== false && version && semver.valid(version)) {
    const tag = `v${version}`
    if (quiet(full, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) === undefined) {
      quiet(full, ['tag', tag])
      tagged = tag
    }
  }

  // Untrack the files, then let git adopt the repository that is already here.
  // `submodule add` clones only when the path is empty, so nothing is refetched
  // and this works before the remote exists.
  // Tolerant, so a retry after a half-finished run still works: the files may
  // already be untracked.
  quiet(root, ['rm', '-r', '--quiet', '--cached', relativePath])
  git(root, ['submodule', 'add', recorded, relativePath])

  // Now that it is a submodule, the distribution resolves it from the tree
  // rather than through whatever range its dependents declare. The repository
  // is made and the submodule added by this point, so a workspace this cannot
  // edit is reported rather than failing a job that is otherwise done.
  const overridesError = await writeOverrides(root).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )

  return {
    overridesError,
    relativePath,
    packageName: name,
    version,
    url: recorded,
    rewritten: recorded !== options.url,
    initialised,
    tagged,
  }
}

/** Directories one level down that are packages in their own right. */
const nestedPackages = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        !entry.name.startsWith('.') &&
        existsSync(path.join(root, entry.name, 'package.json'))
    )
    .map((entry) => entry.name)
    .sort()
}

/**
 * A workspace covering this repository and the packages inside it.
 *
 * The settings are not decoration: pnpm 10 defaults `linkWorkspacePackages` to
 * false, so without it a nested package resolves its dependency on this one
 * from the registry rather than from the checkout it is sitting in.
 */
export const workspaceFile = (nested: string[]): string =>
  [
    '# For when this repository is cloned on its own.',
    '#',
    '# pnpm uses the nearest workspace file to where it is run, so inside a',
    '# distribution this one applies to `pnpm install` run from THIS directory —',
    '# which would build a second workspace with its own lockfile and without the',
    '# distribution\'s overrides. Install from the distribution root instead.',
    'packages:',
    '  # The workspace root — this module — is always a member; these are the',
    '  # additions.',
    ...nested.map((name) => `  - ${name}`),
    '',
    '# pnpm 10 defaults this to false, so without it the packages above resolve',
    '# their dependency on this module from the registry instead of from the',
    '# checkout next to them.',
    'linkWorkspacePackages: true',
    '# Keep plain semver ranges in package.json: the range is what a published',
    '# module is installed by, and what a distribution reads to resolve versions.',
    'saveWorkspaceProtocol: false',
    '',
  ].join('\n')
