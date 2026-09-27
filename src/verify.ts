import path from 'node:path'
import { isDistribution } from './submodules.ts'
import { writeReadmes } from './readme.ts'
import { writeOverrides } from './overrides.ts'
import { findPolicy, setupTurbo } from './policy.ts'
import { describeViolations, inspectExtends } from './extends.ts'

/**
 * Check that what fg-dist writes into a repository still says what is true.
 *
 * Each of these files is written from something else — a readme from the
 * manifests and the pins, the workspace overrides from the modules, turbo's
 * tasks from the policy — and goes stale the moment that something moves
 * without it. Nothing notices by looking: a stale version in a readme reads
 * exactly like a current one. So CI compares each with what would be written
 * now, and names the command that brings it back.
 *
 * Only what this repository can fix is checked. A distribution's readme is
 * checked, its modules' readmes are not: they are checked in the modules' own
 * CI, and a pinned commit cannot be changed from here.
 */

export interface Verification {
  /** What was checked, as the file it is about. */
  what: string
  ok: boolean
  /** What is wrong, when it is. */
  problem?: string
  /** The command that puts it right. */
  fix?: string
}

const failure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const readme = async (root: string): Promise<Verification> => {
  try {
    const { updates, kind } = await writeReadmes(root, { check: true, modules: false })
    const stale = updates.filter((update) => update.changed)
    const named = (list: typeof updates): string =>
      list.map((update) => path.relative(root, update.file)).join(', ') || 'readme'
    return stale.length === 0
      ? { what: named(updates), ok: true }
      : {
          what: named(stale),
          ok: false,
          problem:
            kind === 'module'
              ? 'does not say what package.json does'
              : 'does not say what package.json and the pinned modules do',
          fix: 'pnpm dist readme',
        }
  } catch (error) {
    return { what: 'readme', ok: false, problem: failure(error) }
  }
}

const overrides = async (root: string): Promise<Verification> => {
  try {
    const { file, changed, missing } = await writeOverrides(root, { check: true })
    const what = path.relative(root, file)
    if (missing) return { what, ok: false, problem: 'is missing; a distribution needs one to override its modules' }
    return changed
      ? { what, ok: false, problem: 'does not override every module to its checkout', fix: 'pnpm dist overrides' }
      : { what, ok: true }
  } catch (error) {
    return { what: 'pnpm-workspace.yaml', ok: false, problem: failure(error) }
  }
}

const policy = (root: string): Verification | undefined => {
  const found = findPolicy(root)
  // Found by walking up, so from a module inside a distribution it is that
  // distribution's — which is not this repository's to check.
  if (!found || path.resolve(found.root) !== path.resolve(root)) return undefined
  try {
    const differ = setupTurbo(found, { check: true })
    return differ.length === 0
      ? { what: 'turbo.json', ok: true }
      : {
          what: 'turbo.json',
          ok: false,
          problem: `does not build the policy before what uses it: ${differ.join(', ')}`,
          fix: 'pnpm dist policy setup',
        }
  } catch (error) {
    return { what: 'turbo.json', ok: false, problem: failure(error) }
  }
}

const floor = (root: string): Verification | undefined => {
  const report = inspectExtends(root)
  if (!report.distribution.extends) return undefined
  const what = `extends ${report.distribution.extends}`
  if (report.unresolved) {
    return { what, ok: false, problem: `${report.unresolved} is not installed, so nothing could be compared`, fix: 'pnpm install' }
  }
  return report.violations.length === 0
    ? { what, ok: true }
    : // It names its own fix, which depends on what is behind.
      { what, ok: false, problem: describeViolations(report) }
}

/** Every check that applies to this repository, in the order they are reported. */
export const verify = async (root: string): Promise<Verification[]> => {
  if (!isDistribution(root)) return [await readme(root)]

  return [
    await readme(root),
    await overrides(root),
    policy(root),
    floor(root),
  ].filter((check): check is Verification => check !== undefined)
}
