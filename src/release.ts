import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { isPublic } from './canary.ts'
import { writeReadmes } from './readme.ts'
import { isDistribution } from './submodules.ts'

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

/** Run git for effect, letting a failure surface. */
const run = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
}

export class ReleaseError extends Error {}

export interface Branch {
  branch: string
  version: string
}

export interface ReleasePlan {
  /** The version that has just been released, read from the manifest. */
  released: string
  /**
   * Where fixes to the released version go. Undefined for a prerelease, which
   * has nothing to maintain.
   */
  maintenance: Branch | undefined
  /** The bump that main takes, opened as a pull request. */
  next: Branch
  /** What the maintenance branch is cut from: the release tag, or HEAD. */
  base: string
  /** Whether {@link base} is the release tag rather than wherever HEAD is. */
  tagged: boolean
}

const maintenanceBranch = (version: semver.SemVer): string =>
  `v${version.major}-${version.minor}`

/**
 * Work out the two branches a release leaves behind.
 *
 * Main always carries the next unreleased version, so the release is the
 * moment main moves on: once 1.6.0 is published, main becomes 1.7.0 and 1.6.x
 * continues on its own branch, starting at the patch nobody has written yet.
 */
export type Bump = 'patch' | 'minor' | 'major'

/**
 * Work out what a release leaves behind.
 *
 * Main always carries the next unreleased version, so the release is the moment
 * main moves on. Which way it moves is a decision nobody else can make: a minor
 * is the usual answer, a major says something was removed or changed meaning,
 * and a patch says this branch *is* the line and stays on it.
 */
export const planRelease = (
  released: string,
  { bump, id }: { bump?: Bump; id?: string } = {}
): Omit<ReleasePlan, 'base' | 'tagged'> => {
  const parsed = semver.parse(released)
  if (!parsed) {
    throw new ReleaseError(`\`${released}\` is not a version this can release.`)
  }

  // A prerelease is not a line anyone maintains — there is no 2.0.0-alpha.0
  // that someone is still running and needs a fix for — so it only moves
  // forward, along its own identifier or on to the next one.
  if (parsed.prerelease.length > 0) {
    // Without an identifier, carry on with the one the version already has.
    // Defaulting to `alpha` would take 2.0.0-beta.2 back to 2.0.0-alpha.0,
    // which is lower than what is already published.
    const carries = String(parsed.prerelease[0])
    const next =
      !id || id === carries
        ? semver.inc(released, 'prerelease')
        : semver.inc(released, 'prerelease', id)
    if (!next) throw new ReleaseError(`Cannot advance \`${released}\`.`)

    if (semver.lte(next, released)) {
      throw new ReleaseError(
        `Moving ${released} to ${next} would go backwards. ` +
          `\`${carries}\` is already past \`${id}\`.`
      )
    }
    return {
      released,
      maintenance: undefined,
      next: { branch: releaseBranch(next), version: next },
    }
  }

  if (!bump) {
    throw new ReleaseError(
      `Say which way ${released} moves on: --patch, --minor or --major. ` +
        'Run with --dry-run to see what each would do.'
    )
  }

  const nextVersion = semver.inc(released, bump)
  if (!nextVersion) throw new ReleaseError(`Cannot take the next ${bump} after ${released}.`)

  return {
    released,
    // A patch means this branch is the line that carries it, so it keeps going
    // rather than handing off to a branch behind it. A minor or major means
    // main leaves this line, and something has to stay behind for its fixes.
    maintenance:
      bump === 'patch'
        ? undefined
        : {
            branch: maintenanceBranch(parsed),
            version: `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`,
          },
    next: { branch: releaseBranch(nextVersion), version: nextVersion },
  }
}

export interface PrereleasePlan {
  /** The version the branch is cut to carry. */
  version: string
  /** The branch it lives on, which becomes that line's branch if it ships. */
  branch: string
  /** The version on the branch this was cut from, which keeps going. */
  from: string
}

/**
 * Start the next line early, without main leaving the current one.
 *
 * Main is at 1.6.0 and still has 1.6.x and 1.7.0 to ship; 2.0.0 can be worked
 * on anyway, on a branch of its own, published under a dist tag of its own.
 * Nothing here touches main — that is the point.
 */
export const planPrerelease = (
  current: string,
  { bump, id = 'alpha' }: { bump: Exclude<Bump, 'patch'>; id?: string }
): PrereleasePlan => {
  const parsed = semver.parse(current)
  if (!parsed) {
    throw new ReleaseError(`\`${current}\` is not a version to branch from.`)
  }
  if (parsed.prerelease.length > 0) {
    throw new ReleaseError(
      `${current} is already a prerelease. Move it along with \`fg-dist release\` instead.`
    )
  }

  const version = semver.inc(current, bump === 'major' ? 'premajor' : 'preminor', id)
  if (!version) throw new ReleaseError(`Cannot start a ${bump} prerelease after ${current}.`)

  const next = semver.parse(version)!
  // The same name the line would get as a maintenance branch, because it is
  // the same line: if it ships from here, this is where its fixes go.
  const branch =
    bump === 'major' ? `v${next.major}` : `v${next.major}-${next.minor}`

  return { version, branch, from: current }
}

const releaseBranch = (version: string): string => `release/v${version}`

const manifestPath = (root: string): string => path.join(root, 'package.json')

const readVersion = async (root: string): Promise<string> => {
  const raw = await readFile(manifestPath(root), 'utf8').catch(() => undefined)
  if (!raw) throw new ReleaseError('No package.json here. Run this inside a module.')
  const version = JSON.parse(raw).version
  if (typeof version !== 'string') {
    throw new ReleaseError('package.json has no version to release.')
  }
  return version
}

/**
 * Set the version in package.json, leaving the rest of the file untouched.
 *
 * Spliced rather than re-serialised: a manifest carries key order, comments in
 * some tools, and whatever indentation the repository settled on, and a
 * release is no occasion to reformat it.
 */
export const setVersion = (source: string, version: string): string => {
  // What the manifest actually parses to. Everything below is about finding
  // where *that* value is written, rather than the first thing shaped like it:
  // a `volta` or `engines` block can hold a "version" key of its own, and can
  // sit above the real one.
  const current = JSON.parse(source).version
  if (typeof current !== 'string') {
    throw new ReleaseError('package.json has no version field to set.')
  }

  const online = [
    ...source.matchAll(/^([ \t]*)"version"([ \t]*):([ \t]*)"([^"]*)"/gm),
  ]
    .filter((match) => match[4] === current)
    // Shallowest indentation is the top level. A nested key holding the same
    // string is indented further, by any formatter anyone actually uses.
    .sort((a, b) => a[1].length - b[1].length)

  const match = online[0]
  if (match) {
    return (
      source.slice(0, match.index) +
      `${match[1]}"version"${match[2]}:${match[3]}"${version}"` +
      source.slice(match.index + match[0].length)
    )
  }

  // Written on one line, so there are no indents to compare. Anchor on the
  // value, which is the best this can do without a JSON parser that records
  // where it read things.
  const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const inline = new RegExp(`"version"(\\s*):(\\s*)"${escaped}"`).exec(source)
  if (!inline) throw new ReleaseError('package.json has no version field to set.')

  return (
    source.slice(0, inline.index) +
    `"version"${inline[1]}:${inline[2]}"${version}"` +
    source.slice(inline.index + inline[0].length)
  )
}

const writeVersion = async (root: string, version: string): Promise<void> => {
  const source = await readFile(manifestPath(root), 'utf8')
  await writeFile(manifestPath(root), setVersion(source, version))
}

/** A distribution is versioned by date and releases by moving submodule pins. */
const assertModule = (root: string): void => {
  if (isDistribution(root)) {
    throw new ReleaseError(
      'This is a distribution, not a module. A distribution is versioned by date; ' +
        'release its modules individually, then `fg-dist bump` to take them.'
    )
  }
}

/** Read the release the repository is standing on, without changing anything. */
export const readRelease = async (
  root: string,
  { bump, id }: { bump?: Bump; id?: string } = {}
): Promise<ReleasePlan> => {
  assertModule(root)

  const released = await readVersion(root)
  const plan = planRelease(released, { bump, id })

  const tag = `v${released}`
  const tagged = git(root, ['rev-parse', '--verify', `refs/tags/${tag}`]) !== undefined

  return { ...plan, base: tagged ? tag : 'HEAD', tagged }
}

export interface ReleaseOptions {
  /** Which way main moves on. Required, unless this is a prerelease. */
  bump?: Bump
  /** Prerelease identifier, for moving alpha to beta to rc. */
  id?: string
  dryRun?: boolean
  /** Push the branches and open the pull request. On by default. */
  push?: boolean
}

export interface ReleaseOutcome {
  plan: ReleasePlan
  /** The branch this was released from, which the pull request is against. */
  base: string
  /** Branches that were created, in the order they were created. */
  created: string[]
  pushed: boolean
  /** The pull request, when `gh` was there to open one. */
  pullRequest: string | undefined
}

const currentBranch = (root: string): string | undefined => {
  const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return name === 'HEAD' ? undefined : name
}

const isDirty = (root: string): boolean =>
  (git(root, ['status', '--porcelain']) ?? '') !== ''

const branchExists = (root: string, branch: string): boolean =>
  git(root, ['rev-parse', '--verify', `refs/heads/${branch}`]) !== undefined

/** Record the version in the readme, so it is visible where people browse. */
const recordVersion = async (root: string): Promise<void> => {
  await writeReadmes(root)
}

const commitAll = (root: string, message: string): void => {
  run(root, ['add', '-A'])
  run(root, ['commit', '-m', message])
}

/**
 * Move a module on from the release it has just published.
 *
 * Two branches come out of it: `v1-6` where 1.6.x is maintained, and a pull
 * request moving main to 1.7.0. The pull request is where main's bump gets
 * reviewed like any other change; the maintenance branch is not a proposal, so
 * it is just pushed.
 */
export const release = async (
  root: string,
  { bump, id, dryRun = false, push = true }: ReleaseOptions = {}
): Promise<ReleaseOutcome> => {
  const plan = await readRelease(root, { bump, id })

  if (dryRun) return { plan, base: currentBranch(root) ?? 'HEAD', created: [], pushed: false, pullRequest: undefined }

  // Both branches are cut from what is committed, and the bumps are committed
  // on top. Anything already in the working tree would be swept into them.
  if (isDirty(root)) {
    throw new ReleaseError(
      'The working tree has uncommitted changes. Commit or stash them before releasing.'
    )
  }

  const startedOn = currentBranch(root)
  if (!startedOn) {
    throw new ReleaseError('HEAD is detached. Check out the branch you release from.')
  }

  for (const branch of [plan.maintenance?.branch, plan.next.branch]) {
    if (branch && branchExists(root, branch)) {
      throw new ReleaseError(`Branch \`${branch}\` already exists. Delete it or pick another version.`)
    }
  }

  const created: string[] = []

  try {
    if (plan.maintenance) {
      // Cut from the tag where possible: main may have moved on since the
      // release, and those commits are not part of 1.6.x.
      run(root, ['checkout', '-b', plan.maintenance.branch, plan.base])
      created.push(plan.maintenance.branch)
      await writeVersion(root, plan.maintenance.version)
      await recordVersion(root)
      commitAll(root, `Open ${plan.maintenance.version} for maintenance`)
    }

    run(root, ['checkout', '-b', plan.next.branch, startedOn])
    created.push(plan.next.branch)
    await writeVersion(root, plan.next.version)
    await recordVersion(root)
    commitAll(root, `Bump to ${plan.next.version}`)
  } catch (error) {
    // Leave the branches for inspection rather than unwinding half a release,
    // but not the edits: a commit that failed on a hook or a missing identity
    // leaves them staged, and checking out would carry them onto main. The
    // tree was clean on the way in, so everything here is ours to drop.
    git(root, ['reset', '--hard', 'HEAD'])
    git(root, ['checkout', startedOn])
    throw error
  }

  if (!push) {
    git(root, ['checkout', startedOn])
    return { plan, base: startedOn, created, pushed: false, pullRequest: undefined }
  }

  // A push can fail for reasons that have nothing to do with the release — no
  // origin, expired credentials, a branch already on the remote. The branches
  // are made either way, so put the checkout back before the failure leaves
  // someone standing somewhere they did not ask to be.
  let pullRequest: string | undefined
  try {
    for (const branch of created) {
      run(root, ['push', '-u', 'origin', branch])
    }
    pullRequest = openPullRequest(root, plan, startedOn)
  } catch (error) {
    // The branches are made and committed, so a rerun would only say they
    // already exist. Say what is left to do instead.
    throw new ReleaseError(
      `${error instanceof Error ? error.message : String(error)}\n\n` +
        'The branches are made; only the push failed. Finish it with:\n' +
        created.map((branch) => `    git push -u origin ${branch}`).join('\n')
    )
  } finally {
    git(root, ['checkout', startedOn])
  }

  return { plan, base: startedOn, created, pushed: true, pullRequest }
}

const openPullRequest = (
  root: string,
  plan: ReleasePlan,
  base: string
): string | undefined => {
  const body = [
    `\`${plan.released}\` is released. This moves ${base} on to the next unreleased version.`,
    '',
    plan.maintenance
      ? `Fixes to \`${plan.released}\` go to \`${plan.maintenance.branch}\`, which starts at \`${plan.maintenance.version}\`.`
      : 'No maintenance branch: a prerelease has no line to maintain.',
  ].join('\n')

  try {
    return execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        base,
        '--head',
        plan.next.branch,
        '--title',
        `Bump to ${plan.next.version}`,
        '--body',
        body,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  } catch {
    // gh is not everywhere, and not having it should not undo a good release.
    return undefined
  }
}

export interface Releasable {
  name: string
  version: string
  tag: string
  /** Whether npm will generate provenance; it refuses for restricted packages. */
  provenance: boolean
}

/**
 * Check that the version in the manifest is one that can be released.
 *
 * Main is meant to carry the next unreleased version, so finding that version
 * already on npm means {@link release} has not run since the last one — and
 * publishing would either fail or, worse, succeed as a republish.
 */
export const checkReleasable = async (
  root: string,
  { published }: { published?: (spec: string) => string | undefined } = {}
): Promise<Releasable> => {
  const raw = await readFile(manifestPath(root), 'utf8').catch(() => undefined)
  if (!raw) throw new ReleaseError('No package.json here. Run this inside a module.')

  const manifest = JSON.parse(raw)
  const { name, version } = manifest
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new ReleaseError('package.json needs a name and a version to release.')
  }

  const tag = `v${version}`

  // The workflow tags after it publishes, so a tag that is already here means
  // a red job *after* an irreversible publish — and a later release would cut
  // its maintenance branch from whatever that stale tag points at.
  if (git(root, ['rev-parse', '--verify', `refs/tags/${tag}`])) {
    throw new ReleaseError(
      `${tag} already exists here. Either ${version} has been released, or the ` +
        'tag was written before it was. Move on to the next version first.'
    )
  }

  const lookup = published ?? onNpm
  if (lookup(`${name}@${version}`)) {
    // Published but untagged is where a release job that died between the two
    // ends up. Rerunning cannot publish again, so the tag is all that is left.
    throw new ReleaseError(
      `${name}@${version} is already on npm, and ${tag} does not exist here.\n` +
        'If the release job failed after publishing, only the tag is missing:\n' +
        `    git tag ${tag} <the published commit> && git push origin ${tag}\n` +
        'Otherwise run `fg-dist release` to move on to the next version.'
    )
  }

  return { name, version, tag, provenance: isPublic(manifest) }
}

/** Whether npm has this exact version, as opposed to having no opinion. */
const onNpm = (spec: string): string | undefined => {
  try {
    const value = execFileSync('npm', ['view', spec, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return value === '' ? undefined : value
  } catch {
    // No such version, or no registry to ask. Neither blocks a release: npm
    // itself refuses a duplicate, so this check is a clearer message, not the
    // guard of last resort.
    return undefined
  }
}

/** Hand the version to the workflow steps that tag and publish it. */
export const reportToActions = async (releasable: Releasable): Promise<void> => {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  await appendFile(
    output,
    `version=${releasable.version}\n` +
      `tag=${releasable.tag}\n` +
      `provenance=${releasable.provenance ? 'true' : 'false'}\n`
  )
}

export interface PrereleaseOutcome {
  plan: PrereleasePlan
  created: boolean
  pushed: boolean
}

/**
 * Cut a branch carrying the next line, and leave main where it is.
 *
 * No pull request: this is not a change to the branch you are on, it is a
 * second line starting beside it. Main goes on releasing what it was
 * releasing, and this one publishes under a dist tag of its own until it is
 * ready to become `latest`.
 */
export const startPrerelease = async (
  root: string,
  {
    bump,
    id = 'alpha',
    dryRun = false,
    push = true,
  }: {
    bump: Exclude<Bump, 'patch'>
    id?: string
    dryRun?: boolean
    push?: boolean
  }
): Promise<PrereleaseOutcome> => {
  assertModule(root)

  const current = await readVersion(root)
  const plan = planPrerelease(current, { bump, id })

  if (dryRun) return { plan, created: false, pushed: false }

  if (isDirty(root)) {
    throw new ReleaseError(
      'The working tree has uncommitted changes. Commit or stash them before branching.'
    )
  }

  const startedOn = currentBranch(root)
  if (!startedOn) {
    throw new ReleaseError('HEAD is detached. Check out the branch you are branching from.')
  }
  if (branchExists(root, plan.branch)) {
    throw new ReleaseError(
      `Branch \`${plan.branch}\` already exists. That line has been started; ` +
        'check it out and use `fg-dist release` to move it along.'
    )
  }

  try {
    run(root, ['checkout', '-b', plan.branch, startedOn])
    await writeVersion(root, plan.version)
    await recordVersion(root)
    commitAll(root, `Start ${plan.version}`)
  } catch (error) {
    git(root, ['reset', '--hard', 'HEAD'])
    git(root, ['checkout', startedOn])
    throw error
  }

  if (!push) {
    git(root, ['checkout', startedOn])
    return { plan, created: true, pushed: false }
  }

  try {
    run(root, ['push', '-u', 'origin', plan.branch])
  } finally {
    git(root, ['checkout', startedOn])
  }

  return { plan, created: true, pushed: true }
}
