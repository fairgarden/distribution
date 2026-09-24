#!/usr/bin/env node
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { addModule } from './add-module.ts'
import { extractModule } from './extract.ts'
import { writeReadmes } from './readme.ts'
import { writeWorkflows } from './workflows.ts'
import { writeOverrides } from './overrides.ts'
import {
  checkReleasable,
  planRelease,
  readRelease,
  release,
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
import { buildPolicy, findPolicy, POLICIES, setupTurbo, testPolicy, usePolicy } from './policy.ts'
import {
  inspect,
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

Commands:
  init <kind> [dir]    Scaffold a repository; kind is "distribution", "monolith" or "module"
  add-module <url>     Add a module repository as a submodule and link it
  extract <path>       Turn a directory here into its own repository and submodule
  use-https [name...]  Rewrite submodule urls from ssh to https
  readme               Record versions in the readmes; run in a distribution or a module
  workflows            Give every module a publishing workflow
  overrides            Point the workspace at this distribution's own checkouts
  canary               Stamp a canary version into the manifest, for CI
  release              Move a module on from the release it just published
  prerelease           Start the next line on a branch, leaving main where it is
  check                Fail when this ships anything older than what it extends
  sync                 Report which modules have newer versions available
  bump [name...]       Move modules to their newest non-major version
  policy build         Build the organization's policy: policies/, on every module's own
  policy test          Test each module's rules, then the organization's on top of them
  policy use           Put the built policy beside this service, for it to run
  policy setup         Have turbo build the policy once, before each service that uses it

Options:
  --cwd <dir>          Repository directory (default: the working directory)
  --major              Allow major upgrades (bump); the next major (release, prerelease)
  --minor              Release the next minor, or branch one (release, prerelease)
  --patch              Release the next patch, staying on this line (release)
  --id <name>          Prerelease identifier: alpha, beta, rc (release, prerelease)
  --no-fetch           Use the refs already fetched (sync, bump)
  --dry-run            Report what would change without changing it
  --check              Verify instead of writing (readme, release, overrides)
                       --dry-run does the same for workflows, readme and overrides
  --name <name>        Package name for "init", mount name for add-module
  --at <dir>           Where add-module puts the submodule (default: apps/<name>)
  --no-git             Skip "git init" when scaffolding
  --url <git-url>      Remote the scaffolded repository will live at (init)
  --extends <name>     Distribution the scaffolded one extends (init distribution)
  --separate           Scaffold a distribution whose apps deploy separately
  --ssh                Record a submodule's URL as given, without rewriting it
  --no-verify          Skip checking whether the https urls can be cloned
  --no-tag             Do not tag the extracted module with its declared version
  --force              Overwrite workflows that are already there (workflows)
  --no-push            Leave the release branches local, and open no pull request
  --out <file>         Where policy build writes the bundle (default: policies/dist/)
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
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cwd') {
      args.cwd = path.resolve(argv[++index] ?? '.')
    } else if (arg === '--check') {
      args.check = true
    } else if (arg === '--major') {
      args.major = true
      args.bump = 'major'
    } else if (arg === '--minor') {
      args.bump = 'minor'
    } else if (arg === '--patch') {
      args.bump = 'patch'
    } else if (arg === '--id') {
      args.id = argv[++index]
    } else if (arg === '--no-fetch') {
      args.fetch = false
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--name') {
      args.name = argv[++index]
    } else if (arg === '--at') {
      args.at = argv[++index]
    } else if (arg === '--no-git') {
      args.git = false
    } else if (arg === '--url') {
      args.url = argv[++index]
    } else if (arg === '--extends') {
      args.extends = argv[++index]
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
    } else if (arg === '--out') {
      args.out = path.resolve(argv[++index] ?? '.')
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
    const files =
      kind === 'distribution'
        ? distributionRepo(name, origin, args.extends, { monolith: !args.separate })
        : kind === 'monolith'
          ? monolithRepo(name, origin)
          : moduleRepo(name, origin)
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
        : 'Next: pnpm install, then `fg-dist add-module <url>` to ship a module.\n'
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
          'Run `fg-dist overrides` once that is sorted.\n'
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
          .join('\n')}\nRun \`fg-dist readme\` to update them.\n`
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

    const updates = await writeWorkflows(root, {
      force: args.force,
      dryRun: args.dryRun,
    })

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
          'Run `fg-dist overrides` to update it.\n'
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

  if (args.command === 'release') {
    const root = repositoryRoot(args.cwd)
    if (!root) throw new Error(`${args.cwd} is not inside a git repository.`)

    if (args.check) {
      const releasable = await checkReleasable(root)
      await reportRelease(releasable)
      process.stdout.write(
        `${releasable.name}@${releasable.version} is not on npm; ready to release as ` +
          `${releasable.tag}.\n`
      )
      return 0
    }

    // Which way main moves on is a judgement about what changed, so it is asked
    // for rather than guessed at. Showing all three is the cheapest way to ask.
    if (!args.bump) {
      const { released, tagged, base } = await readRelease(root, { bump: 'minor' })
      if (!released.includes('-')) {
        process.stdout.write(
          `Released ${released}, ${tagged ? `tagged ${base}` : 'which is not tagged here'}\n\n` +
            'Which way does main move on?\n\n'
        )
        for (const bump of ['patch', 'minor', 'major'] as Bump[]) {
          const plan = planRelease(released, { bump })
          process.stdout.write(
            `  --${bump.padEnd(6)} ${plan.next.version.padEnd(8)} ` +
              (plan.maintenance
                ? `${plan.maintenance.branch} keeps ${released.split('.').slice(0, 2).join('.')}.x\n`
                : 'stays on this line; nothing branches off\n')
          )
        }
        process.stdout.write(
          `\nOr \`fg-dist prerelease --major\` to start the next line beside main, ` +
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
    })
    const { plan } = outcome

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
        `${args.check ? 'turbo.json is missing' : 'Wrote'} ${differ.join(', ')}${args.check ? '; run fg-dist policy setup.' : ' into turbo.json.'}\n`
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
          'Run `fg-dist overrides` once that is sorted.\n'
      )
    }
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
        'Run `fg-dist use-https` to rewrite them. They also have to be ' +
          'readable without credentials, which means public.\n'
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
    process.stdout.write('Run `fg-dist bump` to take them')
    process.stdout.write(
      held.length > 0
        ? `, or \`fg-dist bump --major\` to include the ${held.length} major upgrade(s).\n`
        : '.\n'
    )
    return 0
  }


  if (args.command === 'bump') {
    const { modules } = modulesFor(args.cwd, args.names)
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

    for (const { state, to } of moves) {
      const from = state.current ?? state.head.slice(0, 7)
      if (args.dryRun) {
        process.stdout.write(`${state.submodule.relativePath}  ${from} -> ${to}\n`)
        continue
      }
      moveTo(state.submodule, to)
      process.stdout.write(`${state.submodule.relativePath}  ${from} -> ${to}\n`)
    }

    process.stdout.write(
      args.dryRun
        ? '\nDry run; nothing moved.\n'
        : '\nSubmodule pointers moved. Commit them to record the new versions.\n'
    )
    return 0
  }


  process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`)
  return 1
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
