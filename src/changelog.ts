import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { isDistribution } from './submodules.ts'

/**
 * Changelogs.
 *
 * Every module keeps a CHANGELOG.md. Its top section is the version its main
 * carries — the next to be released — and every pull request adds a line to
 * it that links the pull request, which CI checks before it can merge. When
 * the version is published its notes are written already, and committed: the
 * release takes them as they are, and `next-version` opens the next section.
 *
 * A distribution's changelog is mostly written for it. fg-dist notes each
 * module it bumps, with a link to that release's notes, and each module it
 * adds, forks, or takes back to upstream. What people change in it by hand —
 * the organization's policy — is checked like a module's.
 */

export const CHANGELOG = 'CHANGELOG.md'

/** Where a pull request that needs no entry — a lockfile bump — says so. */
export const SKIP_LABEL = 'skip changelog'

/**
 * A new changelog, opened at `version`.
 *
 * Nothing but the heading: a changelog is for whoever uses a release, and how
 * lines get into it is for contributors, who hear it from the check that asks
 * for one.
 */
export const newChangelog = (version: string): string => `# Changelog\n\n## ${version}\n`

const HEADING = /^## +(\S+)/

/** The same version, however it is spelled: `26.09.01` is npm's `26.9.1`. */
const sameVersion = (a: string, b: string): boolean => {
  if (a === b) return true
  const left = semver.clean(a, { loose: true })
  return left !== null && left === semver.clean(b, { loose: true })
}

interface Section {
  version: string
  /** The heading's line. */
  start: number
  /** The line after the section's last. */
  end: number
}

const sectionsOf = (lines: string[]): Section[] => {
  const sections: Section[] = []
  lines.forEach((line, index) => {
    const match = HEADING.exec(line)
    if (!match) return
    const previous = sections.at(-1)
    if (previous) previous.end = index
    sections.push({ version: match[1], start: index, end: lines.length })
  })
  return sections
}

/** The version of the top section, which is the one being worked on. */
export const topVersion = (text: string): string | undefined => sectionsOf(text.split('\n'))[0]?.version

/** What `version`'s section says, without its heading; undefined when there is none, or nothing in it. */
export const notesFor = (text: string, version: string): string | undefined => {
  const lines = text.split('\n')
  const section = sectionsOf(lines).find((candidate) => sameVersion(candidate.version, version))
  if (!section) return undefined
  const body = lines.slice(section.start + 1, section.end).join('\n').trim()
  return body === '' ? undefined : `${body}\n`
}

/** `text` with `version` as its top section, added above the others unless it is there. */
export const withSection = (text: string, version: string): string => {
  const lines = text.split('\n')
  const sections = sectionsOf(lines)
  if (sections[0] && sameVersion(sections[0].version, version)) return text
  const at = sections[0]?.start ?? lines.length
  const before = lines.slice(0, at)
  while (before.length > 0 && before.at(-1) === '') before.pop()
  return [...before, '', `## ${version}`, '', ...lines.slice(at)].join('\n').replace(/\n*$/, '\n')
}

/** `text` with its top section, `from`, called `to` instead: a release moved before it was published. */
export const renameTop = (text: string, from: string, to: string): string => {
  const lines = text.split('\n')
  const top = sectionsOf(lines)[0]
  if (!top || !sameVersion(top.version, from)) return withSection(text, to)
  lines[top.start] = lines[top.start].replace(top.version, to)
  return lines.join('\n')
}

/** `text` with `entry` as a line at the end of `version`'s section, the top one. */
export const withEntry = (text: string, version: string, entry: string): string => {
  const lines = withSection(text, version).split('\n')
  const top = sectionsOf(lines)[0]
  // Said once: running the same command twice writes nothing new.
  if (lines.slice(top.start + 1, top.end).includes(`- ${entry}`)) return lines.join('\n')
  let at = top.end
  while (at > top.start + 1 && lines[at - 1] === '') at -= 1
  const line = `- ${entry}`
  // A blank line after the heading, and one before the next section.
  const insert = at === top.start + 1 ? ['', line] : [line]
  const rest = lines.slice(at)
  return [...lines.slice(0, at), ...insert, ...(rest.length > 0 && rest[0] !== '' ? [''] : []), ...rest]
    .join('\n')
    .replace(/\n*$/, '\n')
}

const readVersion = (root: string): string | undefined => {
  try {
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Open the section for the version a repository now carries, when it keeps a
 * changelog: what `next-version` does as it moves main on.
 */
export const openSection = async (root: string, version = readVersion(root)): Promise<boolean> => {
  const file = path.join(root, CHANGELOG)
  if (!version || !existsSync(file)) return false
  const text = await readFile(file, 'utf8')
  const updated = withSection(text, version)
  if (updated === text) return false
  await writeFile(file, updated)
  return true
}

/**
 * Add a line to a repository's changelog, under the version it carries,
 * starting the changelog when there is none: what fg-dist writes into a
 * distribution's as it changes what the distribution ships.
 */
export const addEntry = (root: string, entry: string): void => {
  const version = readVersion(root)
  if (!version) return
  const file = path.join(root, CHANGELOG)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : newChangelog(version)
  writeFileSync(file, withEntry(text, version, entry))
}

/** Note a change to what a distribution ships in its changelog; anywhere else, nothing. */
export const noteInDistribution = (root: string, entry: string): void => {
  if (isDistribution(root)) addEntry(root, entry)
}

/** A module's name and version, as its checkout states them, for a changelog line. */
export const moduleLabel = (checkout: string): { name: string; version: string | undefined } => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8'))
    return {
      name: typeof pkg.name === 'string' ? pkg.name : path.basename(checkout),
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
    }
  } catch {
    return { name: path.basename(checkout), version: undefined }
  }
}

/** The top section called `to` rather than `from`, or a new one when `from` was published. */
export const moveSection = async (
  root: string,
  from: string,
  to: string,
  { published }: { published: boolean }
): Promise<void> => {
  const file = path.join(root, CHANGELOG)
  if (!existsSync(file) || from === to) return
  const text = await readFile(file, 'utf8')
  await writeFile(file, published ? withSection(text, to) : renameTop(text, from, to))
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const attempt = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args)
  } catch {
    return undefined
  }
}

export interface ChangelogCheck {
  /** The pull request's number. */
  pullRequest: number
  /** `owner/name`, which the link names. */
  repository: string
  /** What it merges into: a commit, or a ref such as `origin/main`. */
  base: string
  /** Whether this is a distribution, which checks only its policy. */
  distribution: boolean
  labels?: string[]
  /** The host links point at. */
  server?: string
}

export interface ChangelogCheckResult {
  ok: boolean
  /** Whether this pull request needed an entry at all. */
  required: boolean
  message: string
}

/**
 * Whether a pull request has added its changelog entry.
 *
 * It needs a line under the top section, linking it. In a module that is
 * every pull request; in a distribution only one that changes the
 * organization's policy — what else changes there, fg-dist notes itself.
 */
export const checkChangelog = (root: string, check: ChangelogCheck): ChangelogCheckResult => {
  const { pullRequest, repository, base, distribution, labels = [] } = check
  const server = (check.server ?? 'https://github.com').replace(/\/+$/, '')
  const url = `${server}/${repository}/pull/${pullRequest}`

  // Nothing merges between a release and the start of the next cycle: its
  // lines would go under a version already out. `next-version` moves main on
  // after publishing, and this runs again once the branch has that.
  const carried = readVersion(root)
  if (carried && attempt(root, ['rev-parse', '--verify', '--quiet', `refs/tags/v${carried}`]) !== undefined) {
    return {
      ok: false,
      required: true,
      message:
        `This branch is at ${carried}, which is released. Bring it up to date with its base — ` +
        '`pnpm next-version` starts the next version there — and this runs again.',
    }
  }

  const changed = git(root, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean)

  // Starting the next version is what opens its section; nothing in it is news.
  // Only when that is all it does: a change that comes with it is still one
  // someone will want to read about.
  const opened = topVersion(attempt(root, ['show', `${base}:${CHANGELOG}`]) ?? '')
  const current = topVersion(existsSync(path.join(root, CHANGELOG)) ? readFileSync(path.join(root, CHANGELOG), 'utf8') : '')
  if (current && opened && current !== opened && onlyStartsVersion(root, base, changed)) {
    return { ok: true, required: false, message: `This starts ${current}, so it needs no line of its own.` }
  }

  if (labels.includes(SKIP_LABEL)) {
    return { ok: true, required: false, message: `Labelled "${SKIP_LABEL}", so no entry is needed.` }
  }
  if (distribution) {
    const policy = changed.filter((file) => file.startsWith('policies/') && !file.startsWith('policies/dist/'))
    if (policy.length === 0) {
      return {
        ok: true,
        required: false,
        message: "This changes none of the organization's policy, so fg-dist keeps the changelog itself.",
      }
    }
  }

  const file = path.join(root, CHANGELOG)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const version = topVersion(text) ?? readVersion(root) ?? 'the top section'
  const example = `- What this changes, for someone using it ([#${pullRequest}](${url}))`
  const wanted =
    `Add a line to ${CHANGELOG}, under ${version}, that links this pull request:\n\n${example}\n\n` +
    `Or label the pull request "${SKIP_LABEL}" if it changes nothing anyone would read about.`

  const link = url.replace(/^https?:\/\//, '').toLowerCase()
  const added = git(root, ['diff', `${base}...HEAD`, '--', CHANGELOG])
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .filter((line) => line.toLowerCase().includes(link))

  if (added.length === 0) {
    return { ok: false, required: true, message: `${CHANGELOG} has no line linking this pull request.\n${wanted}` }
  }

  // Under the version being worked on, not one already released.
  const lines = text.split('\n')
  const top = sectionsOf(lines)[0]
  const inTop =
    top !== undefined &&
    lines.slice(top.start + 1, top.end).some((line) => line.toLowerCase().includes(link))
  if (!inTop) {
    return {
      ok: false,
      required: true,
      message: `${CHANGELOG} links this pull request, but not under ${version}, which is what it ships in.\n${wanted}`,
    }
  }
  return { ok: true, required: true, message: `${CHANGELOG} has this pull request under ${version}.` }
}

/**
 * Whether these changes are only what `next-version` writes: the changelog,
 * the readme, and the version in package.json.
 */
const onlyStartsVersion = (root: string, base: string, changed: string[]): boolean =>
  changed.every((file) => {
    if (file === CHANGELOG || /^readme\.md$/i.test(file)) return true
    if (file !== 'package.json') return false
    // The version and nothing else: a dependency moved alongside it is a change.
    const without = (text: string | undefined): string | undefined => {
      if (text === undefined) return undefined
      const { version: _version, ...rest } = JSON.parse(text) as Record<string, unknown>
      return JSON.stringify(rest)
    }
    const before = without(attempt(root, ['show', `${base}:package.json`]))
    const after = without(existsSync(path.join(root, 'package.json')) ? readFileSync(path.join(root, 'package.json'), 'utf8') : undefined)
    return before !== undefined && before === after
  })

/** What a GitHub Actions `pull_request` run says about itself. */
export const pullRequestFromActions = (): Partial<ChangelogCheck> => {
  const file = process.env.GITHUB_EVENT_PATH
  if (!file || !existsSync(file)) return {}
  try {
    const event = JSON.parse(readFileSync(file, 'utf8'))
    const pr = event.pull_request
    if (!pr) return {}
    return {
      pullRequest: pr.number,
      base: pr.base?.sha,
      labels: Array.isArray(pr.labels) ? pr.labels.map((label: { name?: string }) => label.name ?? '') : [],
      repository: process.env.GITHUB_REPOSITORY,
      server: process.env.GITHUB_SERVER_URL,
    }
  } catch {
    return {}
  }
}

/** Where a repository's release of `tag` is described, when it is on GitHub. */
export const releaseNotesUrl = (repository: string, tag: string): string | undefined => {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repository)
  return match ? `https://github.com/${match[1]}/releases/tag/${tag}` : undefined
}

/** A repository as a markdown link to it, or its url when it has no web page. */
export const repositoryLink = (repository: string): string => {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repository)
  return match ? `[${match[1]}](https://github.com/${match[1]})` : repository
}

/** `v1.2.0` as `1.2.0`, for reading; anything else as it is. */
export const shown = (version: string): string => version.replace(/^v(?=\d)/, '')

/**
 * The releases a module moving to `to` takes in, oldest first: every one past
 * where it was, up to and including `to`, prereleases too. Each release's
 * notes are its own, so skipping one would hide what it changed.
 */
export const crossedReleases = (newer: string[], to: string): string[] => {
  const crossed = newer
    .filter((tag) => semver.valid(tag) !== null && semver.lte(tag, to))
    .sort((a, b) => semver.compare(a, b))
  return crossed.length > 0 ? crossed : [to]
}

/** Links to the notes of each release, for a changelog line: one, or each in turn. */
export const releaseNotesLinks = (repository: string, releases: string[]): string => {
  const links = releases.flatMap((tag) => {
    const url = releaseNotesUrl(repository, tag)
    return url ? [{ version: shown(tag), url }] : []
  })
  if (links.length === 0) return ''
  if (links.length === 1) return ` ([release notes](${links[0].url}))`
  return ` (release notes: ${links.map((link) => `[${link.version}](${link.url})`).join(', ')})`
}

/** A module moved from one release to another, linking the notes of each it takes in. */
export const bumpEntry = (
  name: string,
  from: string,
  to: string,
  repository: string,
  releases: string[],
  how?: string
): string =>
  `\`${name}\` ${shown(from)} → ${shown(to)}${how ? `, ${how}` : ''}${releaseNotesLinks(repository, releases)}`

/**
 * A module shipped ahead of its next release: what the change is, and where it
 * can be read about — its pull request, or its commit.
 */
export const aheadEntry = (name: string, change: string, link?: { text: string; url: string }): string =>
  `\`${name}\` ahead of its next release: ${change}${link ? ` ([${link.text}](${link.url}))` : ''}`

/** An open pull request, as `gh pr list` has it. */
export interface OpenPullRequest {
  number: number
  headRefOid: string
}

/** A run of the changelog check, as `gh run list` has it, newest first. */
export interface CheckRun {
  databaseId: number
  headSha: string
  event: string
  status: string
}

export interface Hold {
  pullRequest: number
  /** The run to go again, or undefined when none has run on its head yet. */
  run: number | undefined
  /** Whether it is still going, and has to finish before it can run again. */
  running: boolean
}

/**
 * Which check to run again for each open pull request: the latest on its
 * head commit. One with none yet needs nothing — its first run sees the
 * release.
 */
export const holdsFor = (pullRequests: OpenPullRequest[], runs: CheckRun[]): Hold[] =>
  pullRequests.map((pullRequest) => {
    const run = runs.find(
      (candidate) => candidate.event === 'pull_request' && candidate.headSha === pullRequest.headRefOid
    )
    return { pullRequest: pullRequest.number, run: run?.databaseId, running: run !== undefined && run.status !== 'completed' }
  })

const gh = (cwd: string, args: string[]): string =>
  execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export interface HoldResult extends Hold {
  held: boolean
  /** Why it was not, when it was not. */
  problem?: string
}

/**
 * Hold open pull requests until the next version starts, straight after a
 * release: each one's changelog check runs again, finds the version its branch
 * is at released, and refuses it. Merging the pull request that starts the next
 * version lets them through again, once each has caught up with it.
 *
 * Needs `gh`, and a token that may re-run workflows (`actions: write`).
 */
export const holdPullRequests = (
  root: string,
  { base, workflow = 'changelog.yml' }: { base: string; workflow?: string }
): HoldResult[] => {
  const pullRequests = JSON.parse(
    gh(root, ['pr', 'list', '--base', base, '--state', 'open', '--limit', '200', '--json', 'number,headRefOid'])
  ) as OpenPullRequest[]
  if (pullRequests.length === 0) return []
  const runs = JSON.parse(
    gh(root, [
      'run', 'list', '--workflow', workflow, '--event', 'pull_request', '--limit', '500',
      '--json', 'databaseId,headSha,event,status',
    ])
  ) as CheckRun[]

  return holdsFor(pullRequests, runs).map((hold) => {
    if (hold.run === undefined) return { ...hold, held: true }
    try {
      // A run still going cannot be run again until it is done.
      if (hold.running) {
        try {
          gh(root, ['run', 'watch', String(hold.run), '--interval', '10'])
        } catch {
          // It failing is fine; it only has to have finished.
        }
      }
      gh(root, ['run', 'rerun', String(hold.run)])
      return { ...hold, held: true }
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error)
      return { ...hold, held: false, problem: stderr }
    }
  })
}
