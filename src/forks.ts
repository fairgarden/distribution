import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import {
  CHANGELOG,
  bumpEntry,
  moduleLabel,
  noteInDistribution,
  releaseNotesUrl,
  repositoryLink,
  shown,
  topVersion,
  withEntry,
} from './changelog.ts'
import { existsSync, writeFileSync } from 'node:fs'
import { describeRemote, toHttps } from './git-url.ts'
import {
  UPSTREAM,
  containsAll,
  ensureUpstreamRemote,
  gitmodulesSet,
  moveTo,
  setUrl,
  type Submodule,
  type SubmoduleState,
} from './submodules.ts'

/**
 * Forking a module, from inside a distribution.
 *
 * A fork is the module checked out from somewhere you can push to, with the
 * repository it came from recorded beside it. You fix or add something there,
 * offer it upstream as a pull request, and meanwhile ship it. Updating works
 * as it does for any module, except that a fork takes upstream's releases by
 * merging them in. Once upstream has everything the fork adds, you can go back
 * to upstream, or keep the fork.
 */

/** Run git, throwing with what it said when it fails. */
const run = (cwd: string, args: string[]): string => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (cause) {
    const stderr =
      cause instanceof Error && 'stderr' in cause ? String(cause.stderr).trim() : ''
    throw new Error(`git ${args[0]} failed in ${cwd}${stderr ? `:\n${stderr}` : ''}`, { cause })
  }
}

/** Run git, returning undefined rather than throwing when it fails. */
const attempt = (cwd: string, args: string[]): string | undefined => {
  try {
    return run(cwd, args)
  } catch {
    return undefined
  }
}

/**
 * The branch in a fork that holds everything this distribution pins, named
 * after the distribution.
 *
 * Not the pull request's branch: GitHub deletes that once it is merged, and a
 * pinned commit has to stay fetchable for as long as anything pins it. Not the
 * fork's main either, which is upstream's to follow.
 */
export const distributionBranch = (root: string): string => {
  let name: unknown
  try {
    name = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name
  } catch {
    name = undefined
  }
  return (typeof name === 'string' ? name : path.basename(root))
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
}

/**
 * Put the checked-out commit on the fork's distribution branch, which only
 * moves forward. `to` is the fork's url, or `origin` once it is the fork.
 */
const pushPinned = (submodule: Submodule, branch: string, to = 'origin'): void => {
  try {
    run(submodule.path, ['push', '--quiet', to, `HEAD:refs/heads/${branch}`])
  } catch (cause) {
    const fork = to === 'origin' ? submodule.url : to
    throw new Error(
      `${branch} on ${describeRemote(fork)} has commits that ${submodule.relativePath} does not. ` +
        `Merge them in first, then run this again:\n` +
        `    cd ${submodule.relativePath} && git fetch ${fork} ${branch} && git merge FETCH_HEAD`,
      { cause }
    )
  }
}

/** `https://github.com/acme/id.git` -> `acme/id`; undefined anywhere else. */
export const githubRepo = (url: string): string | undefined =>
  /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(toHttps(url))?.[1]

/** The branch a remote's HEAD names, which is where pull requests go. */
const defaultBranch = (cwd: string, remote: string): string => {
  const read = () =>
    attempt(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])?.replace(`${remote}/`, '')
  const known = read()
  if (known) return known
  attempt(cwd, ['remote', 'set-head', remote, '--auto'])
  return read() ?? 'main'
}

export interface ForkOptions {
  /** Record the url as given instead of rewriting it to https. */
  ssh?: boolean
  /** Push the pinned commit to the fork, so other clones can check it out. */
  push?: boolean
}

export interface ForkResult {
  /** The fork's url, as recorded in .gitmodules. */
  url: string
  /** Where it was forked from. */
  upstream: string
  /** Whether the url was rewritten from ssh. */
  rewritten: boolean
  /** The branch the pinned commit was pushed to, when it was. */
  branch: string | undefined
}

/**
 * Check a module out from a fork, keeping where it came from.
 *
 * The fork has to exist already — on GitHub, the Fork button — since creating
 * repositories is not something to do behind anyone's back. Forking a fork
 * keeps the original upstream.
 */
export const forkModule = (
  root: string,
  submodule: Submodule,
  url: string,
  { ssh = false, push = true }: ForkOptions = {}
): ForkResult => {
  const fork = ssh ? url : toHttps(url)
  const upstream = submodule.upstream ?? submodule.url

  if (fork === submodule.url) {
    throw new Error(`${submodule.relativePath} is already checked out from ${fork}.`)
  }
  if (fork === upstream) {
    throw new Error(
      `${fork} is where ${submodule.relativePath} was forked from. ` +
        `Run \`fg-dist unfork ${submodule.name}\` to go back to it.`
    )
  }
  // Before anything is written: a fork nobody can read is a pin nobody can fetch.
  if (attempt(submodule.path, ['ls-remote', '--heads', fork]) === undefined) {
    throw new Error(
      `Could not read ${fork}. Fork ${describeRemote(upstream)} there first, then run this again.`
    )
  }

  // Pushed before anything is recorded, so a refusal leaves the module as it was.
  const branch = distributionBranch(root)
  if (push) pushPinned(submodule, branch, fork)

  gitmodulesSet(root, submodule.configName, 'upstream', upstream)
  setUrl(root, submodule, fork)
  run(submodule.path, ['remote', 'set-url', 'origin', fork])
  ensureUpstreamRemote(submodule.path, upstream)
  attempt(submodule.path, ['fetch', '--quiet', 'origin'])
  attempt(submodule.path, ['fetch', '--quiet', '--tags', UPSTREAM])

  const { name } = moduleLabel(submodule.path)
  noteInDistribution(root, `\`${name}\` forked to ${repositoryLink(fork)}, from ${repositoryLink(upstream)}`)

  return { url: fork, upstream, rewritten: fork !== url, branch: push ? branch : undefined }
}

export interface ContributeOptions {
  /** Push the branch and open the pull request. On by default. */
  push?: boolean
  /** The branch the pull request goes into; defaults to the upstream's own. */
  base?: string
}

export interface ContributeResult {
  branch: string
  /** The repository the pull request is against, and its branch. */
  repository: string
  base: string
  /** The pull request, when `gh` opened one. */
  pullRequest: string | undefined
  /** Where to open it by hand otherwise, on GitHub. */
  compare: string | undefined
  /** The fork's distribution branch, which now holds the pinned commit too. */
  pinnedOn: string | undefined
  /** Whether a line linking the pull request was added to the module's changelog. */
  noted?: boolean
}

/**
 * Add a line linking a pull request to a module's changelog, and commit it,
 * unless it has one already. Only for a module that keeps a changelog.
 */
const noteContribution = (cwd: string, pullRequest: string, title: string): boolean => {
  const file = path.join(cwd, CHANGELOG)
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  if (text.toLowerCase().includes(pullRequest.replace(/^https?:\/\//, '').toLowerCase())) return false
  const version = topVersion(text)
  if (!version) return false
  const number = /\/pull\/(\d+)/.exec(pullRequest)?.[1] ?? '?'
  writeFileSync(file, withEntry(text, version, `${title} ([#${number}](${pullRequest}))`))
  run(cwd, ['add', CHANGELOG])
  run(cwd, ['commit', '--quiet', '-m', `Note #${number} in the changelog`])
  return true
}

/**
 * Offer what is on the checkout's branch upstream, as a pull request.
 *
 * For a fork the branch goes to the fork and the pull request to upstream; for
 * a module you can push to, both go to its own repository. A fork also moves
 * its distribution branch up to the commit, since that is what is pinned and
 * the pull request's branch is gone once merged.
 */
export const contribute = (
  root: string,
  submodule: Submodule,
  { push = true, base }: ContributeOptions = {}
): ContributeResult => {
  const cwd = submodule.path
  const branch = attempt(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!branch) {
    throw new Error(
      `${submodule.relativePath} is not on a branch. Start one for the change:\n` +
        `    cd ${submodule.relativePath} && git switch -c <name>`
    )
  }
  if ((attempt(cwd, ['status', '--porcelain']) ?? '') !== '') {
    throw new Error(`${submodule.relativePath} has uncommitted changes. Commit them first.`)
  }

  const fork = submodule.upstream
  const remote = fork ? UPSTREAM : 'origin'
  const repository = fork ?? submodule.url
  if (fork) {
    ensureUpstreamRemote(cwd, fork)
    attempt(cwd, ['fetch', '--quiet', UPSTREAM])
  }
  const into = base ?? defaultBranch(cwd, remote)
  if (!fork && branch === into) {
    throw new Error(
      `${submodule.relativePath} is on ${into} itself. A pull request needs a branch of its own:\n` +
        `    cd ${submodule.relativePath} && git switch -c <name>`
    )
  }

  const upstreamRepo = githubRepo(repository)
  const ownRepo = githubRepo(submodule.url)
  const head = fork && ownRepo ? `${ownRepo.split('/')[0]}:${branch}` : branch
  const compare = upstreamRepo
    ? `https://github.com/${upstreamRepo}/compare/${into}...${head}?expand=1`
    : undefined

  if (!push) {
    return { branch, repository, base: into, pullRequest: undefined, compare, pinnedOn: undefined }
  }

  run(cwd, ['push', '--quiet', '-u', 'origin', branch])
  const pinnedOn = fork ? distributionBranch(root) : undefined
  if (pinnedOn) pushPinned(submodule, pinnedOn)

  let pullRequest: string | undefined
  if (upstreamRepo) {
    try {
      const output = execFileSync(
        'gh',
        ['pr', 'create', '--repo', upstreamRepo, '--base', into, '--head', head, '--fill'],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
      pullRequest = /https:\/\/\S+/.exec(output)?.[0]
    } catch {
      // No gh, not signed in, or one already open: the compare link does the rest.
      pullRequest = undefined
    }
  }

  // The module's changelog needs a line linking the pull request before it
  // can merge; with the pull request open, its link is known, so add it.
  let noted = false
  if (pullRequest) {
    const title = attempt(cwd, ['log', '-1', '--format=%s'])
    const fromGh = (() => {
      try {
        return execFileSync('gh', ['pr', 'view', pullRequest, '--json', 'title', '--jq', '.title'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        return undefined
      }
    })()
    noted = noteContribution(cwd, pullRequest, fromGh || title || branch)
    if (noted) {
      run(cwd, ['push', '--quiet', 'origin', branch])
      if (pinnedOn) pushPinned(submodule, pinnedOn)
    }
  }

  const { name } = moduleLabel(cwd)
  const number = pullRequest && /\/pull\/(\d+)/.exec(pullRequest)?.[1]
  noteInDistribution(
    root,
    `\`${name}\` ships \`${branch}\` ahead of its next release` +
      (pullRequest && upstreamRepo ? `, offered in [${upstreamRepo}#${number}](${pullRequest})` : '')
  )

  return { branch, repository, base: into, pullRequest, compare, pinnedOn, noted }
}

export interface Integration {
  /** `moved` when upstream's release already had the fork's work, `merged` otherwise. */
  how: 'moved' | 'merged'
  /** What was pushed to the fork: the distribution branch, or the release's tag. */
  pushed: string | undefined
}

/**
 * Take an upstream release into a fork: what `bump` does for one.
 *
 * When the release already has everything the fork adds, the fork is simply
 * moved to it — upstream has taken the work, and the fork could be dropped.
 * Otherwise the release is merged into the fork, keeping the fork's changes on
 * top, and pushed to the distribution branch. A merge rather than a rebase, so
 * every commit an older distribution pinned stays in the fork.
 */
export const integrate = (
  root: string,
  state: SubmoduleState,
  tag: string,
  { push = true }: { push?: boolean } = {}
): Integration => {
  const { submodule } = state
  const cwd = submodule.path
  const upstream = submodule.upstream ?? submodule.url

  const { name } = moduleLabel(cwd)
  const from = state.current ?? state.head.slice(0, 7)
  const notes = releaseNotesUrl(upstream, tag)

  if (containsAll(cwd, `refs/tags/${tag}`, state.head)) {
    moveTo(submodule, tag)
    // The fork may not have the release yet, and it is what is pinned now.
    if (push) run(cwd, ['push', '--quiet', 'origin', `refs/tags/${tag}`])
    noteInDistribution(root, bumpEntry(name, from, tag, notes, 'which has everything the fork added'))
    return { how: 'moved', pushed: push ? tag : undefined }
  }

  try {
    run(cwd, [
      'merge',
      '--no-edit',
      '--quiet',
      '-m',
      `Merge ${tag} from ${describeRemote(upstream)}`,
      `refs/tags/${tag}`,
    ])
  } catch (cause) {
    attempt(cwd, ['merge', '--abort'])
    throw new Error(
      `${tag} does not merge cleanly into ${submodule.relativePath}. Merge it by hand, ` +
        `then push, and commit the new pin:\n    cd ${submodule.relativePath} && git merge ${tag}`,
      { cause }
    )
  }

  const branch = distributionBranch(root)
  if (push) pushPinned(submodule, branch)
  noteInDistribution(root, bumpEntry(name, from, tag, notes, 'merged into the fork'))
  return { how: 'merged', pushed: push ? branch : undefined }
}

export interface UnforkOptions {
  /** What to go back to: an upstream tag, branch or commit. Chosen when omitted. */
  to?: string
  /** Allow going back to a release with a newer major version. */
  major?: boolean
  /** Go back to `to` even when it lacks some of what the fork adds. */
  force?: boolean
}

export interface UnforkResult {
  /** The upstream url the module is checked out from again. */
  url: string
  /** The release or ref it is pinned at. */
  to: string
}

/** Commits the fork has that `base` does not, for saying what would be lost. */
const notIn = (cwd: string, base: string): string[] =>
  (
    attempt(cwd, [
      'log',
      '--no-merges',
      '--cherry-pick',
      '--right-only',
      '--format=%h %s',
      `${base}...HEAD`,
    ]) ?? ''
  )
    .split('\n')
    .filter(Boolean)

/**
 * Check a forked module out from its upstream again.
 *
 * Only to something that has everything the fork adds, unless forced: going
 * back means the fork's commits stop shipping, and that should be because
 * upstream has them, not by accident. Without `to`, the oldest upstream release
 * from the pinned version on that has them is chosen — going back to upstream
 * is not the moment to upgrade as well.
 */
export const unforkModule = (
  root: string,
  state: SubmoduleState,
  { to, major = false, force = false }: UnforkOptions = {}
): UnforkResult => {
  const { submodule } = state
  const cwd = submodule.path
  const upstream = submodule.upstream
  if (!upstream) {
    throw new Error(`${submodule.relativePath} is not a fork; it is checked out from ${submodule.url}.`)
  }
  if (state.dirty) {
    throw new Error(`${submodule.relativePath} has uncommitted changes. Commit or drop them first.`)
  }

  let target: string
  let label: string
  if (to) {
    const ref = [`refs/tags/${to}`, `${UPSTREAM}/${to}`, to].find(
      (candidate) => attempt(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]) !== undefined
    )
    if (!ref) throw new Error(`${to} is not a tag, upstream branch or commit in ${submodule.relativePath}.`)
    const lost = containsAll(cwd, ref, state.head) ? [] : notIn(cwd, ref)
    if (lost.length > 0 && !force) {
      throw new Error(
        `${to} does not have everything the fork adds:\n${lost.map((line) => `  ${line}`).join('\n')}\n` +
          'Pass --force to go back anyway and stop shipping them.'
      )
    }
    target = ref
    label = to
  } else {
    const merged = state.fork?.merged
    if (!merged) {
      const tip = `${UPSTREAM}/HEAD`
      const lost = notIn(cwd, attempt(cwd, ['rev-parse', '--verify', '--quiet', tip]) ? tip : 'HEAD')
      throw new Error(
        `Upstream has not taken everything ${submodule.relativePath} adds yet:\n` +
          `${lost.map((line) => `  ${line}`).join('\n')}\n` +
          'Keep the fork until it has, or pass --to <tag> --force to go back without them.'
      )
    }
    if (!semver.valid(merged)) {
      throw new Error(
        `Only ${merged} has everything ${submodule.relativePath} adds, and it is not a release yet. ` +
          `Wait for one, or pass --to ${merged.replace(`${UPSTREAM}/`, '')} to go back to the branch.`
      )
    }
    if (!major && state.current && semver.major(merged) !== semver.major(state.current)) {
      throw new Error(
        `The first release with everything ${submodule.relativePath} adds is ${merged}, a major ` +
          'upgrade. Pass --major to go back to it.'
      )
    }
    target = `refs/tags/${merged}`
    label = merged
  }

  const lost = containsAll(cwd, target, state.head) ? [] : notIn(cwd, target)
  run(cwd, ['checkout', '--quiet', `${target}^{commit}`])
  setUrl(root, submodule, upstream)
  run(cwd, ['remote', 'set-url', 'origin', upstream])
  gitmodulesSet(root, submodule.configName, 'upstream', undefined)
  attempt(cwd, ['remote', 'remove', UPSTREAM])

  const { name } = moduleLabel(cwd)
  const notes = semver.valid(label) ? releaseNotesUrl(upstream, label) : undefined
  noteInDistribution(
    root,
    `\`${name}\` back to ${repositoryLink(upstream)} at ${shown(label)}, ` +
      (lost.length > 0
        ? `leaving behind ${lost.length} commit${lost.length === 1 ? '' : 's'} of the fork's that upstream does not have`
        : 'which has everything the fork added') +
      (notes ? ` ([release notes](${notes}))` : '')
  )

  return { url: upstream, to: label }
}
