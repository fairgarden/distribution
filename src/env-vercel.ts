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
  UNREADABLE,
} from './env.ts'
import {
  listVariables,
  productionDeployment,
  redeploy,
  removeVariable,
  setVariable,
  type VercelProject,
  type VercelVariable,
} from './vercel.ts'
import { otherSlot, pointerVariable, SLOTS, slotVariable, type Slot } from './secrets.ts'

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
  {
    project,
    save = true,
  }: {
    project?: (at: string, deployment: Deployment) => Promise<string | undefined>
    /** Keep a project it was told about in package.json: not on a dry run. */
    save?: boolean
  } = {}
): Promise<Remote[]> => {
  const config = readVercelConfig(distribution)
  const remotes: Remote[] = []
  let changed = false
  for (const deployment of distributionDeployments(distribution)) {
    // Kept in package.json and read on any platform: always `/`.
    const at = path.relative(distribution, deployment.root).split(path.sep).join('/') || '.'
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
  if (changed && save) saveVercelConfig(distribution, config)
  return remotes
}

/** What is set, as an environment: a sensitive variable is set without a value to read. */
const asEnv = (existing: Map<string, VercelVariable>): Record<string, string> =>
  Object.fromEntries([...existing].map(([key, variable]) => [key, variable.value ?? UNREADABLE]))

const everyApp = (remotes: Remote[]): EnvApp[] => remotes.flatMap((remote) => remote.deployment.apps)

/** What each deployment's project is missing for `environment`. */
export const missingRemotely = (remotes: Remote[], environment: string) =>
  remotes.map((remote) => ({
    remote,
    absent: missing(requirementsFor(remote.deployment, environment, everyApp(remotes)), asEnv(remote.existing)),
  }))

/** A secret — declared so, or generated — is sensitive: once set, only the app can read it. */
const isSensitive = (declaration: EnvDeclaration): boolean =>
  Boolean(declaration.sensitive || declaration.generate)

/** One variable set in one project. */
export interface Write {
  remote: Remote
  variable: string
  value: string
  sensitive: boolean
  /** Whether it is set already, so is updated rather than added. */
  exists: boolean
}

/**
 * The slot a rotated secret is using in a project, or undefined for one set by
 * hand, or not at all. The pointer says, where it can be read; a team policy
 * may have made it sensitive too, and then the slot set most recently is the
 * one — Vercel says when each was set, sensitive or not.
 */
export const currentSlot = (existing: Map<string, VercelVariable>, name: string): Slot | undefined => {
  const pointer = existing.get(pointerVariable(name))?.value?.trim()
  if (pointer === 'A' || pointer === 'B') return pointer
  const set = SLOTS.filter((slot) => existing.has(slotVariable(name, slot)))
  if (set.length === 0) return undefined
  return set.reduce((newest, slot) =>
    existing.get(slotVariable(name, slot))!.updatedAt > existing.get(slotVariable(name, newest))!.updatedAt ? slot : newest
  )
}

/** Whether a secret is set in a project, by hand or in a slot. */
const isPresent = (existing: Map<string, VercelVariable>, name: string): boolean =>
  existing.has(name) || SLOTS.some((slot) => existing.has(slotVariable(name, slot)))

/** A new value into `slot`, and the pointer at it: nothing read. */
const intoSlot = (remote: Remote, name: string, slot: Slot, value: string): Write[] => [
  {
    remote,
    variable: slotVariable(name, slot),
    value,
    sensitive: true,
    exists: remote.existing.has(slotVariable(name, slot)),
  },
  // A letter, not a secret: it can stay readable.
  { remote, variable: pointerVariable(name), value: slot, sensitive: false, exists: remote.existing.has(pointerVariable(name)) },
]

export interface SetupPlan {
  writes: Write[]
  /** What each write is, in words, by variable and project. */
  notes: Array<{ remote: Remote; variable: string; source: string }>
  /** What could not be set from here, and why. */
  unresolved: Array<{ remote: Remote; requirement: Requirement; why: string }>
}

/**
 * What setting up `environment` adds: every variable a deployment has to have
 * and its project does not. A generated secret goes into its first slot, one
 * value for every variable `sameAs` ties to it. None of it is read: where some
 * of a tied group is set already, the whole group moves to a new value in its
 * next slot — which each side still accepts the old one beside — rather than
 * match a value nobody can see. A fixed value is set as it is; anything else
 * is asked for, or left unresolved.
 */
export const planSetup = async (
  remotes: Remote[],
  environment: string,
  { ask }: { ask?: (requirement: Requirement, remote: Remote) => Promise<string | undefined> } = {}
): Promise<SetupPlan> => {
  const groups = groupsOf(everyApp(remotes))
  const decided = new Map<string, { value: string; slot: Slot }>()
  const plan: SetupPlan = { writes: [], notes: [], unresolved: [] }

  for (const { remote, absent } of missingRemotely(remotes, environment)) {
    for (const requirement of absent) {
      const { declaration, variable } = requirement
      if (requirement.database) {
        plan.unresolved.push({ remote, requirement, why: 'connect Neon to the project, which sets DATABASE_URL' })
        continue
      }

      if (declaration.rotate) {
        const group = groups.get(variable) ?? [variable]
        let chosen = decided.get(group[0])
        if (!chosen) {
          const already = remotes.flatMap((each) =>
            group.filter((tied) => isPresent(each.existing, tied)).map((tied) => ({ remote: each, name: tied }))
          )
          const current = already.length > 0 ? currentSlot(already[0].remote.existing, already[0].name) : undefined
          chosen = { value: newSecret(), slot: current ? otherSlot(current) : 'A' }
          decided.set(group[0], chosen)
          for (const { remote: where, name } of already) {
            // This one is written below, as what was missing.
            if (where === remote && name === variable) continue
            plan.writes.push(...intoSlot(where, name, chosen.slot, chosen.value))
            plan.notes.push({ remote: where, variable: name, source: `moved to a new value, to match ${variable}` })
          }
        }
        plan.writes.push(...intoSlot(remote, variable, chosen.slot, chosen.value))
        plan.notes.push({ remote, variable, source: group.length > 1 ? 'generated, alike wherever it is shared' : 'generated' })
        continue
      }

      let value = declaration.value ?? (declaration.generate ? newSecret() : undefined)
      let source = declaration.value !== undefined ? 'as declared' : 'generated'
      if (value === undefined && ask) {
        value = (await ask(requirement, remote))?.trim() || undefined
        source = 'as given'
      }
      if (value === undefined) {
        plan.unresolved.push({ remote, requirement, why: 'nothing to set it to' })
        continue
      }
      plan.writes.push({ remote, variable, value, sensitive: isSensitive(declaration), exists: false })
      plan.notes.push({ remote, variable, source })
    }
  }
  return plan
}

export const applySetup = (plan: SetupPlan, environment: string): void => {
  for (const { remote, variable, value, sensitive, exists } of plan.writes) {
    setVariable(remote.target, variable, environment, value, { sensitive, exists })
  }
}

export interface Rotation {
  remote: Remote
  /** The secret, by its name. */
  variable: string
  writes: Write[]
  /** A value set by hand before rotating began, now a rotation old. */
  removes: string[]
  /** Shared with nothing else, so its order does not matter. */
  alone: boolean
}

/**
 * The order rotating goes in, a phase at a time, each redeployed before the
 * next: what checks a shared secret first — it takes the new value and still
 * accepts the old — then what sends it. Each rotation writes a new value into
 * the slot not in use and points at it; nothing is read. Every variable a
 * group ties together moves to the same slot, with the same value.
 */
export const planRotation = (remotes: Remote[], only: string[] = []): Rotation[][] => {
  const groups = groupsOf(everyApp(remotes))
  const fresh = new Map<string, { value: string; slot: Slot }>()
  const phases: Rotation[][] = [[], []]

  for (const remote of remotes) {
    const here = new Set(remote.deployment.apps.map((app) => app.name))
    for (const app of everyApp(remotes)) {
      for (const [variable, declaration] of Object.entries(app.env)) {
        if (!declaration.rotate || !here.has(declaration.deployment ?? app.name)) continue
        if (!isPresent(remote.existing, variable)) continue
        const group = groups.get(variable) ?? [variable]
        if (only.length > 0 && !group.some((tied) => only.includes(tied))) continue

        const current = currentSlot(remote.existing, variable)
        let chosen = fresh.get(group[0])
        if (!chosen) {
          chosen = { value: newSecret(), slot: current ? otherSlot(current) : 'A' }
          fresh.set(group[0], chosen)
        }
        // Set by hand before the slots, it was kept alongside them for one
        // rotation; this is the next.
        const removes = current && remote.existing.has(variable) ? [variable] : []
        const sends = Boolean(declaration.sameAs) && !declaration.verifies
        phases[sends ? 1 : 0].push({
          remote,
          variable,
          writes: intoSlot(remote, variable, chosen.slot, chosen.value),
          removes,
          alone: group.length === 1,
        })
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

/** Rotate phase by phase, redeploying production after each so the next can rely on it. */
export const applyRotation = (
  phases: Rotation[][],
  environment: string,
  { redeploy: shouldRedeploy = true, onProgress }: { redeploy?: boolean; onProgress?: (line: string) => void } = {}
): void => {
  for (const phase of phases) {
    for (const { remote, variable, writes, removes } of phase) {
      // The value before the pointer: the app never points at a slot not yet written.
      for (const write of writes) {
        setVariable(write.remote.target, write.variable, environment, write.value, write)
      }
      for (const name of removes) removeVariable(remote.target, name, environment)
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
