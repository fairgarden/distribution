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

/**
 * Whether this repository ships modules, as opposed to being one.
 *
 * Read from `.gitmodules`, which is committed, rather than from
 * {@link submodules}, which only reports checkouts that are actually there. A
 * clone made without `--recurse-submodules` has the file and none of the
 * checkouts, and treating that as a module would write a module's readme over
 * the distribution's and let it be released as if it were one.
 */
export const isDistribution = (root: string): boolean =>
  existsSync(path.join(root, '.gitmodules')) &&
  (git(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path']) ?? '') !== ''

/**
 * Submodules that are missing their checkout.
 *
 * Anything that reads a module's own package.json needs to say so rather than
 * quietly leave it out.
 */
export const uninitialised = (root: string): string[] => {
  const config = git(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path'])

  return lines(config)
    .map((line) => line.split(' ')[1])
    .filter((relativePath): relativePath is string => Boolean(relativePath))
    .filter((relativePath) => !existsSync(path.join(root, relativePath, '.git')))
}

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
  /**
   * Where a fork was forked from, recorded as `submodule.<name>.upstream` in
   * .gitmodules. Git ignores the key; this is what reads it. Undefined for a
   * module checked out from its own repository.
   */
  upstream: string | undefined
  /** The commit the repository has pinned. */
  pinned: string
}

/** The remote a fork's checkout fetches its upstream from. */
export const UPSTREAM = 'upstream'

/** Read one key of a submodule's section in .gitmodules. */
export const gitmodulesGet = (root: string, configName: string, key: string): string | undefined =>
  git(root, ['config', '--file', '.gitmodules', '--get', `submodule.${configName}.${key}`]) || undefined

/** Write, or with `undefined` remove, one key of a submodule's section in .gitmodules. */
export const gitmodulesSet = (
  root: string,
  configName: string,
  key: string,
  value: string | undefined
): void => {
  const name = `submodule.${configName}.${key}`
  if (value === undefined) {
    git(root, ['config', '--file', '.gitmodules', '--unset', name])
    return
  }
  if (git(root, ['config', '--file', '.gitmodules', name, value]) === undefined) {
    throw new Error(`Could not write ${name} to .gitmodules.`)
  }
}

/**
 * Point a fork's checkout at its upstream, as a remote of its own.
 *
 * Every clone of the distribution has the fork's url as `origin`, from
 * .gitmodules; the upstream is only recorded there, so each checkout adds the
 * remote the first time it is needed.
 */
export const ensureUpstreamRemote = (cwd: string, url: string): void => {
  const current = git(cwd, ['remote', 'get-url', UPSTREAM])
  if (current === url) return
  git(cwd, current === undefined ? ['remote', 'add', UPSTREAM, url] : ['remote', 'set-url', UPSTREAM, url])
}

/**
 * Whether `base` already has everything `head` changes since they parted.
 *
 * Answered by merging one into the other without touching the checkout: when
 * the result is `base` exactly, `head` has nothing `base` lacks. That holds
 * however upstream took the changes — merged, rebased or squashed — which is
 * what matters before dropping a fork. A conflict, or anything left over,
 * counts as not.
 */
export const containsAll = (cwd: string, base: string, head: string): boolean => {
  if (git(cwd, ['merge-base', '--is-ancestor', head, base]) !== undefined) return true
  const merged = git(cwd, ['merge-tree', '--write-tree', base, head])?.split('\n')[0]
  return merged !== undefined && merged === git(cwd, ['rev-parse', `${base}^{tree}`])
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
      upstream: gitmodulesGet(root, name, 'upstream'),
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

/**
 * The branch tip the submodule is tracking, for counting unreleased work: a
 * fork's upstream, since that is where its releases come from, else its own.
 */
const trackedTip = (cwd: string, fork: boolean): string | undefined => {
  const remotes = fork ? [UPSTREAM, 'origin'] : ['origin']
  const refs = [...remotes.flatMap((remote) => ['HEAD', 'main', 'master'].map((branch) => `${remote}/${branch}`)), 'main', 'master']
  for (const ref of refs) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', ref])) return ref
  }
  return undefined
}

/**
 * Whether a commit is on the checkout's `origin`, so that another clone of
 * the distribution — a build host, say — can check it out. A commit made in
 * the checkout and pinned before it was pushed is not.
 */
const onOrigin = (cwd: string, commit: string): boolean => {
  if (lines(git(cwd, ['branch', '--remotes', '--contains', commit, '--list', 'origin/*'])).length > 0) {
    return true
  }
  // Tags reach commits too, and a fork is often pinned at an upstream tag
  // pushed to it rather than at a branch.
  return lines(git(cwd, ['ls-remote', '--tags', 'origin'])).some((line) => {
    const sha = line.split('\t')[0]
    return sha === commit || git(cwd, ['merge-base', '--is-ancestor', commit, sha]) !== undefined
  })
}

/** How a fork stands against the repository it was forked from. */
export interface ForkState {
  upstream: string
  /** Commits the fork has that upstream does not, merges and equivalent patches aside. */
  ahead: number
  /**
   * The oldest upstream release, from the pinned one on, that has everything
   * the fork adds — or the upstream branch, when only that has it yet.
   * Undefined while upstream has not taken all of it.
   */
  merged: string | undefined
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
  /**
   * Whether the pinned commit is on the remote, so other clones can check it
   * out. Only known after a fetch.
   */
  pushed: boolean | undefined
  /** Set for a fork, which also takes releases from its upstream. */
  fork: ForkState | undefined
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

  const fork = submodule.upstream
  if (fork) ensureUpstreamRemote(cwd, fork)

  let fetched: boolean | undefined
  if (fetch) {
    fetched = git(cwd, ['fetch', '--tags', '--quiet']) !== undefined
    if (fork) {
      // A fork takes its releases from upstream, so upstream's tags are the
      // versions it can move to.
      const upstreamFetched = git(cwd, ['fetch', '--tags', '--quiet', UPSTREAM]) !== undefined
      if (upstreamFetched) git(cwd, ['remote', 'set-head', UPSTREAM, '--auto'])
      fetched = fetched && upstreamFetched
    }
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

  const tip = trackedTip(cwd, fork !== undefined)
  const from = available[0] ?? current ?? head
  const untagged = tip
    ? Number(git(cwd, ['rev-list', '--count', `${from}..${tip}`]) ?? '0')
    : 0

  let forkState: ForkState | undefined
  if (fork) {
    const ahead = tip
      ? Number(
          git(cwd, ['rev-list', '--count', '--no-merges', '--cherry-pick', '--right-only', `${tip}...${head}`]) ??
            '0'
        )
      : 0
    // Oldest first: returning to upstream should move no further than it has to.
    const releases = [...(current ? [current] : []), ...[...available].reverse()]
    const merged =
      releases.find((tag) => containsAll(cwd, `refs/tags/${tag}`, head)) ??
      (tip && containsAll(cwd, tip, head) ? tip : undefined)
    forkState = { upstream: fork, ahead, merged }
  }

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
    pushed: fetched ? onOrigin(cwd, head) : undefined,
    fork: forkState,
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
