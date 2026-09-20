import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { submodules } from './submodules.ts'

/**
 * A distribution is a manifest: its dependencies are the modules it ships, each
 * pinned to a version. End users consume the distribution, which is versioned
 * by date; developers consume the modules, which are versioned by semver.
 *
 * One distribution may extend another. The extension ships the parent's modules
 * and may move ahead of it, but can never ship a module older than the parent
 * does — otherwise "extends" would mean shipping a regression.
 */

export interface Distribution {
  name: string
  version: string
  /** Module name to the version range this distribution ships. */
  modules: Record<string, string>
  /** The distribution this one extends, when it extends one. */
  extends: string | undefined
}

interface PackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  distribution?: { extends?: string }
}

const readPackageJson = (file: string): PackageJson =>
  JSON.parse(readFileSync(file, 'utf8')) as PackageJson

/**
 * The modules a repository ships, read from the submodules themselves.
 *
 * Nothing is pinned in the distribution repository: the submodule commit is the
 * pin, and the version is whatever the package.json inside that checkout says.
 * pnpm links the checkout into the workspace, so that is also the version
 * everything here resolves against.
 */
const modulesFromSubmodules = (root: string): Record<string, string> | undefined => {
  const found = submodules(root)
  if (found.length === 0) return undefined

  const modules: Record<string, string> = {}
  for (const submodule of found) {
    try {
      const pkg = readPackageJson(path.join(submodule.path, 'package.json'))
      if (pkg.name && pkg.version) modules[pkg.name] = pkg.version
    } catch {
      // A submodule that was never cloned has nothing to read.
      continue
    }
  }

  return Object.keys(modules).length > 0 ? modules : undefined
}

/**
 * Read a distribution.
 *
 * In a repository the modules come from the submodules. A published
 * distribution has no submodules, so its manifest carries the versions it
 * shipped, which is what an extension is compared against.
 */
export const readDistribution = (root: string): Distribution => {
  const pkg = readPackageJson(path.join(root, 'package.json'))
  const parent = pkg.distribution?.extends

  const declared = { ...pkg.dependencies }
  // The parent is a dependency too, but it is not one of the modules.
  if (parent) delete declared[parent]
  // Workspace links say "whatever the checkout is", not a version.
  for (const [name, range] of Object.entries(declared)) {
    if (range.startsWith('workspace:') || range.startsWith('link:')) delete declared[name]
  }

  return {
    name: pkg.name ?? path.basename(root),
    version: pkg.version ?? '0.0.0',
    modules: modulesFromSubmodules(root) ?? declared,
    extends: parent,
  }
}

/**
 * The parent's manifest, read from node_modules.
 *
 * A distribution is published, so the parent is an ordinary dependency and
 * whatever version is installed is the one being extended.
 */
export const readParent = (
  root: string,
  parent: string
): Distribution | undefined => {
  const require = createRequire(path.join(root, 'package.json'))
  try {
    const manifest = require.resolve(`${parent}/package.json`)
    return readDistribution(path.dirname(manifest))
  } catch {
    return undefined
  }
}

export interface FloorViolation {
  module: string
  /** What the parent ships, which is the floor. */
  parent: string
  /** What this distribution ships, or undefined when it ships none. */
  ours: string | undefined
  reason: 'behind' | 'missing'
}

/**
 * The lowest version a range allows, which is what a floor compares.
 *
 * `minVersion` throws on anything that is not a range — `latest`, a git url, a
 * dist-tag — so this returns undefined for those rather than taking the whole
 * check down with it.
 */
const lowest = (range: string): string | undefined => {
  try {
    return semver.minVersion(range, { loose: true })?.version
  } catch {
    return undefined
  }
}

/**
 * Modules this distribution ships older than its parent, or not at all.
 *
 * Ranges are compared by the lowest version they allow, since that is the
 * oldest thing the distribution could resolve to.
 */
export const findFloorViolations = (
  ours: Distribution,
  parent: Distribution
): FloorViolation[] => {
  const violations: FloorViolation[] = []

  for (const [module, parentRange] of Object.entries(parent.modules)) {
    const ourRange = ours.modules[module]

    if (ourRange === undefined) {
      violations.push({
        module,
        parent: parentRange,
        ours: undefined,
        reason: 'missing',
      })
      continue
    }

    const ourFloor = lowest(ourRange)
    const parentFloor = lowest(parentRange)
    // Anything unparseable is left alone rather than guessed at.
    if (!ourFloor || !parentFloor) continue

    if (semver.lt(ourFloor, parentFloor)) {
      violations.push({
        module,
        parent: parentRange,
        ours: ourRange,
        reason: 'behind',
      })
    }
  }

  return violations
}

export interface ExtendsReport {
  distribution: Distribution
  parent: Distribution | undefined
  violations: FloorViolation[]
  /** Set when a parent is declared but could not be read. */
  unresolved: string | undefined
}

export const inspectExtends = (root: string): ExtendsReport => {
  const distribution = readDistribution(root)

  if (!distribution.extends) {
    return { distribution, parent: undefined, violations: [], unresolved: undefined }
  }

  const parent = readParent(root, distribution.extends)
  if (!parent) {
    return {
      distribution,
      parent: undefined,
      violations: [],
      unresolved: distribution.extends,
    }
  }

  return {
    distribution,
    parent,
    violations: findFloorViolations(distribution, parent),
    unresolved: undefined,
  }
}

export const describeViolations = (report: ExtendsReport): string => {
  const { distribution, parent, violations } = report
  const lines = violations.map((violation) =>
    violation.reason === 'missing'
      ? `  ${violation.module} is not shipped, but ${parent?.name} ships ${violation.parent}`
      : `  ${violation.module} ${violation.ours} is older than the ${violation.parent} ${parent?.name} ships`
  )

  return [
    `${distribution.name} extends ${parent?.name}, so it cannot ship anything older:`,
    ...lines,
    'An extension may move ahead of what it extends, never behind it.',
  ].join('\n')
}

/** Throw when this distribution ships something older than its parent. */
export const assertExtends = (root: string): void => {
  const report = inspectExtends(root)
  if (report.violations.length > 0) throw new Error(describeViolations(report))
}
