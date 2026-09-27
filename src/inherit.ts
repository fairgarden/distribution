import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { addModule } from './add-module.ts'
import { readDistribution } from './extends.ts'
import { readPublishedModules, type PublishedModule } from './manifest.ts'
import { noteInDistribution, repositoryLink } from './changelog.ts'
import { ensureUpstreamRemote, gitmodulesSet, submodules } from './submodules.ts'

/**
 * Ship what the distribution this extends ships.
 *
 * An extension starts from its parent: every module the parent's published
 * manifest records, added where the parent has it, from the repository the
 * parent clones it from, at the commit the parent pins. A module the parent
 * ships as a fork comes as the same fork. After that it is the extension's —
 * bumped, forked or moved ahead as it likes, never behind.
 */

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

export interface InheritedModule extends PublishedModule {
  name: string
}

/** What became of the parent's license. */
export type CarriedLicense =
  /** Its copyright lines, added to this distribution's MIT license. */
  | { how: 'merged'; lines: string[] }
  /** Its license, kept verbatim beside this one's, which it is not. */
  | { how: 'copied'; file: string }
  /** Carried already, from an earlier run. */
  | { how: 'already' }
  /** It publishes none. */
  | { how: 'none' }

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md']

const findLicense = (dir: string): string | undefined =>
  LICENSE_FILES.map((name) => path.join(dir, name)).find((file) => existsSync(file))

const copyrightLines = (text: string): string[] =>
  text.split('\n').filter((line) => /^\s*copyright\b/i.test(line)).map((line) => line.trim())

const isMit = (text: string): boolean => /^\s*(the\s+)?mit\s+licen[cs]e/i.test(text)

/**
 * Carry the parent's license into this distribution's, as it asks.
 *
 * An extension ships what its parent does and builds on its policy, so the
 * parent's notice goes with it. Both MIT, the parent's copyright lines join
 * this one's — the parent's own already carry whatever it extends. Otherwise
 * the parent's license is kept whole beside this one's.
 */
export const carryParentLicense = (root: string, parent: string, parentRoot: string): CarriedLicense => {
  const theirs = findLicense(parentRoot)
  if (!theirs) return { how: 'none' }
  const theirText = readFileSync(theirs, 'utf8')
  const ours = findLicense(root)
  const ourText = ours ? readFileSync(ours, 'utf8') : undefined

  if (ours && ourText && isMit(ourText) && isMit(theirText)) {
    const have = new Set(copyrightLines(ourText))
    const missing = copyrightLines(theirText).filter((line) => !have.has(line))
    if (missing.length === 0) return { how: 'already' }
    const lines = ourText.split('\n')
    const first = lines.findIndex((line) => /^\s*copyright\b/i.test(line))
    const at = first === -1 ? Math.min(2, lines.length) : first
    lines.splice(at, 0, ...missing)
    writeFileSync(ours, lines.join('\n'))
    return { how: 'merged', lines: missing }
  }

  const file = `LICENSE.${parent.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-')}`
  const target = path.join(root, file)
  if (existsSync(target) && readFileSync(target, 'utf8') === theirText) return { how: 'already' }
  writeFileSync(target, theirText)
  return { how: 'copied', file }
}

export interface Inheritance {
  parent: string
  parentVersion: string
  /** What became of the parent's license. */
  license: CarriedLicense
  /** Added, or with a dry run, what would be. */
  added: InheritedModule[]
  /** Shipped already, at whatever version: `check` and `bump` see to that. */
  shipped: string[]
  /** Something is already where the parent has the module. */
  blocked: InheritedModule[]
}

export const inherit = async (
  root: string,
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<Inheritance> => {
  const own = readDistribution(root)
  if (!own.extends) throw new Error(`${own.name} extends nothing, so there is nothing to inherit.`)

  let manifest: { version?: string; distribution?: { modules?: unknown } }
  let parentRoot: string
  try {
    const file = createRequire(path.join(root, 'package.json')).resolve(`${own.extends}/package.json`)
    manifest = JSON.parse(readFileSync(file, 'utf8'))
    parentRoot = path.dirname(file)
  } catch {
    throw new Error(`${own.extends} is not installed, so there is nothing to read. Run pnpm install first.`)
  }

  const published = readPublishedModules(manifest)
  if (!published) {
    throw new Error(
      `${own.extends}@${manifest.version} does not record where its modules live. ` +
        'Publish it again with this version of fg-dist, or add them with `fg-dist add-module <url>`.'
    )
  }

  const inheritance: Inheritance = {
    parent: own.extends,
    parentVersion: manifest.version ?? '',
    license: dryRun ? { how: 'already' } : carryParentLicense(root, own.extends, parentRoot),
    added: [],
    shipped: [],
    blocked: [],
  }

  for (const [name, module] of Object.entries(published)) {
    if (own.modules[name] !== undefined) {
      inheritance.shipped.push(name)
      continue
    }
    const target = path.join(root, module.path)
    if (existsSync(target) && readdirSync(target).length > 0) {
      inheritance.blocked.push({ name, ...module })
      continue
    }
    inheritance.added.push({ name, ...module })
    if (dryRun) continue

    await addModule(root, module.repository, { at: module.path, changelog: false })

    // What the parent pins, which may be past the release its version names.
    if (git(target, ['checkout', '--quiet', module.commit]) === undefined) {
      git(target, ['fetch', '--quiet', 'origin', module.commit])
      if (git(target, ['checkout', '--quiet', module.commit]) === undefined) {
        throw new Error(
          `${module.repository} does not have ${module.commit}, which ${own.extends} ships as ${name}.`
        )
      }
    }

    if (module.upstream) {
      const added = submodules(root).find((submodule) => submodule.relativePath === module.path)
      if (added) {
        gitmodulesSet(root, added.configName, 'upstream', module.upstream)
        ensureUpstreamRemote(target, module.upstream)
      }
    }

    noteInDistribution(
      root,
      `\`${name}\` ${module.version} added, as ${own.extends} ships it, from ${repositoryLink(module.repository)}` +
        (module.upstream ? `, a fork of ${repositoryLink(module.upstream)}` : '')
    )
  }

  return inheritance
}
