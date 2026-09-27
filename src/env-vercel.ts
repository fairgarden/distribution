import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  distributionDeployments,
  missing,
  requirementsFor,
  type Deployment,
  type EnvApp,
  type EnvDeclaration,
  type Requirement,
} from './env.ts'
import {
  addVariable,
  listVariables,
  productionDeployment,
  redeploy,
  updateVariable,
  type VercelProject,
  type VercelVariable,
} from './vercel.ts'

/**
 * Setting up and rotating a distribution's variables on Vercel.
 *
 * Which Vercel project each deployment is lives in the distribution's
 * package.json, under `distribution.vercel`, so a scheduled rotation in CI
 * finds them without a `vercel link`:
 *
 * ```json
 * "distribution": { "vercel": { "scope": "acme", "projects": { "apps/monolith": "acme-core" } } }
 * ```
 */

export interface VercelConfig {
  scope?: string
  /** Deployment, as its path in the distribution, to Vercel project. */
  projects: Record<string, string>
}

const manifestPath = (distribution: string) => path.join(distribution, 'package.json')

export const readVercelConfig = (distribution: string): VercelConfig => {
  const manifest = JSON.parse(readFileSync(manifestPath(distribution), 'utf8')) as {
    distribution?: { vercel?: Partial<VercelConfig> }
  }
  const vercel = manifest.distribution?.vercel ?? {}
  return { scope: vercel.scope, projects: { ...vercel.projects } }
}

export const saveVercelConfig = (distribution: string, config: VercelConfig): void => {
  const manifest = JSON.parse(readFileSync(manifestPath(distribution), 'utf8')) as Record<string, unknown>
  const current = (manifest.distribution ?? {}) as Record<string, unknown>
  manifest.distribution = {
    ...current,
    vercel: { ...(config.scope ? { scope: config.scope } : {}), projects: config.projects },
  }
  writeFileSync(manifestPath(distribution), `${JSON.stringify(manifest, null, 2)}\n`)
}

export const newSecret = (): string => randomBytes(32).toString('base64url')

/** Variables tied by `sameAs`, each mapped to every variable in its group. */
const groupsOf = (apps: EnvApp[]): Map<string, string[]> => {
  const parent = new Map<string, string>()
  const find = (variable: string): string => {
    const up = parent.get(variable) ?? variable
    if (up === variable) return variable
    const root = find(up)
    parent.set(variable, root)
    return root
  }
  for (const app of apps) {
    for (const [variable, declaration] of Object.entries(app.env)) {
      if (declaration.sameAs) parent.set(find(variable), find(declaration.sameAs))
    }
  }
  const members = new Map<string, string[]>()
  for (const variable of new Set([...parent.keys(), ...parent.values()])) {
    const root = find(variable)
    members.set(root, [...(members.get(root) ?? []), variable])
  }
  const groups = new Map<string, string[]>()
  for (const group of members.values()) for (const variable of group) groups.set(variable, group)
  return groups
}

export interface Remote {
  deployment: Deployment
  /** Where it is, relative to the distribution. */
  at: string
  target: VercelProject
  existing: Map<string, VercelVariable>
}

/**
 * Each deployment and what its Vercel project has set. `project` is asked for
 * a deployment with no project yet, and what it answers is kept.
 */
export const remotesOf = async (
  distribution: string,
  environment: string,
  { project }: { project?: (at: string, deployment: Deployment) => Promise<string | undefined> } = {}
): Promise<Remote[]> => {
  const config = readVercelConfig(distribution)
  const remotes: Remote[] = []
  let changed = false
  for (const deployment of distributionDeployments(distribution)) {
    const at = path.relative(distribution, deployment.root) || '.'
    let name: string | undefined = config.projects[at]
    if (!name && project) {
      name = await project(at, deployment)
      if (name) {
        config.projects[at] = name
        changed = true
      }
    }
    if (!name) {
      throw new Error(
        `Which Vercel project deploys ${at}? Add it to package.json:\n` +
          `  "distribution": { "vercel": { "projects": { "${at}": "<project>" } } }`
      )
    }
    const target = { project: name, scope: config.scope }
    remotes.push({ deployment, at, target, existing: listVariables(target, environment) })
  }
  if (changed) saveVercelConfig(distribution, config)
  return remotes
}

/** What is set, as an environment: a sensitive variable is set without a value to read. */
const asEnv = (existing: Map<string, VercelVariable>): Record<string, string> =>
  Object.fromEntries([...existing].map(([key, variable]) => [key, variable.value ?? 'set']))

const everyApp = (remotes: Remote[]): EnvApp[] => remotes.flatMap((remote) => remote.deployment.apps)

/** What each deployment's project is missing for `environment`. */
export const missingRemotely = (remotes: Remote[], environment: string) =>
  remotes.map((remote) => ({
    remote,
    absent: missing(requirementsFor(remote.deployment, environment, everyApp(remotes)), asEnv(remote.existing)),
  }))

/** Only an app can keep it from being read; a random value nobody typed is a secret too. */
const isSensitive = (declaration: EnvDeclaration): boolean =>
  !declaration.rotate && Boolean(declaration.sensitive || declaration.generate)

export interface PlannedVariable {
  remote: Remote
  variable: string
  value: string
  sensitive: boolean
  /** Where the value came from, in words. */
  source: string
}

export interface SetupPlan {
  planned: PlannedVariable[]
  /** What could not be set from here, and why. */
  unresolved: Array<{ remote: Remote; requirement: Requirement; why: string }>
}

/**
 * What setting up `environment` adds: every variable a deployment has to have
 * and its project does not. A generated secret is made once and set alike
 * wherever `sameAs` ties it, reusing one already set; a fixed value is set as
 * is; anything else is asked for, or left unresolved.
 */
export const planSetup = async (
  remotes: Remote[],
  environment: string,
  { ask }: { ask?: (requirement: Requirement, remote: Remote) => Promise<string | undefined> } = {}
): Promise<SetupPlan> => {
  const groups = groupsOf(everyApp(remotes))
  const values = new Map<string, { value: string; source: string }>()
  // A value one side already has is the one the other has to match.
  for (const remote of remotes) {
    for (const [variable, { value }] of remote.existing) {
      if (!value) continue
      for (const tied of groups.get(variable) ?? []) {
        if (tied !== variable) values.set(tied, { value, source: `the same as ${variable}` })
      }
    }
  }

  const plan: SetupPlan = { planned: [], unresolved: [] }
  for (const { remote, absent } of missingRemotely(remotes, environment)) {
    for (const requirement of absent) {
      const { declaration } = requirement
      if (requirement.anyOf.length > 1) {
        plan.unresolved.push({ remote, requirement, why: 'connect Neon to the project, which sets DATABASE_URL' })
        continue
      }
      let decided = values.get(requirement.variable)
      if (!decided && declaration.value !== undefined) decided = { value: declaration.value, source: 'as declared' }
      if (!decided && declaration.generate) decided = { value: newSecret(), source: 'generated' }
      if (!decided && ask) {
        const answer = (await ask(requirement, remote))?.trim()
        if (answer) decided = { value: answer, source: 'as given' }
      }
      if (!decided) {
        plan.unresolved.push({ remote, requirement, why: 'nothing to set it to' })
        continue
      }
      for (const tied of groups.get(requirement.variable) ?? []) {
        if (tied !== requirement.variable && !values.has(tied)) {
          values.set(tied, { value: decided.value, source: `the same as ${requirement.variable}` })
        }
      }
      plan.planned.push({
        remote,
        variable: requirement.variable,
        value: decided.value,
        sensitive: isSensitive(declaration),
        source: decided.source,
      })
    }
  }
  return plan
}

export const applySetup = (plan: SetupPlan, environment: string): void => {
  for (const { remote, variable, value, sensitive } of plan.planned) {
    addVariable(remote.target, variable, environment, value, { sensitive })
  }
}

export interface Rotation {
  remote: Remote
  variable: string
  value: string
  /** Shared with nothing else, so its order does not matter. */
  alone: boolean
}

/**
 * The order rotating goes in, a phase at a time, each redeployed before the
 * next: what checks a shared secret first — it takes the new value and keeps
 * accepting the old — then what sends it. Every value becomes the new one
 * and the one before it; the one before that is dropped.
 */
export const planRotation = (remotes: Remote[], only: string[] = []): Rotation[][] => {
  const groups = groupsOf(everyApp(remotes))
  const fresh = new Map<string, string>()
  const phases: Rotation[][] = [[], []]

  for (const remote of remotes) {
    const here = new Set(remote.deployment.apps.map((app) => app.name))
    for (const app of everyApp(remotes)) {
      for (const [variable, declaration] of Object.entries(app.env)) {
        if (!declaration.rotate || !here.has(declaration.deployment ?? app.name)) continue
        const current = remote.existing.get(variable)
        if (!current) continue
        const group = groups.get(variable) ?? [variable]
        if (only.length > 0 && !group.some((tied) => only.includes(tied))) continue
        if (current.value === undefined) {
          throw new Error(
            `${variable} is sensitive in ${remote.target.project}, so its current value cannot be kept for the switch. ` +
              'Remove it, and `pnpm dist env setup` adds it again, readable.'
          )
        }
        const key = group[0]
        if (!fresh.has(key)) fresh.set(key, newSecret())
        const kept = current.value.split(/[\s,]+/).filter(Boolean)[0]
        const value = [fresh.get(key)!, ...(kept ? [kept] : [])].join(' ')
        const sends = Boolean(declaration.sameAs) && !declaration.verifies
        const alone = group.length === 1
        phases[sends ? 1 : 0].push({ remote, variable, value, alone })
      }
    }
  }
  // A secret nothing else shares can wait for its deployment's last step:
  // one redeploy then, rather than one for it and another after.
  const last = new Set(phases[1].map((rotation) => rotation.remote))
  const moved = phases[0].filter((rotation) => rotation.alone && last.has(rotation.remote))
  phases[0] = phases[0].filter((rotation) => !moved.includes(rotation))
  phases[1].push(...moved)
  return phases.filter((phase) => phase.length > 0)
}

export interface RotationReport {
  variable: string
  project: string
  /** The deployment redeployed after it, if any. */
  redeployed?: string
}

/** Rotate phase by phase, redeploying production after each so the next can rely on it. */
export const applyRotation = (
  phases: Rotation[][],
  environment: string,
  { redeploy: shouldRedeploy = true, onProgress }: { redeploy?: boolean; onProgress?: (line: string) => void } = {}
): void => {
  for (const phase of phases) {
    for (const { remote, variable, value } of phase) {
      updateVariable(remote.target, variable, environment, value)
      onProgress?.(`${remote.target.project}  ${variable}  rotated`)
    }
    if (environment !== 'production' || !shouldRedeploy) continue
    for (const remote of new Set(phase.map((rotation) => rotation.remote))) {
      const live = productionDeployment(remote.target)
      if (!live) {
        onProgress?.(`${remote.target.project}  nothing in production to redeploy`)
        continue
      }
      onProgress?.(`${remote.target.project}  redeploying production…`)
      const url = redeploy(remote.target, live)
      onProgress?.(`${remote.target.project}  ${url || 'redeployed'}`)
    }
  }
}
