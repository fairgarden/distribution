import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'

/** Ask npm about a published version, returning undefined when it says nothing. */
const view = (spec: string, field: string): string | undefined => {
  try {
    const value = execFileSync('npm', ['view', spec, field], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return value === '' ? undefined : value
  } catch {
    // Not published yet, or no registry to ask. Either way there is no
    // previous canary, which is the same thing as far as the next one goes.
    return undefined
  }
}

/** What is on the `canary` tag now. */
export interface Published {
  version?: string
  gitSha?: string
}

/**
 * The next canary version.
 *
 * The suffix counts this canary's position within its own release cycle, read
 * from the registry. A CI run counter would look similar and be wrong: it skips
 * numbers whenever a run fails or deduplicates, which makes published versions
 * a record of workflow bookkeeping rather than of releases.
 */
export const nextCanary = (version: string, published: string | undefined): string => {
  const parsed = semver.parse(version)
  if (!parsed) throw new Error(`\`${version}\` is not a version to build a canary from.`)

  // A canary has to sort below every real version of what it is building
  // towards, or somebody's range resolves to one.
  //
  // The familiar `1.7.0-canary.3` shape only half does that. It is below 1.7.0,
  // but `canary` is above `alpha` and `beta` as a string, so while main sits at
  // 2.0.0 with 2.0.0-beta.2 published, a consumer on `^2.0.0-beta.2` gets the
  // canary. Naming it after the prerelease it follows fails the same way from
  // the other side.
  //
  // Semver ranks numeric identifiers below alphanumeric ones, so a numeric
  // first identifier is the one slot beneath all of them: `2.0.0-0.canary.3` is
  // below alpha, beta, rc and anything else anyone names, which puts it under
  // the floor of every prerelease range. One shape for every target, so there
  // is no case where this is nearly right.
  const prefix = `${parsed.major}.${parsed.minor}.${parsed.patch}-0.canary.`

  // Counted from what is on the tag rather than from a CI run number, which
  // skips whenever a run fails or deduplicates. The prefix ignores the
  // prerelease, so the count carries on across alpha, beta and the release
  // itself instead of restarting at each one.
  const count =
    published && published.startsWith(prefix)
      ? Number(published.slice(prefix.length)) + 1
      : 0

  return `${prefix}${Number.isFinite(count) ? count : 0}`
}

export interface CanaryResult {
  name: string
  /**
   * Whether npm will generate provenance for this package. It refuses to for
   * anything not published publicly, and refusing is a failed publish.
   */
  provenance: boolean
  /** The version written into the manifest, or the one already published. */
  version: string
  /** True when this commit is already on the canary tag, so there is nothing to do. */
  skip: boolean
  sha: string
}

export interface CanaryOptions {
  /** The commit being built. Defaults to `GITHUB_SHA`. */
  sha?: string
  /** What is on the canary tag. Defaults to asking npm. */
  published?: Published
  /** Work out the version and report it, without touching the manifest. */
  dryRun?: boolean
}

/**
 * Stamp a canary version into the manifest, ready to publish.
 *
 * Returns without writing when the canary tag already points at this commit,
 * which is what makes a nightly build with nothing new a no-op rather than a
 * version bump.
 */
export const stampCanary = async (
  root: string,
  { sha = process.env.GITHUB_SHA ?? '', published, dryRun = false }: CanaryOptions = {}
): Promise<CanaryResult> => {
  const file = path.join(root, 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))

  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('package.json needs a name and a version to stamp a canary.')
  }

  const current =
    published ??
    ({
      version: view(`${manifest.name}@canary`, 'version'),
      gitSha: view(`${manifest.name}@canary`, 'gitSha'),
    } satisfies Published)

  const provenance = isPublic(manifest)

  if (sha && current.gitSha === sha) {
    return {
      name: manifest.name,
      version: current.version ?? '',
      skip: true,
      provenance,
      sha,
    }
  }

  const version = nextCanary(manifest.version, current.version)

  if (!dryRun) {
    await writeFile(
      file,
      `${JSON.stringify({ ...manifest, version, gitSha: sha }, null, 2)}\n`
    )
  }

  return { name: manifest.name, version, skip: false, provenance, sha }
}

/** Hand a result to the workflow step that decides whether to publish. */
export const reportToActions = async (result: CanaryResult): Promise<void> => {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return

  await appendFile(
    output,
    `version=${result.version}\n` +
      `skip=${result.skip ? 'true' : 'false'}\n` +
      `provenance=${result.provenance ? 'true' : 'false'}\n`
  )
}

/**
 * Whether a manifest publishes publicly.
 *
 * npm generates provenance only for public packages, and asking for it on a
 * restricted one fails the publish. A scoped package is restricted unless it
 * says otherwise, which is why the default here is the pessimistic one.
 */
export const isPublic = (manifest: {
  name?: unknown
  private?: unknown
  publishConfig?: unknown
}): boolean => {
  if (manifest.private === true) return false

  const access = (manifest.publishConfig as { access?: unknown } | undefined)?.access
  if (access === 'public') return true
  if (access === 'restricted') return false

  // Unscoped packages are public; scoped ones are not, unless told to be.
  return typeof manifest.name === 'string' && !manifest.name.startsWith('@')
}
