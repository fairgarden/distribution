import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { fromMarkdown } from 'mdast-util-from-markdown'
import {
  inspect,
  isDistribution,
  submodules,
  uninitialised,
  type Submodule,
} from './submodules.ts'
import { readDistribution } from './extends.ts'
import { toHttps } from './git-url.ts'

/**
 * Keep the module versions written into the readmes.
 *
 * Browsing a distribution on GitHub shows a submodule as a commit hash and
 * nothing else, so the version a module is pinned at is invisible exactly where
 * people go looking for it. Writing it into the readmes puts it back — in the
 * distribution's, as the list of what it ships, and at the top of each module's
 * own.
 *
 * The markdown is parsed to find the block to replace and the new text is
 * spliced into the original, so everything around it keeps its wording and its
 * formatting.
 */

interface Node {
  type: string
  value?: string
  depth?: number
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const open = (marker: string): string => `<!-- fg:${marker} -->`
const close = (marker: string): string => `<!-- /fg:${marker} -->`

const offsets = (node: Node): [number, number] => [
  node.position?.start.offset ?? 0,
  node.position?.end.offset ?? 0,
]

/**
 * Replace the block a marker delimits, or add one.
 *
 * A new block goes after the first heading, which is where someone looking for
 * a version would look first.
 */
export const updateSection = (
  source: string,
  marker: string,
  body: string,
  /**
   * Marker whose block this one belongs under, when it has to be inserted.
   * Without it a new block goes straight after the first heading, which means
   * whichever block is written last ends up on top.
   */
  after?: string
): string => {
  const tree = fromMarkdown(source) as unknown as { children: Node[] }
  const comments = tree.children.filter(
    (node) => node.type === 'html' && typeof node.value === 'string'
  )

  const start = comments.find((node) => node.value?.trim() === open(marker))
  const end = comments.find((node) => node.value?.trim() === close(marker))

  if (start && end) {
    const [, from] = offsets(start)
    const [to] = offsets(end)
    return `${source.slice(0, from)}\n\n${body}\n\n${source.slice(to)}`
  }

  const block = `${open(marker)}\n\n${body}\n\n${close(marker)}`

  // Under the block it belongs to if that is already here, otherwise under the
  // heading — the top of the file is where a reader starts.
  const anchor =
    (after && comments.find((node) => node.value?.trim() === close(after))) ??
    tree.children.find((node) => node.type === 'heading')

  if (!anchor) return `${block}\n\n${source}`

  const [, at] = offsets(anchor)
  return `${source.slice(0, at)}\n\n${block}${source.slice(at)}`
}

export interface ModuleVersion {
  name: string
  /** The version its own package.json declares. */
  version: string
  relativePath: string
  /** The commit the distribution pins. */
  pinned: string
  /** The version tag at that commit, or the newest one behind it. */
  tag: string | undefined
  /** Whether the tag is the pinned commit rather than an ancestor of it. */
  released: boolean
  /** Where the repository can be browsed, when it has a web address. */
  url: string | undefined
  /** What the module is, from its own package.json. */
  description: string | undefined
}

/**
 * A remote as somewhere to browse, or undefined when there is nowhere.
 *
 * A local path is a real remote and has no web address, so linking to one
 * would be worse than not linking at all.
 */
const browsableAt = (remote: string): string | undefined => {
  const https = toHttps(remote)
  if (!/^https?:\/\//i.test(https)) return undefined
  return https.replace(/\.git$/, '')
}

const link = (text: string, href: string | undefined): string =>
  href ? `[${text}](${href})` : text

/**
 * What the distribution is actually pinned at.
 *
 * A tagged commit is a released version and links to the tag. Anything else is
 * a commit after the last release, which is worth saying: the version in the
 * manifest is not what is being shipped.
 */
const pinnedAs = (module: ModuleVersion): string => {
  const short = module.pinned.slice(0, 7)

  if (module.released && module.tag) {
    return link(module.tag, module.url && `${module.url}/tree/${module.tag}`)
  }

  const commit = link(short, module.url && `${module.url}/commit/${module.pinned}`)
  return module.tag
    ? `${commit} — unreleased, after ${module.tag}`
    : `${commit} — untagged`
}

/** What a distribution ships, read from the checkouts. */
export const moduleVersions = async (root: string): Promise<ModuleVersion[]> => {
  const found: ModuleVersion[] = []

  for (const submodule of submodules(root)) {
    const manifest = await readManifest(submodule)
    if (manifest) found.push(manifest)
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

const readManifest = async (
  submodule: Submodule
): Promise<ModuleVersion | undefined> => {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(submodule.path, 'package.json'), 'utf8')
    )
    if (!pkg.name || !pkg.version) return undefined

    // Never fetches: this reads what is checked out, and writing a readme
    // should not depend on the network.
    const state = inspect(submodule, { fetch: false })

    return {
      name: pkg.name,
      version: pkg.version,
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      relativePath: submodule.relativePath,
      pinned: state.head,
      tag: state.current,
      released: state.exact,
      url: browsableAt(submodule.url),
    }
  } catch {
    return undefined
  }
}

const modulesTable = (modules: ModuleVersion[]): string => {
  const rows = [
    '| Module | Version | Pinned at | Path |',
    '| --- | --- | --- | --- |',
    ...modules.map((module) => {
      // Linked by name, so the table is also the index of where each lives.
      const name = link(`\`${module.name}\``, module.url)
      // An empty cell is honest: it shows which modules have yet to say what
      // they are, rather than hiding it.
      const what = module.description ? `<br>${module.description}` : ''
      return `| ${name}${what} | ${module.version} | ${pinnedAs(module)} | \`${module.relativePath}\` |`
    }),
  ]

  // Only worth explaining when something is actually unreleased.
  if (modules.some((module) => !module.released)) {
    rows.push(
      '',
      'A module pinned at a commit rather than a tag is being shipped ahead of',
      'its last release, so its stated version is not what is deployed.'
    )
  }

  return rows.join('\n')
}

/**
 * A module states its own version and nothing else.
 *
 * Naming a distribution here would be a claim the module cannot make: the same
 * module is shipped in several, which is the point of extending one. The
 * distribution's readme is where the relationship belongs.
 */
const versionLine = (module: ModuleVersion): string =>
  `Version **${module.version}**`

/**
 * How to release this module, written into the module's own readme.
 *
 * The same words in every module, with this one's version and branch names
 * filled in — so "how do I release this" is answered where someone is already
 * standing, rather than in a document they have to know exists.
 */
export const releasingSection = (name: string, version: string): string => {
  const parsed = semver.parse(version)
  // A prerelease has no line to maintain — there is no 2.0.0-alpha.0 that
  // someone is still running and needs a fix for — so `release` only moves it
  // forward, and saying otherwise here would contradict the command.
  const prerelease = (parsed?.prerelease.length ?? 0) > 0

  const after = (bump: 'patch' | 'minor' | 'major'): string =>
    (parsed && semver.inc(version, bump)) ?? '…'

  const moveOn = prerelease
    ? [
        '2. **Move it on.** `pnpm release` — opens a pull request bumping this branch',
        `   to \`${(parsed && semver.inc(version, 'prerelease')) ?? '…'}\`, or \`pnpm release --id rc\` to change`,
        '   identifier. A prerelease gets no maintenance branch; there is no released',
        '   line behind it yet.',
      ]
    : [
        '2. **Decide which way main moves on.** `pnpm release` on its own prints the',
        '   three and stops — it will not choose for you:',
        '',
        '   | | Next | Leaves behind |',
        '   | --- | --- | --- |',
        `   | \`pnpm release --patch\` | \`${after('patch')}\` | nothing; this branch is the line |`,
        `   | \`pnpm release --minor\` | \`${after('minor')}\` | \`v${parsed?.major ?? 'x'}-${parsed?.minor ?? 'y'}\` at \`${after('patch')}\` |`,
        `   | \`pnpm release --major\` | \`${after('major')}\` | \`v${parsed?.major ?? 'x'}-${parsed?.minor ?? 'y'}\` at \`${after('patch')}\` |`,
        '',
        '   The branch it leaves behind is where fixes to what you just released go.',
        '3. **Fixing an older release.** Land it on main first, cherry-pick it onto that',
        "   release's `v<major>-<minor>` branch, then publish from there under its own",
        '   dist tag — never as `latest` unless that line is still the newest.',
      ]

  const early = prerelease
    ? []
    : [
        '',
        '### Starting the next line early',
        '',
        `\`pnpm exec fg-dist prerelease --major\` cuts \`v${(parsed?.major ?? 0) + 1}\` at`,
        `\`${(parsed && semver.inc(version, 'premajor', 'alpha')) ?? '…'}\` and leaves main exactly where it is, so the next`,
        'line can be worked on while this one goes on shipping. Release from that branch',
        'under a dist tag of its own — `next`, say — so `latest` goes on meaning the line',
        'main is shipping. `--minor` does the same for the next minor.',
      ]

  return [
    '## Releasing',
    '',
    `This module releases on its own. \`${version}\` is what main is working towards,`,
    'not what is published — the version here is always the next one.',
    '',
    '1. **Publish it.** Run the *Publish* workflow from the Actions tab, picking the',
    '   dist tag. It refuses if that version is already on npm.',
    ...moveOn,
    ...early,
    '',
    `Every push to main publishes \`${name}@canary\`. A canary is not a release and`,
    'carries no promise; it is there so main can be tried without a checkout.',
  ].join('\n')
}

export interface ReadmeUpdate {
  file: string
  changed: boolean
}

export interface ReadmeResult {
  updates: ReadmeUpdate[]
  modules: ModuleVersion[]
  /** What was found here: a distribution listing modules, or a module itself. */
  kind: 'distribution' | 'module'
}

/** The name and version of the repository this is run in. */
const ownManifest = async (
  root: string
): Promise<{ name: string; version: string } | undefined> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    if (!pkg.name || !pkg.version) return undefined
    return { name: pkg.name, version: pkg.version }
  } catch {
    return undefined
  }
}

/**
 * The readme this repository has, or what to call one if it has none.
 *
 * Hard-coding `Readme.md` writes a second file next to an existing `README.md`
 * on Linux and edits the real one on macOS, so the same command passes locally
 * and fails in CI.
 */
const readmeIn = async (dir: string): Promise<string> => {
  const found = (await readdir(dir).catch(() => []))
    .filter((entry) => /^readme\.md$/i.test(entry))
    .sort()

  return path.join(dir, found[0] ?? 'Readme.md')
}

/**
 * Write the versions into the distribution's readme and each module's.
 *
 * Idempotent: running it again when nothing has moved rewrites nothing.
 */
export const writeReadmes = async (
  root: string,
  { check = false }: { check?: boolean } = {}
): Promise<ReadmeResult> => {
  const modules = await moduleVersions(root)

  // Read from .gitmodules rather than from the checkouts: a clone made without
  // --recurse-submodules has none of them, and calling that a module would
  // write a module's readme over the distribution's.
  const kind = isDistribution(root) ? 'distribution' : 'module'

  if (kind === 'distribution') {
    const absent = uninitialised(root)
    if (absent.length > 0) {
      throw new Error(
        `These submodules are not checked out, so their versions cannot be read: ` +
          `${absent.join(', ')}.\nRun \`git submodule update --init\` first.`
      )
    }
  }

  const planned: Array<{
    file: string
    marker: string
    body: string
    heading: string
    after?: string
  }> = []

  if (kind === 'module') {
    const own = await ownManifest(root)
    if (!own) {
      throw new Error(
        `${root} has no submodules and no package.json version, so there is ` +
          'nothing to record.'
      )
    }
    const file = await readmeIn(root)
    planned.push(
      { file, marker: 'version', body: `Version **${own.version}**`, heading: own.name },
      {
        file,
        marker: 'releasing',
        body: releasingSection(own.name, own.version),
        heading: own.name,
        after: 'version',
      }
    )
  } else {
    const distribution = readDistribution(root)
    planned.push({
      file: await readmeIn(root),
      marker: 'modules',
      body: modulesTable(modules),
      heading: distribution.name,
    })

    for (const module of modules) {
      const file = await readmeIn(path.join(root, module.relativePath))
      planned.push(
        { file, marker: 'version', body: versionLine(module), heading: module.name },
        {
          file,
          marker: 'releasing',
          body: releasingSection(module.name, module.version),
          heading: module.name,
          after: 'version',
        }
      )
    }
  }

  // Grouped, because a file carries more than one block and reporting it once
  // per block doubles both the listing and the count of what changed.
  const byFile = new Map<string, typeof planned>()
  for (const entry of planned) {
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry])
  }

  const updates: ReadmeUpdate[] = []
  for (const [file, blocks] of byFile) {
    const original = await readFile(file, 'utf8').catch(() => undefined)

    // Applied in order to the same text: a block that has to be inserted is
    // placed relative to the ones before it.
    let updated = original ?? `# ${blocks[0].heading}\n`
    for (const { marker, body, after } of blocks) {
      updated = updateSection(updated, marker, body, after)
    }

    const changed = updated !== original
    if (changed && !check) await writeFile(file, updated)
    updates.push({ file, changed })
  }

  return { updates, modules, kind }
}
