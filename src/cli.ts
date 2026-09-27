#!/usr/bin/env node
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { addModule } from './add-module.ts'
import { extractModule } from './extract.ts'
import { writeReadmes } from './readme.ts'
import { verify } from './verify.ts'
import { inBuild, loadEnvFiles, migrationTargets, runMigrations, type MigrateAction } from './migrate.ts'
import {
  deploymentAt,
  describeMissing,
  distributionAround,
  distributionDeployments,
  missing,
  requirementsFor,
} from './env.ts'
import {
  applyRotation,
  applySetup,
  missingRemotely,
  planRotation,
  planSetup,
  remotesOf,
} from './env-vercel.ts'
import { writeRotationWorkflow } from './workflows.ts'
import { toolRelease, writeDistributionChecks, writeDistributionWorkflow, writeWorkflows } from './workflows.ts'
import { writeOverrides } from './overrides.ts'
import {
  checkReleasable,
  planRelease,
  readRelease,
  release,
  releaseDistribution,
  reportToActions as reportRelease,
  startPrerelease,
  type Bump,
} from './release.ts'
import { reportToActions as reportCanary, stampCanary } from './canary.ts'
import { describeRemote, isSsh, toHttps } from './git-url.ts'
import {
  distributionRepo,
  isEmpty,
  moduleRepo,
  monolithRepo,
  write,
} from './scaffold.ts'
import { describeViolations, inspectExtends } from './extends.ts'
import { contribute, forkModule, integrate, unforkModule } from './forks.ts'
import { inherit } from './inherit.ts'
import {
  bumpEntry,
  checkChangelog,
  crossedReleases,
  holdPullRequests,
  CHANGELOG,
  moduleLabel,
  noteInDistribution,
  notesFor,
  pullRequestFromActions,
} from './changelog.ts'
import { buildPolicy, findPolicy, POLICIES, setupTurbo, testPolicy, usePolicy } from './policy.ts'
import { stampModules } from './manifest.ts'
import {
  containsAll,
  inspect,
  isDistribution,
  isPublic,
  moveTo,
  repositoryRoot,
  setUrl,
  submodules,
  target,
  type SubmoduleState,
} from './submodules.ts'

// Piping into `head` closes stdout early; that is ordinary use, not a failure.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
}

const USAGE = `Usage: fg-dist <command> [options]
       pnpm dist <command> [options], in a repository fg-dist set up

Commands:
  init <kind> [dir]    Scaffold a repository; kind is "distribution", "monolith" or "module"
  add-module <url>     Add a module repository as a submodule and link it
  extract <path>       Turn a directory here into its own repository and submodule
  use-https [name...]  Rewrite submodule urls from ssh to https
  readme               Record versions in the readmes; run in a distribution or a module
  workflows [name...]  Give every module a publishing workflow and a changelog check;
                       --distribution, this one a publishing workflow too
  overrides            Point the workspace at this distribution's own checkouts
  canary               Stamp a canary version into the manifest, for CI
  next-version         Start the next development cycle, choosing the version main works towards
  release --check      Fail unless this version can be published, and stamp it (CI)
  prerelease           Start the next line on a branch, leaving main where it is
  check                Fail when this ships anything older than what it extends
  verify               Fail when a file fg-dist writes no longer says what is true (CI)
  migrate [name...]    Migrate the databases of this app, or of every app this monolith ships
  env check            Fail when a deployment lacks what its apps need (--build: this one, in its build)
  env setup            Add what each deployment's Vercel project lacks: secrets generated, the rest asked
  env rotate [var...]  Rotate the generated secrets with no downtime, and redeploy production
  env workflow         Write the workflow that rotates them every month
  inherit              Add the modules the distribution this extends ships, and this does not
  sync                 Report which modules have newer versions available
  bump [name...]       Move modules to their newest non-major version; a fork merges it
  fork <name> <url>    Check a module out from your fork, keeping where it came from
  contribute <name>    Push the module's branch and open a pull request upstream
  unfork <name>        Go back to the upstream a fork came from, once it has the fork's work
  changelog check      Fail a pull request that adds no changelog line linking itself (CI)
  changelog notes [v]  Print a version's changelog section, for its release notes
  changelog hold       Hold open pull requests until the next version starts (CI, after a release)
  policy build         Build the organization's policy: policies/, on every module's own
  policy test          Test each module's rules, then the organization's on top of them
  policy use           Put the built policy beside this service, for it to run
  policy setup         Have turbo build the policy once, before each service that uses it

Options:
  --cwd <dir>          Repository directory (default: the working directory)
  --major              Allow major upgrades (bump); the next major (next-version, prerelease)
  --minor              The next minor, or branch one (next-version, prerelease)
  --patch              The next patch, staying on this line (next-version)
  --id <name>          Prerelease identifier: alpha, beta, rc (next-version, prerelease)
  --stable             A distribution's next release leaves its prerelease stages (next-version)
  --next <how>         prerelease, alpha, beta, rc, patch, minor, major or stable (next-version)
  --direct             Commit main's move on where this runs and push it, no pull request (next-version)
  --no-fetch           Use the refs already fetched (sync, bump)
  --dry-run            Report what would change without changing it
  --check              Verify instead of writing (readme, release, overrides)
                       --dry-run does the same for workflows, readme and overrides
  --name <name>        Package name for "init", mount name for add-module
  --at <dir>           Where add-module puts the submodule (default: apps/<name>)
  --no-git             Skip "git init" when scaffolding
  --url <git-url>      Remote the scaffolded repository will live at (init)
  --extends <name>     Distribution the scaffolded one extends (init distribution)
  --copyright <holder> Who holds the copyright on its MIT license (init; default: git user.name)
  --separate           Scaffold a distribution whose apps deploy separately
  --ssh                Record a submodule's URL as given, without rewriting it
  --no-verify          Skip checking whether the https urls can be cloned
  --no-tag             Do not tag the extracted module with its declared version
  --force              Overwrite workflows that are already there (workflows)
  --distribution       Publish the distribution itself, for others to extend (workflows)
  --no-push            Push nothing and open no pull request (next-version, fork, contribute, bump)
  --to <ref>           Upstream tag, branch or commit to go back to (unfork); roll back all after it (migrate)
  --base <branch>      Branch the pull request goes into (contribute); what it merges into (changelog check)
  --pr <number>        The pull request to check, outside GitHub Actions (changelog check)
  --repo <owner/name>  The repository its link names, outside GitHub Actions (changelog check)
  --out <file>         Where policy build writes the bundle (default: policies/dist/)
  --build              As a build step: only where builds migrate, see the docs (migrate)
  --status             What has run and what is pending, changing nothing (migrate)
  --rollback           Roll back the latest migration, --steps N of them, or all after --to TAG (migrate)
  --steps <n>          How many to roll back (migrate --rollback)
  --environment <env>  Vercel environment: production (default) or preview (env)
  --no-redeploy        Rotate without redeploying production (env rotate)
  --yes                Rotate without asking first (env rotate)
`

interface Args {
  command: string | undefined
  names: string[]
  cwd: string
  check: boolean
  major: boolean
  fetch: boolean
  dryRun: boolean
  name: string | undefined
  at: string | undefined
  git: boolean
  url: string | undefined
  extends: string | undefined
  separate: boolean
  ssh: boolean
  verify: boolean
  tag: boolean
  force: boolean
  push: boolean
  bump: 'patch' | 'minor' | 'major' | undefined
  id: string | undefined
  out: string | undefined
  to: string | undefined
  base: string | undefined
  distribution: boolean
  stable: boolean
  pr: number | undefined
  repo: string | undefined
  direct: boolean
  copyright: string | undefined
  build: boolean
  status: boolean
  rollback: boolean
  steps: number | undefined
  environment: string | undefined
  redeploy: boolean
  yes: boolean
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    command: undefined,
    names: [],
    cwd: process.cwd(),
    check: false,
    major: false,
    fetch: true,
    dryRun: false,
    name: undefined,
    at: undefined,
    git: true,
    url: undefined,
    extends: undefined,
    separate: false,
    ssh: false,
    verify: true,
    tag: true,
    force: false,
    push: true,
    bump: undefined,
    id: undefined,
    out: undefined,
    to: undefined,
    base: undefined,
    distribution: false,
    stable: false,
    pr: undefined,
    repo: undefined,
    direct: false,
    copyright: undefined,
    build: false,
    status: false,
    rollback: false,
    steps: undefined,
    environment: undefined,
    redeploy: true,
    yes: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // What an option takes. Missing, it is refused: `--to` with nothing after
    // it must not become a different rollback than the one asked for.
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value.`)
      index += 1
      return next
    }
    if (arg === '--cwd') {
      args.cwd = path.resolve(value())
    } else if (arg === '--check') {
      args.check = true
    } else if (arg === '--build') {
      args.build = true
    } else if (arg === '--environment') {
      args.environment = value()
    } else if (arg === '--no-redeploy') {
      args.redeploy = false
    } else if (arg === '--yes' || arg === '-y') {
      args.yes = true
    } else if (arg === '--status') {
      args.status = true
    } else if (arg === '--rollback') {
      args.rollback = true
    } else if (arg === '--steps') {
      args.steps = Number(value())
    } else if (arg === '--major') {
      args.major = true
      args.bump = 'major'
    } else if (arg === '--minor') {
      args.bump = 'minor'
    } else if (arg === '--patch') {
      args.bump = 'patch'
    } else if (arg === '--id') {
      args.id = value()
    } else if (arg === '--no-fetch') {
      args.fetch = false
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--name') {
      args.name = value()
    } else if (arg === '--at') {
      args.at = value()
    } else if (arg === '--no-git') {
      args.git = false
    } else if (arg === '--url') {
      args.url = value()
    } else if (arg === '--extends') {
      args.extends = value()
    } else if (arg === '--separate') {
      args.separate = true
    } else if (arg === '--ssh') {
      args.ssh = true
    } else if (arg === '--no-verify') {
      args.verify = false
    } else if (arg === '--no-tag') {
      args.tag = false
    } else if (arg === '--force') {
      args.force = true
    } else if (arg === '--no-push') {
      args.push = false
    } else if (arg === '--copyright') {
      args.copyright = value()
    } else if (arg === '--direct') {
      args.direct = true
    } else if (arg === '--next') {
      // How main moves on after a release, as the publish workflow is told:
      // carry on the prerelease, change its stage, or bump.
      const next = value()
      if (next === 'prerelease') {
        // as it is
      } else if (next === 'alpha' || next === 'beta' || next === 'rc') {
        args.id = next
      } else if (next === 'patch' || next === 'minor' || next === 'major') {
        args.bump = next
      } else if (next === 'stable') {
        args.stable = true
      } else {
        throw new Error(`--next is prerelease, alpha, beta, rc, patch, minor, major or stable; not ${next}.`)
      }
    } else if (arg === '--pr') {
      args.pr = Number(value())
    } else if (arg === '--repo') {
      args.repo = value()
    } else if (arg === '--stable') {
      args.stable = true
    } else if (arg === '--distribution') {
      args.distribution = true
    } else if (arg === '--to') {
      args.to = value()
    } else if (arg === '--base') {
      args.base = value()
    } else if (arg === '--out') {
      args.out = path.resolve(value())
    } else if (!arg.startsWith('-')) {
      if (args.command) args.names.push(arg)
      else args.command = arg
    } else {
      throw new Error(`Unrecognized argument: ${arg}`)
    }
  }

  return args
}

/** One line per module, aligned, saying what is available. */
/**
 * Where a fork could go back to upstream, when upstream has taken what it
 * added: a release past the pinned one, or its branch. Not a fork that has
 * added nothing yet, which is where every fork starts.
 */
const canReturn = (state: SubmoduleState): string | undefined => {
  const merged = state.fork?.merged
  if (!merged) return undefined
  if (merged === state.current && state.fork?.ahead === 0) return undefined
  return merged.replace(/^upstream\//, '')
}

const describeState = (state: SubmoduleState): string => {
  const { current, available, untagged, dirty } = state
  const parts: string[] = []

  const at = current ? (state.exact ? current : `${current}+`) : 'untagged'
  parts.push(at)

  if (available.length > 0) {
    const kinds = (['patch', 'minor', 'major'] as const)
      .filter((kind) => state.upgrades[kind])
      .map((kind) => `${state.upgrades[kind]} (${kind})`)
    parts.push(`-> ${kinds.join(', ')}`)
  } else if (current) {
    parts.push('up to date')
  } else {
    parts.push('no version tags')
  }

  if (untagged > 0) parts.push(`${untagged} untagged commit${untagged === 1 ? '' : 's'}`)
  if (state.fork) {
    const { upstream, ahead } = state.fork
    const from = `fork of ${describeRemote(upstream)}`
    const returnTo = canReturn(state)
    parts.push(
      returnTo
        ? `${from}, all in upstream ${returnTo}`
        : ahead === 0
          ? `${from}, nothing of its own`
          : `${from}, ${ahead} commit${ahead === 1 ? '' : 's'} not upstream`
    )
  }
  if (state.pushed === false) parts.push('not pushed')
  if (dirty) parts.push('uncommitted changes')
  if (state.fetched === false) parts.push('could not fetch')
  if (isSsh(state.submodule.url)) parts.push('ssh url')

  return parts.join('  ')
}

/** Submodules of the repository holding `cwd`, optionally filtered by name. */
const modulesFor = (cwd: string, names: string[]) => {
  const root = repositoryRoot(cwd)
  if (!root) throw new Error(`${cwd} is not inside a git repository.`)

  const all = submodules(root)
  if (all.length === 0) {
    throw new Error(`${root} has no submodules to sync.`)
  }

  if (names.length === 0) return { root, modules: all }

  const modules = all.filter(
    (module) => names.includes(module.name) || names.includes(module.relativePath)
  )
  const missing = names.filter(
    (name) => !all.some((m) => m.name === name || m.relativePath === name)
  )
  if (missing.length > 0) {
    throw new Error(
      `No such submodule: ${missing.join(', ')}. ` +
        `Known: ${all.map((m) => m.name).join(', ')}.`
    )
  }
  return { root, modules }
}

/**
 * Bring a distribution's readme up to what a command just changed.
 *
 * Its table names every module's version and pin, so a command that moves one
 * leaves it stale — and \`verify\` fails the pull request that forgot. Only the
 * distribution's own: a module's readme is the module's, and writing into one
 * would leave its submodule dirty.
 */
const refreshReadme = async (root: string): Promise<void> => {
  if (!isDistribution(root)) return
  try {
    const { updates } = await writeReadmes(root, { modules: false })
    for (const update of updates.filter((each) => each.changed)) {
      process.stdout.write(`${path.relative(root, update.file)} lists what it ships now.\n`)
    }
  } catch (error) {
    process.stderr.write(
      `The readme was not updated: ${error instanceof Error ? error.message : String(error)}\n` +
        'Run `pnpm dist readme` once that is sorted.\n'
    )
  }
}

const pad = (values: string[]): number =>
  values.reduce((widest, value) => Math.max(widest, value.length), 0)

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2))

  if (!args.command || args.command === 'help') {
    process.stdout.write(USAGE)
    return args.command ? 0 : 1
  }

  if (args.command === 'init') {
    const [kind, where] = args.names
    if (kind !== 'distribution' && kind !== 'monolith' && kind !== 'module') {
      process.stderr.write(
        'init needs a kind: "distribution", "monolith" or "module".\n'
      )
      return 1
    }

    const target = path.resolve(args.cwd, where ?? '.')
    await mkdir(target, { recursive: true })
    if (!(await isEmpty(target))) {
      process.stderr.write(`${target} is not empty; refusing to scaffold over it.\n`)
      return 1
    }

    const name = args.name ?? path.basename(target)
    // A module is consumed as a submodule, so record the URL it will be
    // cloned from in the form a keyless clone can use.
    const origin = args.url ? (args.ssh ? args.url : toHttps(args.url)) : undefined
    // Who holds the copyright on the MIT license it starts under: as given, or
    // whoever git says is making it.
    let copyright = args.copyright
    if (!copyright) {
      try {
        copyright = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || undefined
      } catch {
        copyright = undefined
      }
    }
    const files =
      kind === 'distribution'
        ? distributionRepo(name, origin, args.extends, { monolith: !args.separate, copyright })
        : kind === 'monolith'
          ? monolithRepo(name, origin, { copyright })
          : moduleRepo(name, origin, { copyright })
    const written = await write(target, files)

    if (args.git) {
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: target, stdio: 'ignore' })
        if (origin) {
          execFileSync('git', ['remote', 'add', 'origin', origin], {
            cwd: target,
            stdio: 'ignore',
          })
        }
      } catch {
        process.stderr.write('Could not run git init; scaffolding is still written.\n')
      }
    }

    for (const file of written) process.stdout.write(`  ${file}\n`)
    process.stdout.write(`\n${kind} scaffolded in ${target}.\n`)

    if (origin) {
      process.stdout.write(`origin is ${origin}\n`)
      if (args.url && origin !== args.url) {
        process.stdout.write(
          `(rewritten from ${args.url}; a submodule is cloned without an SSH key)\n`
        )
      }
    } else {
      process.stdout.write(
        'No remote set. Pass --url so a monolith can add this as a submodule.\n'
      )
    }

    process.stdout.write(
      kind === 'module'
        ? 'Next: pnpm install, then commit and push so a distribution can add it.\n'
        : args.extends && kind === 'distribution'
          ? `Next: pnpm install, then \`pnpm dist inherit\` to ship what ${args.extends} ships.\n`
          : 'Next: pnpm install, then `pnpm dist add-module <url>` to ship a module.\n'
    )
    return 0
  }


  if (args.command === 'add-module') {
    const [url] = args.names
    if (!url) {
      process.stderr.write('add-module needs a repository url.\n')
      return 1
    }

    const result = await addModule(args.cwd, url, {
      at: args.at,
      mount: args.name,
      ssh: args.ssh,
    })

    process.stdout.write(`Added ${result.relativePath} from ${result.url}\n`)
    if (result.packageName && result.version) {
      process.stdout.write(
        `Shipping ${result.packageName}@${result.version}, as the checkout declares it\n`
      )
    }
    if (result.rewritten) {
      process.stdout.write(
        `(rewritten from ${url}; a submodule is cloned without an SSH key)\n`
      )
    } else if (args.ssh && isSsh(result.url)) {
      process.stdout.write(
        `(recorded as SSH, so only clones with a key for ${describeRemote(result.url)} can build this)\n`
      )
    }
    if (result.linked && result.monolithPackageJson) {
      process.stdout.write(
        `Linked through the workspace in ` +
          `${path.relative(args.cwd, result.monolithPackageJson)}\n`
      )
    } else if (!result.packageName) {
      process.stdout.write('It has no package.json, so nothing was linked.\n')
    }

    if (result.overrides) {
      process.stdout.write(
        'Workspace overrides updated, so this resolves from the tree rather than npm\n'
      )
    } else if (result.overridesError) {
      process.stderr.write(
        `\nThe module is added, but the workspace overrides were not updated:\n` +
          `  ${result.overridesError}\n` +
          'Run `pnpm dist overrides` once that is sorted.\n'
      )
    }

    if (result.mounted && result.monolithConfig) {
      process.stdout.write(
        `Mounted at /${result.mount} in ${path.relative(args.cwd, result.monolithConfig)}\n`
      )
    } else if (result.mountError && result.monolithPackageJson) {
      process.stderr.write(
        `\nCould not mount it: ${result.mountError}\n` +
          `Add this to the monolith's Next config yourself:\n` +
          `    ${result.mount}: '${result.packageName ?? result.relativePath}',\n`
      )
    } else if (!result.isApp) {
      // A package is shared by the apps, not served at a path of its own.
      process.stdout.write(
        'It has no routes, so it is a package the apps depend on rather than one to mount.\n'
      )
    } else if (!result.monolithPackageJson) {
      // A distribution too complex to serve from one deployment has no
      // monolith; each app under apps/ is deployed on its own.
      process.stdout.write(
        'No monolith app here, so it is shipped but not mounted. Deploy it on its own.\n'
      )
    } else if (result.monolithConfig) {
      process.stdout.write(`Already mounted at /${result.mount}.\n`)
    }

    if (result.turbo) {
      process.stdout.write(
        "turbo.json: the monolith's build waits for its libraries, not its own build\n"
      )
    }
    const root = repositoryRoot(args.cwd)
    if (root) await refreshReadme(root)

    process.stdout.write(
      result.monolithPackageJson
        ? '\nRun pnpm install and `fg-monolith merge-package-json`.\n'
        : '\nRun pnpm install.\n'
    )
    return 0
  }


  if (args.command === 'readme') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    const { updates, modules, kind } = await writeReadmes(root, {
      check: args.check || args.dryRun,
    })
    const changed = updates.filter((update) => update.changed)

    for (const module of modules) {
      process.stdout.write(`${module.relativePath}  ${module.name}@${module.version}\n`)
    }

    if (changed.length === 0) {
      process.stdout.write(
        kind === 'module'
          ? 'This module\'s readme already states its version.\n'
          : '\nEvery readme already states its version.\n'
      )
      return 0
    }

    if (args.check) {
      process.stderr.write(
        `\n${changed.length} readme(s) are out of date:\n${changed
          .map((update) => `  ${path.relative(root, update.file)}`)
          .join('\n')}\nRun \`pnpm dist readme\` to update them.\n`
      )
      return 1
    }

    process.stdout.write(
      `\nUpdated:\n${changed
        .map((update) => `  ${path.relative(root, update.file)}`)
        .join('\n')}\n`
    )
    return 0
  }

  if (args.command === 'workflows') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    if (args.distribution) {
      const update = await writeDistributionWorkflow(root, { force: args.force, dryRun: args.dryRun })
      if (update.skipped) {
        process.stdout.write('The distribution has a publishing workflow already. Pass --force to overwrite it.\n')
        return 0
      }
      process.stdout.write(`${update.files.join(', ')}\n`)
      if (update.unprivated) {
        process.stdout.write('\nTook "private": true off package.json — a private package cannot publish.\n')
      }
      if (update.missingAccess) {
        process.stdout.write(
          'Nothing says whether it publishes publicly. For others to extend it, add\n' +
            '  "publishConfig": { "access": "public" }\n'
        )
      }
      process.stdout.write(
        '\nIt publishes the manifest, recording every module it ships, and its policy. ' +
          'Run the workflow to publish it; after each release, `pnpm next-version` starts the next.\n'
      )
      return 0
    }

    const updates = await writeWorkflows(root, {
      force: args.force,
      dryRun: args.dryRun,
      names: args.names,
    })
    // The distribution has its own checks too — the changelog for policy
    // changes, and what fg-dist writes — unless only some modules were named.
    if (isDistribution(root) && args.names.length === 0) {
      updates.push(await writeDistributionChecks(root, { force: args.force, dryRun: args.dryRun }))
    }

    if (updates.length === 0) {
      process.stdout.write(
        'No modules here. Run this in a distribution, which is where the modules are.\n'
      )
      return 0
    }

    const written = updates.filter((update) => !update.skipped)
    for (const update of updates) {
      process.stdout.write(
        update.skipped
          ? `${update.relativePath}  has one already\n`
          : `${update.relativePath}  ${update.files.join(', ')}\n`
      )
    }

    // A module's CI installs fg-dist from npm, so what these workflows run has
    // to be in a release it can install.
    const tool = await toolRelease()
    if (tool && tool.floor !== tool.own) {
      process.stderr.write(
        `\nfg-dist ${tool.own} is not released, so modules are given ^${tool.floor}, the newest that is.\n` +
          `Whatever these workflows run that is new since then fails in the modules' CI until\n` +
          `${tool.own} is published. Publish it, then run this again to move them up to it.\n`
      )
    }

    if (written.length === 0) {
      process.stdout.write(
        '\nEvery module already publishes. Pass --force to overwrite the workflows.\n'
      )
      return 0
    }

    const unprivated = written.filter((update) => update.unprivated)
    const missingFiles = written.filter((update) => update.missingFiles)

    if (args.dryRun) {
      process.stdout.write(`\n${written.length} module(s) would be written. Nothing changed.\n`)
      return 0
    }

    if (unprivated.length > 0) {
      process.stdout.write(
        `\nTook "private": true off ${unprivated.map((u) => u.relativePath).join(', ')} — ` +
          'a private package cannot publish.\n'
      )
    }
    const missingAccess = written.filter((update) => update.missingAccess)
    if (missingAccess.length > 0) {
      process.stdout.write(
        `\nNo "publishConfig.access" in ${missingAccess.map((u) => u.relativePath).join(', ')}.\n` +
          'Not set here, because npm treats an explicit value as an instruction to\n' +
          'change an existing package\'s visibility. Say which it is yourself:\n' +
          '  "publishConfig": { "access": "public" }      — and provenance is generated\n' +
          '  "publishConfig": { "access": "restricted" }  — and it is not\n'
      )
    }
    if (missingFiles.length > 0) {
      process.stdout.write(
        `\nNo "files" list in ${missingFiles.map((u) => u.relativePath).join(', ')}.\n` +
          'npm will ship whatever is in the directory. Say what belongs in the tarball:\n' +
          '  a module consumed as source ships "app", "lib", "public";\n' +
          '  one that builds ships "dist".\n'
      )
    }

    process.stdout.write(
      `\nWrote a workflow into ${written.length} module(s).\n` +
        'Each one is a separate repository, so commit and push them individually.\n' +
        'npm trusted publishing has to be configured per package before the first run:\n' +
        '  publish once from a workstation, then point the trusted publisher at\n' +
        '  .github/workflows/publish.yml in that module\'s repository.\n'
    )
    return 0
  }

  if (args.command === 'overrides') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    const { file, names, changed, missing } = await writeOverrides(root, {
      check: args.check || args.dryRun,
    })

    if (missing) {
      process.stderr.write(
        `There is no ${path.relative(root, file) || 'pnpm-workspace.yaml'} here. ` +
          'A distribution needs one before its modules can be overridden.\n'
      )
      return 1
    }

    if (names.length === 0) {
      process.stdout.write(
        'No modules here. Run this in a distribution, which is what does the overriding.\n'
      )
      return 0
    }

    for (const name of names) process.stdout.write(`  ${name}\n`)

    if (!changed) {
      process.stdout.write(`\n${path.relative(root, file)} already covers every module.\n`)
      return 0
    }

    if (args.dryRun) {
      process.stdout.write(`\n${path.relative(root, file)} would be updated.\n`)
      return 0
    }

    if (args.check) {
      process.stderr.write(
        `\n${path.relative(root, file)} does not match the modules here.\n` +
          'Run `pnpm dist overrides` to update it.\n'
      )
      return 1
    }

    process.stdout.write(
      `\nUpdated ${path.relative(root, file)}. Run \`pnpm install\` to take it up.\n`
    )
    return 0
  }

  if (args.command === 'canary') {
    const root = repositoryRoot(args.cwd) ?? args.cwd
    const result = await stampCanary(root, { dryRun: args.dryRun })
    await reportCanary(result)

    process.stdout.write(
      result.skip
        ? `${result.name}@${result.version} is already the canary for ${result.sha}.\n`
        : `${args.dryRun ? 'Would stamp' : 'Stamped'} ${result.name}@${result.version}\n`
    )
    return 0
  }

  // What the publish workflow runs before it publishes.
  if (args.command === 'release' && args.check) {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)
    const releasable = await checkReleasable(root)
    // A distribution records what it ships in what it publishes.
    if (isDistribution(root)) await stampModules(root, { version: releasable.version })
    await reportRelease(releasable)
    process.stdout.write(
      `${releasable.name}@${releasable.version} is not on npm; ready to release as ` +
        `${releasable.tag}.\n`
    )
    return 0
  }

  // `release`, as this was called before it said what it does: it starts the
  // next development cycle, and deciding its version is the whole of it. The
  // old name goes on working, for modules whose scripts still call it.
  if (args.command === 'next-version' || args.command === 'release') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)
    if (args.command === 'release') {
      process.stderr.write('`release` is `next-version` now: it starts the next development cycle.\n\n')
    }

    if (isDistribution(root)) {
      if (args.bump) {
        process.stderr.write(
          "A distribution's version is its month and its release: move it with " +
            '--id <alpha|beta|rc> or --stable, or neither to carry on as it is.\n'
        )
        return 1
      }
      const next = await releaseDistribution(root, {
        dryRun: args.dryRun,
        id: args.id,
        stable: args.stable,
        direct: args.direct,
        push: args.push,
      })
      const verb = args.dryRun ? 'Would move' : 'Moved'
      process.stdout.write(
        next.version === next.from
          ? `${next.name} ${next.from} is not published yet; it is what the publish workflow releases next.\n`
          : `${next.published ? `${next.from} is published. ` : `${next.from} was never published. `}` +
              `${verb} ${next.name} to ${next.version}.\n`
      )
      if (next.pushed) {
        process.stdout.write('Committed and pushed.\n')
      } else if (!args.dryRun && next.version !== next.from) {
        process.stdout.write(
          next.published
            ? `Commit it on a branch and open a pull request: merging it starts ${next.version}, ` +
                'and lets held pull requests through.\n'
            : `Commit it, and the publish workflow releases it as v${next.version}.\n`
        )
      }
      return 0
    }

    // Which way main moves on is a judgement about what changed, so it is asked
    // for rather than guessed at. Showing all three is the cheapest way to ask.
    if (!args.bump) {
      const { released, tagged, base } = await readRelease(root, { bump: 'minor' })
      if (!released.includes('-')) {
        process.stdout.write(
          `Released ${released}, ${tagged ? `tagged ${base}` : 'which is not tagged here'}\n\n` +
            'What is the next version?\n\n'
        )
        for (const bump of ['patch', 'minor', 'major'] as Bump[]) {
          const plan = planRelease(released, { bump })
          process.stdout.write(
            `  pnpm next-version --${bump.padEnd(6)} ${plan.next.version.padEnd(8)} ` +
              (plan.maintenance
                ? `${plan.maintenance.branch} keeps ${released.split('.').slice(0, 2).join('.')}.x\n`
                : 'stays on this line; nothing branches off\n')
          )
        }
        process.stdout.write(
          `\nOr \`pnpm dist prerelease --major\` to start the next line beside main, ` +
            'without\nmoving main off this one.\n'
        )
        return 1
      }
    }

    const outcome = await release(root, {
      bump: args.bump,
      id: args.id,
      dryRun: args.dryRun,
      push: args.push,
      direct: args.direct,
    })
    const { plan } = outcome

    // Straight onto the branch this runs on: what the publish workflow does.
    if (args.direct && !args.dryRun) {
      process.stdout.write(
        `Released ${plan.released}. ${outcome.base} starts ${plan.next.version}` +
          (plan.maintenance ? `; ${plan.maintenance.branch} maintains ${plan.maintenance.version}` : '') +
          (outcome.pushed ? '. Pushed.\n' : '. Left local.\n')
      )
      return 0
    }

    process.stdout.write(
      `Released ${plan.released}, ` +
        `${plan.tagged ? `tagged ${plan.base}` : 'which is not tagged here'}\n\n`
    )
    const width = pad([plan.maintenance?.branch ?? '', plan.next.branch])
    if (plan.maintenance) {
      process.stdout.write(
        `  ${plan.maintenance.branch.padEnd(width)}  ${plan.maintenance.version}  ` +
          `cut from ${plan.base}, where ${plan.released} is maintained\n`
      )
    }
    process.stdout.write(
      `  ${plan.next.branch.padEnd(width)}  ${plan.next.version}  ` +
        `opened against ${outcome.base}\n`
    )

    if (args.dryRun) {
      process.stdout.write('\nNothing written. Drop --dry-run to do it.\n')
      return 0
    }

    // Only worth saying when something was cut from the tag. A prerelease has
    // no maintenance branch, so there is nothing the missing tag affected.
    if (!plan.tagged && plan.maintenance) {
      process.stdout.write(
        `\nThere is no v${plan.released} tag here, so ${plan.maintenance.branch} was cut ` +
          `from HEAD.\nIf the release workflow has not run yet, run it first: the tag is ` +
          `what\nseparates the released commit from whatever ${outcome.base} has done since.\n`
      )
    }

    if (!outcome.pushed) {
      process.stdout.write('\nLeft local. Push them and open the pull request yourself.\n')
      return 0
    }

    process.stdout.write(
      outcome.pullRequest
        ? `\n${outcome.pullRequest}\n`
        : '\nPushed. `gh` is not here, so open the pull request yourself.\n'
    )
    return 0
  }

  if (args.command === 'prerelease') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    if (args.bump !== 'major' && args.bump !== 'minor') {
      process.stderr.write(
        'prerelease needs --major or --minor: which line is being started.\n'
      )
      return 1
    }

    const { plan, created, pushed } = await startPrerelease(root, {
      bump: args.bump,
      id: args.id,
      dryRun: args.dryRun,
      push: args.push,
    })

    process.stdout.write(
      `  ${plan.branch}  ${plan.version}  cut from ${plan.from}, which main keeps\n`
    )

    if (args.dryRun) {
      process.stdout.write('\nNothing written. Drop --dry-run to do it.\n')
      return 0
    }
    if (!created) return 1

    process.stdout.write(
      pushed
        ? `\nPushed. Release from it with a dist tag of its own — \`next\`, say — so\n` +
            '`latest` goes on meaning the line main is shipping.\n'
        : '\nLeft local. Push it when you are ready.\n'
    )
    return 0
  }

  if (args.command === 'policy') {
    const [action] = args.names
    if (action === 'use') {
      const { policy, status } = usePolicy(args.cwd)
      process.stdout.write(
        policy
          ? status === 0
            ? `Using ${path.relative(args.cwd, policy.built) || policy.built}.\n`
            : ''
          : 'No organization policy here: the built-in rules decide.\n'
      )
      return status
    }
    const policy = findPolicy(args.cwd)
    if (!policy) {
      process.stderr.write(`There is no organization policy here: no ${POLICIES}/.manifest above ${args.cwd}.\n`)
      return 1
    }
    if (action === 'build') return buildPolicy(policy, args.cwd, args.out)
    if (action === 'test') return testPolicy(policy, args.cwd)
    if (action === 'setup') {
      const differ = setupTurbo(policy, { check: args.check })
      if (differ.length === 0) {
        process.stdout.write('turbo.json builds the policy once, before each service that uses it.\n')
        return 0
      }
      process.stdout.write(
        `${args.check ? 'turbo.json is missing' : 'Wrote'} ${differ.join(', ')}${args.check ? '; run pnpm dist policy setup.' : ' into turbo.json.'}\n`
      )
      return args.check ? 1 : 0
    }
    process.stderr.write('Usage: fg-dist policy <build|test|use|setup>\n')
    return 1
  }

  if (args.command === 'check') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    const report = inspectExtends(root)

    if (!report.distribution.extends) {
      process.stdout.write(
        `${report.distribution.name} extends nothing, so there is no floor to check.\n`
      )
      return 0
    }

    if (report.unresolved) {
      process.stderr.write(
        `${report.distribution.name} extends ${report.unresolved}, which is not ` +
          'installed, so nothing could be compared against it.\n'
      )
      return 1
    }

    if (report.violations.length > 0) {
      process.stderr.write(`${describeViolations(report)}\n`)
      return 1
    }

    process.stdout.write(
      `${report.distribution.name}@${report.distribution.version} ships nothing older ` +
        `than ${report.parent?.name}@${report.parent?.version}.\n`
    )
    return 0
  }

  if (args.command === 'migrate') {
    // Where the build runs, not the repository: a monolith is one package of many.
    const root = args.cwd
    if (!existsSync(path.join(root, 'package.json'))) {
      throw new Error(`${root} has no package.json: run this where an app or a monolith is built.`)
    }
    if (args.status && args.rollback) throw new Error('--status or --rollback, not both.')
    // How far to roll back means nothing without rolling back — and ignored,
    // `--steps 2` would migrate forward instead.
    if (!args.rollback && (args.steps !== undefined || args.to !== undefined)) {
      throw new Error('--steps and --to say how far to roll back: they need --rollback.')
    }
    if (args.steps !== undefined && args.to !== undefined) throw new Error('--steps or --to, not both.')
    if (args.steps !== undefined && !(Number.isInteger(args.steps) && args.steps > 0)) {
      throw new Error('--steps is a whole number of migrations.')
    }

    // A build's environment, as Next's build reads it; by hand, the one being worked in.
    const envFiles = loadEnvFiles(root, { dev: !args.build && process.env.NODE_ENV !== 'production' })
    if (envFiles.length > 0) process.stdout.write(`Environment from ${envFiles.join(', ')}\n`)

    if (args.build) {
      const decision = inBuild(process.env)
      if (!decision.migrate) {
        process.stdout.write(`Not migrating: ${decision.reason}.\n`)
        return 0
      }
      process.stdout.write(`Migrating: ${decision.reason}.\n`)
    }

    let targets = migrationTargets(root)
    if (args.names.length > 0) {
      const unknown = args.names.filter((name) => !targets.some((target) => target.name === name))
      if (unknown.length > 0) {
        throw new Error(
          `Nothing here migrates ${unknown.join(', ')}. ` +
            (targets.length > 0 ? `What does: ${targets.map((target) => target.name).join(', ')}.` : '')
        )
      }
      targets = targets.filter((target) => args.names.includes(target.name))
    }
    if (targets.length === 0) {
      process.stdout.write('Nothing here declares migrations.\n')
      return 0
    }
    // Rolling back is one app's business: which one should not be a guess.
    if (args.rollback && targets.length > 1) {
      throw new Error(
        `Name the app to roll back: ${targets.map((target) => target.name).join(', ')}.`
      )
    }

    const action: MigrateAction = args.status
      ? { kind: 'status' }
      : args.rollback
        ? { kind: 'rollback', steps: args.steps, to: args.to }
        : { kind: 'migrate' }

    const results = await runMigrations(targets, { action, build: args.build })
    const width = pad(results.map((result) => result.target.name))
    for (const { target, database, changed, status: rows, skipped } of results) {
      const name = target.name.padEnd(width)
      const where = database ? `  (${database.variable})` : ''
      if (skipped) {
        process.stdout.write(`${name}  skipped: ${skipped}\n`)
      } else if (rows) {
        process.stdout.write(`${name}${where}\n`)
        for (const row of rows) {
          const when = row.appliedAt ? row.appliedAt.toISOString() : ''
          const down = row.reversible ? '' : ' (no down migration)'
          process.stdout.write(`  ${row.state.padEnd(8)} ${row.tag}${down} ${when}`.trimEnd() + '\n')
        }
      } else if (action.kind === 'rollback') {
        process.stdout.write(`${name}  ${changed.length ? `rolled back ${changed.join(', ')}` : 'nothing to roll back'}${where}\n`)
      } else {
        process.stdout.write(`${name}  ${changed.length ? `applied ${changed.join(', ')}` : 'up to date'}${where}\n`)
      }
    }
    return 0
  }

  if (args.command === 'env') {
    return envCommand(args)
  }

  if (args.command === 'verify') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    const checks = await verify(root)
    const width = pad(checks.map((check) => check.what))
    for (const check of checks) {
      if (check.ok) {
        process.stdout.write(`ok     ${check.what}\n`)
        continue
      }
      const problem = (check.problem ?? '').split('\n').join(`\n       ${' '.repeat(width)}  `)
      process.stderr.write(
        `stale  ${check.what.padEnd(width)}  ${problem}\n` +
          (check.fix ? `       ${' '.repeat(width)}  Run \`${check.fix}\`.\n` : '')
      )
    }
    return checks.every((check) => check.ok) ? 0 : 1
  }

  if (args.command === 'extract') {
    const [target] = args.names
    if (!target) {
      process.stderr.write('extract needs the directory to turn into a module.\n')
      return 1
    }
    if (!args.url) {
      process.stderr.write(
        'extract needs --url, the repository the module will live at.\n'
      )
      return 1
    }

    const result = await extractModule(args.cwd, target, {
      url: args.url,
      ssh: args.ssh,
      tag: args.tag,
    })

    process.stdout.write(
      `${result.relativePath} is now ${result.initialised ? 'a repository' : 'its own repository'}` +
        ` and a submodule of this one\n`
    )
    if (result.packageName && result.version) {
      process.stdout.write(`Shipping ${result.packageName}@${result.version}\n`)
    }
    if (result.tagged) {
      process.stdout.write(
        `Tagged ${result.tagged}, so sync can track it\n` +
          `  That tag is what the first release would have created, so release it\n` +
          `  with the next version rather than this one — or \`--no-tag\` next time.\n`
      )
    }
    if (result.overridesError) {
      process.stderr.write(
        `\nThe module is extracted, but the workspace overrides were not updated:\n` +
          `  ${result.overridesError}\n` +
          'Run `pnpm dist overrides` once that is sorted.\n'
      )
    }
    const root = repositoryRoot(args.cwd)
    if (root) await refreshReadme(root)
    process.stdout.write(`origin is ${result.url}\n`)
    if (result.rewritten) {
      process.stdout.write(
        `(rewritten from ${args.url}; a submodule is cloned without an SSH key)\n`
      )
    }

    // Nothing was pushed: the submodule points at a remote that may not exist
    // yet, which is fine here and fatal on anyone else's clone.
    process.stdout.write(
      `\nPush it before anyone else clones this:\n` +
        `    git -C ${result.relativePath} push -u origin main --tags\n` +
        'Then commit the new submodule here.\n'
    )
    return 0
  }

  if (args.command === 'use-https') {
    const { root, modules } = modulesFor(args.cwd, args.names)
    const ssh = modules.filter((module) => isSsh(module.url))

    if (ssh.length === 0) {
      process.stdout.write('Every submodule url is already https.\n')
      return 0
    }

    for (const module of ssh) {
      const https = toHttps(module.url)
      if (https === module.url) {
        process.stderr.write(`${module.relativePath}  no https form for ${module.url}\n`)
        continue
      }
      if (!args.dryRun) setUrl(root, module, https)
      process.stdout.write(`${module.relativePath}  ${module.url} -> ${https}\n`)
    }

    if (args.dryRun) {
      process.stdout.write('\nDry run; .gitmodules was not changed.\n')
      return 0
    }

    process.stdout.write('\n.gitmodules updated. Commit it to record the new urls.\n')

    // https is necessary but not sufficient: a keyless clone also needs the
    // repository to be readable without credentials.
    if (!args.verify) return 0

    process.stdout.write('\nChecking whether each can be cloned without credentials:\n')
    const privateOnes: string[] = []
    for (const module of ssh) {
      const https = toHttps(module.url)
      const reachable = isPublic(https)
      if (!reachable) privateOnes.push(module.relativePath)
      process.stdout.write(`  ${module.relativePath}  ${reachable ? 'public' : 'not readable'}\n`)
    }

    if (privateOnes.length > 0) {
      process.stdout.write(
        `\n${privateOnes.length} of these cannot be read anonymously, so a build ` +
          'host still cannot clone them. Make them public, or expect the build to fail.\n'
      )
      return 1
    }

    process.stdout.write('\nAll readable anonymously.\n')
    return 0
  }


  if (args.command === 'sync') {
    const { root, modules } = modulesFor(args.cwd, args.names)
    const states = modules.map((module) => inspect(module, { fetch: args.fetch }))
    const width = pad(states.map((state) => state.submodule.relativePath))

    for (const state of states) {
      process.stdout.write(
        `${state.submodule.relativePath.padEnd(width)}  ${describeState(state)}\n`
      )
    }

    // .gitmodules is committed, so an SSH URL is what a build host will try.
    const ssh = states.filter((state) => isSsh(state.submodule.url))
    if (ssh.length > 0) {
      process.stdout.write(
        `\n${ssh.length} module(s) are recorded with an ssh url, which a clone ` +
          'without a key cannot use:\n'
      )
      for (const state of ssh) {
        process.stdout.write(
          `  ${state.submodule.relativePath}  ${state.submodule.url}` +
            `  ->  ${toHttps(state.submodule.url)}\n`
        )
      }
      process.stdout.write(
        'Run `pnpm dist use-https` to rewrite them. They also have to be ' +
          'readable without credentials, which means public.\n'
      )
    }

    // A pin the remote does not have breaks every other clone, a build host's first.
    const unpushed = states.filter((state) => state.pushed === false)
    if (unpushed.length > 0) {
      process.stdout.write(
        `\n${unpushed.length} module(s) are pinned at a commit their remote does not have, ` +
          'so no other clone can check them out:\n'
      )
      for (const state of unpushed) {
        process.stdout.write(`  ${state.submodule.relativePath}  ${state.head.slice(0, 7)}\n`)
      }
      process.stdout.write(
        'Push them — `pnpm dist contribute <name>` does, for a change on its way upstream.\n'
      )
    }

    // A fork whose work upstream has taken can go back to upstream.
    const returnable = states.filter((state) => canReturn(state))
    if (returnable.length > 0) {
      process.stdout.write('\nUpstream has everything these forks add:\n')
      for (const state of returnable) {
        process.stdout.write(`  ${state.submodule.relativePath}  in ${canReturn(state)}\n`)
      }
      process.stdout.write(
        'Keep them, or `pnpm dist unfork <name>` to go back to upstream.\n'
      )
    }

    // An extension may move ahead of what it extends, never behind it.
    const extendsReport = inspectExtends(root)
    if (extendsReport.violations.length > 0) {
      process.stdout.write(`\n${describeViolations(extendsReport)}\n`)
    } else if (extendsReport.unresolved) {
      process.stdout.write(
        `\nThis extends ${extendsReport.unresolved}, which is not installed, ` +
          'so nothing could be compared against it.\n'
      )
    } else if (extendsReport.parent) {
      process.stdout.write(
        `\nUp to date with ${extendsReport.parent.name}@${extendsReport.parent.version}, ` +
          'which it extends.\n'
      )
    }

    const upgradable = states.filter((state) => target(state, { major: true }))
    const untagged = states.filter((state) => state.current === undefined)

    if (upgradable.length === 0) {
      process.stdout.write(
        untagged.length === states.length
          ? '\nNo module carries a version tag, so there is nothing to compare. ' +
              'Tag a release in each module to track it here.\n'
          : '\nEverything is on its newest version.\n'
      )
      if (untagged.length > 0 && untagged.length < states.length) {
        process.stdout.write(
          `${untagged.length} module(s) carry no version tag and were not compared.\n`
        )
      }
      return 0
    }

    // A major is only held back when it is newer than the non-major target.
    const held = upgradable.filter((state) => state.upgrades.major !== undefined)
    process.stdout.write(`\n${upgradable.length} module(s) have newer versions. `)
    process.stdout.write('Run `pnpm dist bump` to take them')
    process.stdout.write(
      held.length > 0
        ? `, or \`pnpm dist bump --major\` to include the ${held.length} major upgrade(s).\n`
        : '.\n'
    )
    return 0
  }


  if (args.command === 'bump') {
    const { root, modules } = modulesFor(args.cwd, args.names)
    const states = modules.map((module) => inspect(module, { fetch: args.fetch }))

    const moves = states
      .map((state) => ({ state, to: target(state, { major: args.major }) }))
      .filter((move): move is { state: SubmoduleState; to: string } => move.to !== undefined)

    if (moves.length === 0) {
      process.stdout.write('Nothing to bump.\n')
      const held = states.filter((state) => target(state, { major: true }))
      if (held.length > 0 && !args.major) {
        process.stdout.write(
          `${held.length} module(s) have a major upgrade available; pass --major to take it.\n`
        )
      }
      return 0
    }

    // Moving a dirty submodule would fail mid-checkout or discard work.
    const dirty = moves.filter((move) => move.state.dirty)
    if (dirty.length > 0) {
      process.stderr.write(
        `Refusing to bump, these have uncommitted changes:\n${dirty
          .map((move) => `  ${move.state.submodule.relativePath}`)
          .join('\n')}\n`
      )
      return 1
    }

    let failed = 0
    for (const { state, to } of moves) {
      const from = state.current ?? state.head.slice(0, 7)
      const line = `${state.submodule.relativePath}  ${from} -> ${to}`
      if (args.dryRun) {
        const how = !state.fork
          ? ''
          : containsAll(state.submodule.path, `refs/tags/${to}`, state.head)
            ? '  (fork: upstream has all of it; would move to it)'
            : '  (fork: would merge it in)'
        process.stdout.write(`${line}${how}\n`)
        continue
      }
      if (!state.fork) {
        moveTo(state.submodule, to)
        noteInDistribution(
          root,
          bumpEntry(
            moduleLabel(state.submodule.path).name,
            from,
            to,
            state.submodule.url,
            crossedReleases(state.available, to)
          )
        )
        process.stdout.write(`${line}\n`)
        continue
      }
      // A fork takes upstream's release by merging it, keeping its own work on top.
      try {
        const done = integrate(root, state, to, { push: args.push })
        process.stdout.write(
          done.how === 'moved'
            ? `${line}  (fork: upstream has all of it; \`pnpm dist unfork ${state.submodule.name}\` goes back)\n`
            : `${line}  (fork: merged${done.pushed ? `, pushed to ${done.pushed}` : ', not pushed'})\n`
        )
      } catch (error) {
        failed += 1
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      }
    }

    if (!args.dryRun) await refreshReadme(root)
    process.stdout.write(
      args.dryRun
        ? '\nDry run; nothing moved.\n'
        : '\nSubmodule pointers moved. Commit them to record the new versions.\n'
    )
    return failed > 0 ? 1 : 0
  }


  if (args.command === 'inherit') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)
    const result = await inherit(root, { dryRun: args.dryRun })
    const width = pad(result.added.map((module) => module.path))

    for (const module of result.added) {
      process.stdout.write(
        `${module.path.padEnd(width)}  ${module.name} ${module.version} at ${module.commit.slice(0, 7)}, ` +
          `from ${describeRemote(module.repository)}` +
          `${module.upstream ? ` (a fork of ${describeRemote(module.upstream)})` : ''}\n`
      )
    }
    for (const module of result.blocked) {
      process.stderr.write(
        `${module.path} has something in it already, so ${module.name} was not added there.\n`
      )
    }
    // The parent's notice goes with what is built on it.
    const license = result.license
    if (license.how === 'merged') {
      process.stdout.write(`LICENSE carries ${result.parent}'s copyright too: ${license.lines.join('; ')}\n`)
    } else if (license.how === 'copied') {
      process.stdout.write(`${license.file} keeps ${result.parent}'s license, which is not this one's.\n`)
    } else if (license.how === 'none') {
      process.stdout.write(`${result.parent} publishes no license to carry.\n`)
    }
    if (result.added.length === 0 && result.blocked.length === 0) {
      process.stdout.write(`Ships everything ${result.parent}@${result.parentVersion} ships already.\n`)
      return 0
    }
    if (!args.dryRun && result.added.length > 0) await refreshReadme(root)
    process.stdout.write(
      args.dryRun
        ? '\nDry run; nothing added.\n'
        : `\nShips what ${result.parent}@${result.parentVersion} ships. Run pnpm install, then commit.\n`
    )
    return result.blocked.length > 0 ? 1 : 0
  }


  if (args.command === 'changelog') {
    const [action, version] = args.names
    const root = repositoryRoot(args.cwd) ?? args.cwd

    if (action === 'check') {
      const actions = pullRequestFromActions()
      const pullRequest = args.pr ?? actions.pullRequest
      const base = args.base ?? actions.base
      const repository = args.repo ?? actions.repository
      if (!pullRequest || !base || !repository) {
        process.stderr.write(
          'changelog check runs on a pull request: in GitHub Actions, or given ' +
            '--pr <number> --base <ref> --repo <owner/name>.\n'
        )
        return 1
      }
      const result = checkChangelog(root, {
        pullRequest,
        base,
        repository,
        distribution: isDistribution(root),
        labels: actions.labels,
        server: actions.server,
      })
      ;(result.ok ? process.stdout : process.stderr).write(`${result.message}\n`)
      return result.ok ? 0 : 1
    }

    if (action === 'hold') {
      // The branch just released from: main, or a maintenance branch.
      const base =
        args.base ??
        process.env.GITHUB_REF_NAME ??
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const holds = holdPullRequests(root, { base })
      if (holds.length === 0) {
        process.stdout.write(`No pull requests are open into ${base}.\n`)
        return 0
      }
      for (const hold of holds) {
        process.stdout.write(
          hold.held
            ? `#${hold.pullRequest}  held${hold.run === undefined ? ', its first check will see the release' : ''}\n`
            : `#${hold.pullRequest}  could not be held: ${hold.problem}\n`
        )
      }
      return holds.every((hold) => hold.held) ? 0 : 1
    }

    if (action === 'notes') {
      const wanted = version ?? (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version as string)
      const text = await readFile(path.join(root, CHANGELOG), 'utf8').catch(() => '')
      const notes = notesFor(text, wanted)
      if (!notes) {
        process.stderr.write(`${CHANGELOG} says nothing for ${wanted}.\n`)
        return 1
      }
      process.stdout.write(notes)
      return 0
    }

    process.stderr.write('changelog needs `check`, `hold` or `notes`.\n')
    return 1
  }


  if (args.command === 'fork') {
    const [name, url] = args.names
    if (!name || !url) {
      process.stderr.write('fork needs a module and the url of your fork: pnpm dist fork <name> <url>\n')
      return 1
    }
    const { root, modules } = modulesFor(args.cwd, [name])
    const result = forkModule(root, modules[0], url, { ssh: args.ssh, push: args.push })
    await refreshReadme(root)

    process.stdout.write(
      `${modules[0].relativePath} is checked out from ${result.url}\n` +
        `forked from ${result.upstream}, which .gitmodules records as its upstream\n`
    )
    if (result.rewritten) {
      process.stdout.write(`(rewritten from ${url}; a submodule is cloned without an SSH key)\n`)
    }
    process.stdout.write(
      result.branch
        ? `Pinned commit pushed to ${result.branch}, where everything this distribution pins in the fork lives.\n`
        : 'Nothing pushed. The pinned commit has to be on the fork before anyone else can check it out.\n'
    )
    process.stdout.write(
      `\nNext: make the change on a branch in ${modules[0].relativePath}, then ` +
        `\`pnpm dist contribute ${modules[0].name}\`.\nCommit .gitmodules and ${modules[0].relativePath} here.\n`
    )
    return 0
  }


  if (args.command === 'contribute') {
    const [name] = args.names
    if (!name) {
      process.stderr.write('contribute needs a module: pnpm dist contribute <name>\n')
      return 1
    }
    const { root, modules } = modulesFor(args.cwd, [name])
    const result = contribute(root, modules[0], { push: args.push, base: args.base })

    if (!args.push) {
      process.stdout.write(
        `Would push ${result.branch} and open a pull request into ${describeRemote(result.repository)} ${result.base}.\n`
      )
      return 0
    }
    await refreshReadme(root)
    process.stdout.write(`Pushed ${result.branch}.\n`)
    if (result.pinnedOn) process.stdout.write(`Pinned commit kept on ${result.pinnedOn}, which outlives the pull request's branch.\n`)
    if (result.pullRequest) {
      process.stdout.write(`Opened ${result.pullRequest}\n`)
    } else if (result.compare) {
      process.stdout.write(`Open the pull request at\n  ${result.compare}\n`)
    } else {
      process.stdout.write(
        `Open a pull request from ${result.branch} into ${result.base} on ${describeRemote(result.repository)}.\n`
      )
    }
    if (result.changelog) {
      process.stdout.write(
        `\nIts changelog check wants a line in ${result.changelog.file}, under ${result.changelog.version}. ` +
          'The words are yours:\n' +
          `  ${result.changelog.line}\n` +
          'Commit it on the branch and push, then run this again to keep the pin current.\n'
      )
    }
    process.stdout.write(`\nCommit ${modules[0].relativePath} here to ship the change meanwhile.\n`)
    return 0
  }


  if (args.command === 'unfork') {
    const [name] = args.names
    if (!name) {
      process.stderr.write('unfork needs a module: pnpm dist unfork <name>\n')
      return 1
    }
    const { root, modules } = modulesFor(args.cwd, [name])
    const state = inspect(modules[0], { fetch: args.fetch })
    const result = unforkModule(root, state, { to: args.to, major: args.major, force: args.force })
    await refreshReadme(root)
    process.stdout.write(
      `${modules[0].relativePath} is checked out from ${result.url} again, at ${result.to}.\n` +
        `Commit .gitmodules and ${modules[0].relativePath} here. The fork itself is left as it is.\n`
    )
    return 0
  }


  process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`)
  return 1
}

/**
 * A question on the terminal, or undefined where there is nobody to ask.
 * With `hidden`, what is typed is not shown: a secret should not sit on the
 * screen, or in a recording of it.
 */
const prompt = async (question: string, { hidden = false } = {}): Promise<string | undefined> => {
  if (!process.stdin.isTTY) return undefined
  const { createInterface } = await import('node:readline/promises')
  const { Writable } = await import('node:stream')
  let muted = false
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stderr.write(chunk, encoding)
      done()
    },
  })
  const readline = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const answer = readline.question(question)
    muted = hidden
    return (await answer).trim() || undefined
  } finally {
    if (hidden) process.stderr.write('\n')
    readline.close()
  }
}

const envCommand = async (args: Args): Promise<number> => {
  const [action = 'check', ...variables] = args.names
  const environment = args.environment ?? 'production'
  if (!['production', 'preview'].includes(environment)) {
    throw new Error(`--environment is production or preview, not ${environment}.`)
  }

  // The build's own check: what this deployment is about to run with.
  if (action === 'check' && args.build) {
    const gate = process.env.FG_ENV_CHECK
    if (gate === 'skip') {
      process.stdout.write('Not checking the environment: FG_ENV_CHECK is skip.\n')
      return 0
    }
    if (!process.env.VERCEL && gate !== 'build') {
      process.stdout.write('Not checking the environment: this is not a Vercel build; FG_ENV_CHECK=build checks here.\n')
      return 0
    }
    const building = process.env.VERCEL_ENV ?? environment
    if (building !== 'production' && building !== 'preview') {
      process.stdout.write(`Not checking the environment: a ${building} build deploys nothing.\n`)
      return 0
    }
    loadEnvFiles(args.cwd, { dev: false })
    const deployment = deploymentAt(args.cwd)
    const distribution = distributionAround(args.cwd)
    const peers = distribution ? distributionDeployments(distribution).flatMap((each) => each.apps) : []
    const absent = missing(requirementsFor(deployment, building, peers), process.env)
    if (absent.length > 0) {
      process.stderr.write(`${describeMissing(deployment, building, absent)}\n`)
      return 1
    }
    process.stdout.write(`${deployment.name} has everything a ${building} deployment needs.\n`)
    return 0
  }

  const distribution = distributionAround(args.cwd) ?? args.cwd

  if (action === 'workflow') {
    const written = await writeRotationWorkflow(distribution, { force: args.force, dryRun: args.dryRun })
    process.stdout.write(
      written
        ? `${written}: rotates the secrets on the 1st of every month, and on demand.\n` +
            'It signs in to Vercel with VERCEL_TOKEN: add it to the repository\'s Actions secrets.\n'
        : 'The rotation workflow is there already. Pass --force to overwrite it.\n'
    )
    return 0
  }

  const remotes = await remotesOf(distribution, environment, {
    project: (at) => prompt(`Which Vercel project deploys ${at}? `),
    save: !args.dryRun,
  })

  if (action === 'check') {
    let failed = false
    for (const { remote, absent } of missingRemotely(remotes, environment)) {
      if (absent.length === 0) {
        process.stdout.write(`${remote.target.project} (${remote.at}) has everything ${environment} needs.\n`)
        continue
      }
      failed = true
      process.stderr.write(`${describeMissing(remote.deployment, environment, absent)}\n\n`)
    }
    return failed ? 1 : 0
  }

  if (action === 'setup') {
    const plan = await planSetup(remotes, environment, {
      ask: (requirement, remote) =>
        prompt(
          `${requirement.variable} for ${remote.target.project} — ${requirement.declaration.description}` +
            (requirement.declaration.example ? ` (e.g. ${requirement.declaration.example})` : '') +
            (requirement.declaration.sensitive ? ' (not shown as you type)' : '') +
            '\n  ',
          { hidden: Boolean(requirement.declaration.sensitive) }
        ),
    })
    const width = pad(plan.notes.map((each) => each.variable))
    for (const { remote, variable, source } of plan.notes) {
      process.stdout.write(`${remote.target.project}  ${variable.padEnd(width)}  ${source}\n`)
    }
    if (plan.writes.length === 0 && plan.unresolved.length === 0) {
      process.stdout.write(`Every project has what ${environment} needs.\n`)
      return 0
    }
    if (!args.dryRun && plan.writes.length > 0) {
      applySetup(plan, environment)
      process.stdout.write(
        `Set ${plan.writes.length} variables in ${environment}, every secret sensitive. They apply from the next deployment.\n`
      )
    } else if (args.dryRun) {
      process.stdout.write('Dry run: nothing set.\n')
    }
    for (const { remote, requirement, why } of plan.unresolved) {
      process.stderr.write(`${remote.target.project}  ${requirement.variable}: ${why}.\n`)
    }
    return plan.unresolved.length > 0 ? 1 : 0
  }

  if (action === 'rotate') {
    const phases = planRotation(remotes, variables)
    if (phases.length === 0) {
      process.stdout.write('Nothing to rotate: no rotated secret is set yet. `pnpm dist env setup` sets them.\n')
      return 0
    }
    phases.forEach((phase, index) => {
      if (phases.length > 1) process.stdout.write(`${index + 1}.\n`)
      for (const { remote, variable } of phase) process.stdout.write(`  ${remote.target.project}  ${variable}\n`)
    })
    if (args.dryRun) {
      process.stdout.write('Dry run: nothing rotated.\n')
      return 0
    }
    const redeploying = environment === 'production' && args.redeploy
    if (!args.yes) {
      const answer = await prompt(`Rotate these${redeploying ? ', redeploying production after each step' : ''}? [y/N] `)
      if (!/^y(es)?$/i.test(answer ?? '')) {
        process.stdout.write(answer === undefined ? 'Pass --yes to rotate without being asked.\n' : 'Nothing rotated.\n')
        return answer === undefined ? 1 : 0
      }
    }
    applyRotation(phases, environment, {
      redeploy: args.redeploy,
      onProgress: (line) => process.stdout.write(`${line}\n`),
    })
    if (!redeploying) process.stdout.write(`Rotated. They apply from the next ${environment} deployment.\n`)
    return 0
  }

  throw new Error(`env takes check, setup, rotate or workflow, not ${action}.`)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
)
