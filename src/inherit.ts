import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

export interface Inheritance {
  parent: string
  parentVersion: string
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
  try {
    const file = createRequire(path.join(root, 'package.json')).resolve(`${own.extends}/package.json`)
    manifest = JSON.parse(readFileSync(file, 'utf8'))
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
