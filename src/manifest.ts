import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { calendarVersion } from './scaffold.ts'
import { submodules, uninitialised } from './submodules.ts'

/**
 * What a published distribution says it ships.
 *
 * In the repository the submodules are the record, and nothing restates them.
 * A published distribution has no submodules, so its manifest carries them —
 * written into `distribution.modules` as it is published, never committed.
 * That is what an extension is checked against, and what it takes its own
 * modules from.
 */
export interface PublishedModule {
  version: string
  /** Where it sits in the distribution, which an extension puts it at too. */
  path: string
  /** What it is cloned from: the fork, for a module the distribution forked. */
  repository: string
  /** Where a fork was forked from. */
  upstream?: string
  /** The commit shipped, which may be ahead of the version's release. */
  commit: string
}

export type PublishedModules = Record<string, PublishedModule>

/** What this distribution ships, read from its checkouts. */
export const shippedModules = (root: string): PublishedModules => {
  const missing = uninitialised(root)
  if (missing.length > 0) {
    throw new Error(
      `These modules are not checked out, so what they are cannot be recorded: ${missing.join(', ')}. ` +
        'Publish from a clone with its submodules (actions/checkout: `submodules: true`).'
    )
  }

  const modules: PublishedModules = {}
  for (const submodule of submodules(root)) {
    let pkg: { name?: unknown; version?: unknown }
    try {
      pkg = JSON.parse(readFileSync(path.join(submodule.path, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
    modules[pkg.name] = {
      version: pkg.version,
      path: submodule.relativePath,
      repository: submodule.url,
      ...(submodule.upstream ? { upstream: submodule.upstream } : {}),
      commit: submodule.pinned,
    }
  }
  return modules
}

/**
 * A version npm will take as it is.
 *
 * A distribution is versioned by date, and `2026.09.26` is not semver — npm
 * would publish it as `2026.9.26` anyway — so it is written that way to begin
 * with, and the registry and the manifest spell it the same.
 */
export const publishableVersion = (version: string): string => {
  const cleaned = semver.clean(version, { loose: true })
  if (!cleaned) {
    throw new Error(`${version} is not a version npm can publish; a distribution's is its date, like 2026.9.26.`)
  }
  return cleaned
}

/** Today's date as a distribution's version. */
export const releaseVersion = (on: Date = new Date()): string => calendarVersion(on)

/**
 * Write what the distribution ships into its manifest, ready to publish.
 *
 * For CI, before `npm publish`: the repository's manifest is left without it,
 * since the submodules already say it.
 */
export const stampModules = async (
  root: string,
  fields: { version?: string; gitSha?: string } = {}
): Promise<PublishedModules> => {
  const file = path.join(root, 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  const modules = shippedModules(root)
  await writeFile(
    file,
    `${JSON.stringify(
      {
        ...manifest,
        ...fields,
        distribution: { ...manifest.distribution, modules },
      },
      null,
      2
    )}\n`
  )
  return modules
}

/**
 * The modules a published distribution records, with where each lives, or
 * undefined when it records none: published before this was written down.
 */
export const readPublishedModules = (manifest: {
  distribution?: { modules?: unknown }
}): PublishedModules | undefined => {
  const modules = manifest.distribution?.modules
  if (!modules || typeof modules !== 'object') return undefined
  const entries = Object.entries(modules as Record<string, Partial<PublishedModule>>).filter(
    ([, module]) =>
      typeof module?.version === 'string' &&
      typeof module.path === 'string' &&
      typeof module.repository === 'string' &&
      typeof module.commit === 'string'
  )
  return Object.fromEntries(entries) as PublishedModules
}
