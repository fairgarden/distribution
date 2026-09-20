import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'

/** Run git, returning undefined rather than throwing when it fails. */
const git = (cwd: string, args: string[]): string | undefined => {
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

const lines = (value: string | undefined): string[] =>
  value ? value.split('\n').filter(Boolean) : []

/** The repository holding the submodules, which is not the monolith directory. */
export const repositoryRoot = (from: string): string | undefined =>
  git(from, ['rev-parse', '--show-toplevel'])

export interface Submodule {
  /** Last path segment, which is what you name on the command line. */
  name: string
  /** The section name in .gitmodules, which is what config reads and writes. */
  configName: string
  /** Path as recorded in .gitmodules, relative to the repository. */
  relativePath: string
  path: string
  url: string
  /** The commit the repository has pinned. */
  pinned: string
}

/**
 * Submodules as `.gitmodules` records them, with the commit each is pinned to.
 *
 * Uninitialised submodules are left out — there is nothing to inspect until
 * they are checked out.
 */
export const submodules = (root: string): Submodule[] => {
  const config = git(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path'])
  const found: Submodule[] = []

  for (const line of lines(config)) {
    const [key, relativePath] = line.split(' ')
    if (!relativePath) continue

    const name = key.slice('submodule.'.length, -'.path'.length)
    const url =
      git(root, ['config', '--file', '.gitmodules', '--get', `submodule.${name}.url`]) ?? ''
    const full = path.join(root, relativePath)

    // An uninitialised submodule is an empty directory, and git run inside one
    // finds the distribution instead — reporting the distribution's own tags
    // as the module's, and checking one out onto the distribution's HEAD.
    if (!existsSync(path.join(full, '.git'))) continue

    const pinned = git(full, ['rev-parse', 'HEAD'])
    if (!pinned) continue

    found.push({
      name: path.basename(relativePath),
      configName: name,
      relativePath,
      path: full,
      url,
      pinned,
    })
  }

  return found
}

/** Tags that name a version, newest first. */
const versionTags = (cwd: string): string[] =>
  lines(git(cwd, ['tag', '--list']))
    .filter((tag) => semver.valid(tag) !== null)
    .sort((a, b) => semver.rcompare(a, b))

/** The branch tip the submodule is tracking, for counting unreleased work. */
const upstream = (cwd: string): string | undefined => {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', ref])) return ref
  }
  return undefined
}

export type ReleaseKind = 'major' | 'minor' | 'patch'

export interface SubmoduleState {
  submodule: Submodule
  /** The commit checked out right now, which a bump changes. */
  head: string
  /** Version pinned right now, when a tag names it. */
  current: string | undefined
  /** Whether that tag is the pinned commit rather than an ancestor of it. */
  exact: boolean
  /** Newer version tags, newest first. */
  available: string[]
  /** The newest upgrade of each kind that is available. */
  upgrades: Partial<Record<ReleaseKind, string>>
  /** Commits on the tracked branch that no version tag covers yet. */
  untagged: number
  /** Uncommitted changes, which make moving the pin unsafe. */
  dirty: boolean
  /** Whether the remote was reachable, when a fetch was attempted. */
  fetched: boolean | undefined
}

/**
 * Compare a submodule's pinned commit against the versions its repository has.
 *
 * Only tags that name a version are considered an upgrade. Commits past the
 * newest tag are counted and reported, but never bumped to — a commit carries
 * no statement about what changed, which is the whole point of the version.
 */
export const inspect = (
  submodule: Submodule,
  { fetch = true }: { fetch?: boolean } = {}
): SubmoduleState => {
  const cwd = submodule.path

  let fetched: boolean | undefined
  if (fetch) {
    fetched = git(cwd, ['fetch', '--tags', '--quiet']) !== undefined
  }

  const dirty = (git(cwd, ['status', '--porcelain']) ?? '') !== ''
  const tags = versionTags(cwd)

  // Read HEAD rather than trusting the commit captured at discovery: a bump
  // moves the checkout, and anything inspecting afterwards must see that.
  const head = git(cwd, ['rev-parse', 'HEAD']) ?? submodule.pinned

  const exactTag = lines(git(cwd, ['tag', '--points-at', head])).find(
    (tag) => semver.valid(tag) !== null
  )
  // Otherwise the newest tag the pinned commit descends from.
  const describedTag = git(cwd, ['describe', '--tags', '--abbrev=0', '--match', '*', head])
  const described =
    describedTag && semver.valid(describedTag) !== null ? describedTag : undefined

  const current = exactTag ?? described
  const available = current
    ? tags.filter((tag) => semver.gt(tag, current))
    : tags

  const upgrades: Partial<Record<ReleaseKind, string>> = {}
  for (const tag of available) {
    // semver.diff also returns premajor, preminor and prepatch. Bucketing
    // those as patch would let a jump to 1.0.0-alpha.0 apply without --major,
    // which matters most for the 0.x.y-alpha.n versions this is built for.
    const difference = current ? semver.diff(current, tag) : 'major'
    const bucket: ReleaseKind =
      difference === 'major' || difference === 'premajor'
        ? 'major'
        : difference === 'minor' || difference === 'preminor'
          ? 'minor'
          : 'patch'
    // available is newest first, so the first of each kind is the newest.
    upgrades[bucket] ??= tag
  }

  const tip = upstream(cwd)
  const from = available[0] ?? current ?? head
  const untagged = tip
    ? Number(git(cwd, ['rev-list', '--count', `${from}..${tip}`]) ?? '0')
    : 0

  return {
    submodule,
    head,
    current,
    exact: exactTag !== undefined,
    available,
    upgrades,
    untagged,
    dirty,
    fetched,
  }
}

/**
 * The version a bump should move to, or undefined when there is nothing to do.
 *
 * Major upgrades are held back unless asked for: they are the ones that need a
 * person to read a changelog first.
 */
export const target = (
  state: SubmoduleState,
  { major = false }: { major?: boolean } = {}
): string | undefined => {
  const candidates = [
    state.upgrades.patch,
    state.upgrades.minor,
    ...(major ? [state.upgrades.major] : []),
  ].filter((tag): tag is string => tag !== undefined)

  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => semver.rcompare(a, b))[0]
}

/**
 * Record a different URL for a submodule.
 *
 * `.gitmodules` is what gets committed, and `submodule sync` copies it into the
 * local config so the existing checkout uses it too. The caller commits.
 */
export const setUrl = (root: string, submodule: Submodule, url: string): void => {
  const written = git(root, [
    'config',
    '--file',
    '.gitmodules',
    `submodule.${submodule.configName}.url`,
    url,
  ])
  if (written === undefined) {
    throw new Error(`Could not set the url for ${submodule.relativePath}.`)
  }
  git(root, ['submodule', 'sync', '--quiet', '--', submodule.relativePath])
}

/**
 * Whether a remote can be read with no credentials at all.
 *
 * This is the question a build host asks. Prompting is disabled so a private
 * repository fails immediately instead of waiting for a password nobody is
 * there to type.
 */
export const isPublic = (url: string, timeout = 15_000): boolean => {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
      },
    })
    return true
  } catch {
    return false
  }
}

/** Move a submodule's checkout to a tag. The caller commits the new pointer. */
export const moveTo = (submodule: Submodule, tag: string): void => {
  // Belt and braces: never check out inside something that is not the
  // submodule's own repository.
  if (!existsSync(path.join(submodule.path, '.git'))) {
    throw new Error(
      `${submodule.relativePath} is not checked out, so there is nothing to move.`
    )
  }

  const result = git(submodule.path, ['checkout', '--quiet', `refs/tags/${tag}`])
  if (result === undefined) {
    throw new Error(`Could not check out ${tag} in ${submodule.relativePath}.`)
  }
}
