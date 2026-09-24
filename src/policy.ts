import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * A distribution's policy: the organization's rules for every service it
 * ships, kept in `policies/` beside `apps/` and `packages/`, and marked by the
 * `.manifest` that says whose they are.
 *
 * It is built in layers — each module's own `policies/`, then the policy of
 * any distribution this one extends, then its own — into one bundle, named
 * after the distribution's version and what is in it. `policies/` is a
 * workspace package, so turbo builds it once, and every service's build
 * takes a copy (`fg-dist policy use`) to run. Upgrading a module brings its
 * rules; the organization's stay as they were.
 *
 * Compiling is `@fairgarden/policy`'s: this finds the layers and hands them
 * to whichever `fg-policy` the distribution installed.
 */

export const POLICIES = 'policies'
/** Where the bundle is built, inside `policies/`. */
export const BUILT = path.join('dist', 'policies.tar.gz')
/** Where a service runs it from, inside the service; `@fairgarden/policy` looks there. */
export const USED = path.join('.policy', 'policies.tar.gz')
/** What marks a project as running the policy, in its build script. */
const USES = 'fg-dist policy use'

export interface DistributionPolicy {
  /** The distribution's root. */
  root: string
  /** Its `policies/`. */
  dir: string
  /** The distribution's version: the release every revision belongs to. */
  version: string | undefined
  /** Each module's own `policies/`. */
  bases: string[]
  /** The published `policies/` of each distribution this extends, the furthest first. */
  parents: string[]
  /** Where the bundle is built. */
  built: string
}

interface PackageJson {
  name?: string
  version?: string
  scripts?: Record<string, string>
  distribution?: { extends?: string }
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T

/** A `policies/` with a `.manifest` is an organization's; a module's own has none. */
const isOrganizations = (dir: string) => existsSync(path.join(dir, '.manifest'))

/** The published policy of what `root` extends, and of what that extends, the furthest first. */
const parentsOf = (root: string, seen = new Set<string>()): string[] => {
  const parent = readJson<PackageJson>(path.join(root, 'package.json')).distribution?.extends
  if (!parent || seen.has(parent)) return []
  seen.add(parent)
  let parentRoot: string
  try {
    parentRoot = path.dirname(createRequire(path.join(root, 'package.json')).resolve(`${parent}/package.json`))
  } catch {
    // Not installed: `fg-dist check` says so; there is nothing to build on.
    return []
  }
  const dir = path.join(parentRoot, POLICIES)
  return [...parentsOf(parentRoot, seen), ...(isOrganizations(dir) ? [dir] : [])]
}

const describe = (root: string): DistributionPolicy => {
  const bases: string[] = []
  for (const group of ['apps', 'packages']) {
    const entries = existsSync(path.join(root, group)) ? readdirSync(path.join(root, group)).sort() : []
    for (const name of entries) {
      const dir = path.join(root, group, name, POLICIES)
      if (existsSync(dir) && statSync(dir).isDirectory() && !isOrganizations(dir)) bases.push(dir)
    }
  }
  const dir = path.join(root, POLICIES)
  return {
    root,
    dir,
    version: readJson<PackageJson>(path.join(root, 'package.json')).version,
    bases,
    parents: parentsOf(root),
    built: path.join(dir, BUILT),
  }
}

/**
 * The distribution around `from`, if it has a policy: the nearest directory
 * above with an organization's `policies/`. Found on disk rather than by
 * git, which a build host may not have, and which stops at a submodule.
 */
export const findPolicy = (from: string): DistributionPolicy | undefined => {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (path.basename(dir) === POLICIES && isOrganizations(dir)) return describe(path.dirname(dir))
    if (isOrganizations(path.join(dir, POLICIES))) return describe(dir)
    if (path.dirname(dir) === dir) return undefined
  }
}

/** Where a package is installed, seen from `base`, whether or not it exports its package.json. */
const packageDir = (base: string, name: string): string | undefined => {
  const require = createRequire(path.join(base, 'package.json'))
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    // Not exported: find it from its entry point instead.
  }
  try {
    for (let dir = path.dirname(require.resolve(name)); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      const file = path.join(dir, 'package.json')
      if (existsSync(file) && readJson<PackageJson>(file).name === name) return dir
    }
  } catch {
    // Not installed here.
  }
  return undefined
}

/** The `fg-policy` the distribution installed, from `from` or its root. */
const fgPolicy = (policy: DistributionPolicy, from: string): string => {
  for (const base of [from, policy.dir, policy.root]) {
    const dir = packageDir(base, '@fairgarden/policy')
    if (!dir) continue
    const { bin } = readJson<{ bin: Record<string, string> }>(path.join(dir, 'package.json'))
    return path.join(dir, bin['fg-policy'])
  }
  throw new Error('@fairgarden/policy is not installed here; add it to policies/package.json.')
}

const layerArgs = (policy: DistributionPolicy) => {
  const relative = (dir: string) => path.relative(policy.root, dir)
  return [
    '--dir',
    relative(policy.dir),
    ...policy.bases.flatMap((dir) => ['--base', relative(dir)]),
    ...policy.parents.flatMap((dir) => ['--parent', relative(dir)]),
  ]
}

const run = (policy: DistributionPolicy, from: string, args: string[]) => {
  const result = spawnSync(process.execPath, [fgPolicy(policy, from), ...args], { cwd: policy.root, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

/**
 * What the bundle is built from, as a digest: every rule, setting and
 * manifest in every layer, and the version it is named after. A bundle built
 * from anything else — a rule since changed, added or deleted — is out of date.
 */
export const inputsDigest = (policy: DistributionPolicy): string => {
  const hash = createHash('sha256').update(`${policy.version ?? ''}\0`)
  for (const dir of [...policy.bases, ...policy.parents, policy.dir]) {
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => !file.split(path.sep).some((part) => part === 'node_modules' || part === 'dist'))
      .filter((file) => /(\.rego|data\.json|\.manifest)$/.test(file))
      .sort()
    for (const file of files) {
      hash.update(`${path.relative(policy.root, path.join(dir, file)).split(path.sep).join('/')}\0`)
      hash.update(readFileSync(path.join(dir, file))).update('\0')
    }
  }
  return hash.digest('hex')
}

/** Beside the bundle: the digest of what it was built from. */
const inputsFile = (built: string) => `${built}.inputs`

/** Build the bundle, named after the distribution's version. */
export const buildPolicy = (policy: DistributionPolicy, from = policy.root, out = policy.built): number => {
  const digest = inputsDigest(policy)
  const status = run(policy, from, [
    'build',
    ...layerArgs(policy),
    ...(policy.version ? ['--release', policy.version] : []),
    '--out',
    out,
  ])
  if (status === 0) writeFileSync(inputsFile(out), `${digest}\n`)
  return status
}

/** Each module's tests on its own rules, then the organization's on them all. */
export const testPolicy = (policy: DistributionPolicy, from = policy.root): number =>
  run(policy, from, ['test', ...layerArgs(policy)])

/**
 * Put the distribution's policy beside the service in `project`, for it to
 * run: the bundle turbo already built, or one built now if there is none, or
 * it was built from anything other than the rules as they are. Outside a
 * distribution, nothing — and no copy left from before: the service's
 * built-in rules decide.
 */
export const usePolicy = (project: string): { policy?: DistributionPolicy; status: number } => {
  const used = path.join(project, USED)
  const policy = findPolicy(project)
  if (!policy) {
    rmSync(used, { force: true })
    return { status: 0 }
  }
  const built = existsSync(inputsFile(policy.built)) ? readFileSync(inputsFile(policy.built), 'utf8').trim() : undefined
  if (!existsSync(policy.built) || built !== inputsDigest(policy)) {
    const status = buildPolicy(policy, project)
    if (status !== 0) return { policy, status }
  }
  mkdirSync(path.dirname(used), { recursive: true })
  // Whole or not at all, for a server reading it meanwhile.
  const partial = `${used}.${process.pid}.partial`
  copyFileSync(policy.built, partial)
  renameSync(partial, used)
  return { policy, status: 0 }
}

type TurboTask = { dependsOn?: string[]; inputs?: string[]; outputs?: string[]; [key: string]: unknown }

/**
 * What turbo needs, so the policy is built once however many services run
 * it: the policy's own tasks, which read every module's rules as well as its
 * own, and each project whose build uses it waiting for it to be built.
 */
export const turboTasks = (
  policy: DistributionPolicy,
  generic: TurboTask,
  genericDev: TurboTask = { persistent: true, cache: false }
): Record<string, TurboTask> => {
  const name = readJson<PackageJson>(path.join(policy.dir, 'package.json')).name
  if (!name) throw new Error(`${path.join(POLICIES, 'package.json')} needs a name.`)
  const inputs = [
    '$TURBO_DEFAULT$',
    '$TURBO_ROOT$/apps/*/policies/**',
    '$TURBO_ROOT$/packages/*/policies/**',
    // The distribution's version names every revision.
    '$TURBO_ROOT$/package.json',
    // What it extends is installed, so its policy changes with the lockfile.
    ...(policy.parents.length > 0 ? ['$TURBO_ROOT$/pnpm-lock.yaml'] : []),
  ]
  // Not hashed: which opa compiles it changes nothing, and the commit is only
  // where a revision was first built — the same rules are the same revision.
  // A signing key is hashed, so adding one does not bring back an unsigned build.
  const passThroughEnv = ['OPA', 'VERCEL_GIT_COMMIT_SHA', 'GITHUB_SHA']
  const tasks: Record<string, TurboTask> = {
    [`${name}#build`]: { dependsOn: ['^build'], inputs, outputs: ['dist/**'], env: ['FG_POLICY_SIGNING_KEY'], passThroughEnv },
    [`${name}#test`]: { dependsOn: ['^build'], inputs, passThroughEnv: ['OPA'] },
  }
  for (const group of ['apps', 'packages']) {
    const entries = existsSync(path.join(policy.root, group)) ? readdirSync(path.join(policy.root, group)).sort() : []
    for (const entry of entries) {
      const file = path.join(policy.root, group, entry, 'package.json')
      if (!existsSync(file)) continue
      const pkg = readJson<PackageJson>(file)
      if (!pkg.name) continue
      if (pkg.scripts?.build?.includes(USES)) {
        tasks[`${pkg.name}#build`] = {
          ...generic,
          dependsOn: [...(generic.dependsOn ?? []), `${name}#build`],
          // The copy it runs is part of what it built: a cached build brings it back.
          outputs: [...(generic.outputs ?? []), `${path.dirname(USED)}/**`],
        }
      }
      // A fresh checkout has built neither the policy nor the tools that build it.
      if (pkg.scripts?.dev?.includes(USES)) {
        tasks[`${pkg.name}#dev`] = { ...genericDev, dependsOn: [...(genericDev.dependsOn ?? []), `${name}#build`] }
      }
    }
  }
  return tasks
}

/**
 * Write the policy's tasks into turbo.json, or with `check`, say which are
 * missing or out of date. Returns what differed.
 */
export const setupTurbo = (policy: DistributionPolicy, { check = false } = {}): string[] => {
  const file = path.join(policy.root, 'turbo.json')
  const turbo = readJson<{ tasks?: Record<string, TurboTask> }>(file)
  const tasks = turbo.tasks ?? {}
  const wanted = turboTasks(policy, tasks.build ?? { dependsOn: ['^build'] }, tasks.dev)
  const differ = Object.keys(wanted).filter((key) => JSON.stringify(tasks[key]) !== JSON.stringify(wanted[key]))
  if (!check && differ.length > 0) {
    turbo.tasks = { ...tasks, ...wanted }
    writeFileSync(file, `${JSON.stringify(turbo, null, 2)}\n`)
  }
  return differ
}
