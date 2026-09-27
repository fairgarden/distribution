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
  assertAgree,
  UNREADABLE,
} from './env.ts'
import {
  listVariables,
  productionDeployment,
  type LiveDeployment,
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

/** Every rotated secret the apps declare, by name. */
const rotatedOf = (apps: EnvApp[]): Map<string, EnvDeclaration> =>
  new Map(apps.flatMap((app) => Object.entries(app.env).filter(([, declaration]) => declaration.rotate)))

/**
 * Ties have to hold before anything is set by them: `sameAs` names a rotated
 * secret some app declares — a typo would set one side and not the other —
 * and every tied group says which of it checks the secret (`verifies`), which
 * is rotated first.
 */
export const assertTies = (apps: EnvApp[]): void => {
  const rotated = rotatedOf(apps)
  const declared = new Set(apps.flatMap((app) => Object.keys(app.env)))
  for (const app of apps) {
    for (const [variable, { sameAs }] of Object.entries(app.env)) {
      if (!sameAs) continue
      if (!declared.has(sameAs)) throw new Error(`${app.name} ties ${variable} to ${sameAs}, which no app declares.`)
      if (!rotated.has(sameAs)) {
        throw new Error(`${app.name} ties ${variable} to ${sameAs}, which is not a rotated secret: one value cannot be kept alike.`)
      }
    }
  }
  for (const group of new Set(groupsOf(apps).values())) {
    if (group.length > 1 && !group.some((variable) => rotated.get(variable)?.verifies)) {
      throw new Error(
        `${group.join(', ')} are one secret, but nothing says which of them checks it. Mark that one ` +
          '"verifies": true, so it is rotated first.'
      )
    }
  }
}

interface Member {
  remote: Remote
  name: string
  verifies: boolean
}

/**
 * What shares one value: a tied group, wherever it is set, and an untied
 * secret only with itself in its own project. Two apps deployed apart that
 * name a secret alike have not said it is one.
 */
const shareKey = (groups: Map<string, string[]>, remote: Remote, name: string): string => {
  const group = groups.get(name) ?? [name]
  return group.length > 1 ? group[0] : `${remote.at}\0${name}`
}

/**
 * The slot a group's new value goes into: one no sender of it is using, so
 * nothing that sends the secret has its value overwritten while what checks
 * it could still be accepting only that. After a rotation that stopped between
 * the side that checks and the side that sends, that is the slot it was
 * finishing. Senders on different slots leave no slot safe for all of them.
 */
const targetSlot = (members: Member[]): Slot => {
  const using = (list: Member[]) =>
    [...new Set(list.map((member) => currentSlot(member.remote.existing, member.name)).filter(Boolean))] as Slot[]
  const senders = members.filter((member) => !member.verifies)
  const sending = using(senders)
  if (sending.length > 1) {
    throw new Error(
      `${senders.map((member) => `${member.name} in ${member.remote.target.project}`).join(' and ')} send one secret ` +
        'from different slots, so no slot is free in all of them: a rotation stopped between them. Point every ' +
        "*_CURRENT at the same slot, or remove the group's slots and run setup, which starts it afresh."
    )
  }
  const current = sending[0] ?? using(members)[0]
  return current ? otherSlot(current) : 'A'
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
  assertTies(everyApp(remotes))
  const groups = groupsOf(everyApp(remotes))
  const rotated = rotatedOf(everyApp(remotes))
  const decided = new Map<string, { value: string; slot: Slot }>()
  const plan: SetupPlan = { writes: [], notes: [], unresolved: [] }
  // A tied secret moved with its group is not written again as missing.
  const repaired = new Set<string>()
  const key = (remote: Remote, name: string) => `${remote.at}\0${name}`

  for (const { remote, absent } of missingRemotely(remotes, environment)) {
    for (const requirement of absent) {
      const { declaration, variable } = requirement
      if (requirement.database) {
        plan.unresolved.push({ remote, requirement, why: 'connect Neon to the project, which sets DATABASE_URL' })
        continue
      }

      if (declaration.rotate) {
        const group = groups.get(variable) ?? [variable]
        const shared = shareKey(groups, remote, variable)
        let chosen = decided.get(shared)
        if (!chosen) {
          const already = (group.length > 1 ? remotes : [remote]).flatMap((each) =>
            group
              .filter((tied) => isPresent(each.existing, tied))
              .map((tied): Member => ({ remote: each, name: tied, verifies: Boolean(rotated.get(tied)?.verifies) }))
          )
          chosen = { value: newSecret(), slot: targetSlot(already) }
          decided.set(shared, chosen)
          for (const { remote: where, name } of already) {
            // This one is written below, as what was missing.
            if (where === remote && name === variable) continue
            repaired.add(key(where, name))
            plan.writes.push(...intoSlot(where, name, chosen.slot, chosen.value))
            plan.notes.push({ remote: where, variable: name, source: `moved to a new value, to match ${variable}` })
          }
        }
        if (repaired.has(key(remote, variable))) continue
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
      // Set but empty is still set: it is updated, not added again.
      plan.writes.push({ remote, variable, value, sensitive: isSensitive(declaration), exists: remote.existing.has(variable) })
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
 * Every rotated secret set in each project, once, however many of its apps
 * declare it — and they have to mean the same by it.
 */
const rotatedIn = (remotes: Remote[]): Member[] => {
  const apps = everyApp(remotes)
  const found: Member[] = []
  for (const remote of remotes) {
    const here = new Set(remote.deployment.apps.map((app) => app.name))
    const seen = new Map<string, Requirement>()
    for (const app of apps) {
      for (const [variable, declaration] of Object.entries(app.env)) {
        if (!declaration.rotate || !here.has(declaration.deployment ?? app.name)) continue
        if (!isPresent(remote.existing, variable)) continue
        const already = seen.get(variable)
        if (already) {
          assertAgree(variable, already, app.name, declaration)
          continue
        }
        seen.set(variable, { variable, anyOf: [variable], apps: [app.name], excusedBy: [], declaration })
        found.push({ remote, name: variable, verifies: Boolean(declaration.verifies) })
      }
    }
  }
  return found
}

/** When any of a secret's variables last changed in a project. */
const changedAt = (existing: Map<string, VercelVariable>, name: string): number =>
  Math.max(
    0,
    ...[name, ...SLOTS.map((slot) => slotVariable(name, slot)), pointerVariable(name)].map(
      (variable) => existing.get(variable)?.updatedAt ?? 0
    )
  )

export interface CatchUp {
  remote: Remote
  live: LiveDeployment
  /** The secrets changed since it was made. */
  secrets: string[]
}

/**
 * The projects whose production was made before one of its rotated secrets
 * last changed — a rotation that stopped before redeploying it, or an instant
 * rollback to before one — in the order to redeploy them: where a shared
 * secret is checked before where it is sent.
 *
 * A slot is chosen from a project's settings, which are only what production
 * runs once it is made again. Until then a new value could go over the one a
 * live deployment still sends, so these are redeployed before anything is
 * rotated.
 */
export const planCatchUp = (
  remotes: Remote[],
  live: Map<Remote, LiveDeployment | undefined>,
  only: string[] = []
): CatchUp[] => {
  const groups = groupsOf(everyApp(remotes))
  const behind = rotatedIn(remotes).filter(({ remote, name }) => {
    const deployed = live.get(remote)
    if (only.length > 0 && !(groups.get(name) ?? [name]).some((tied) => only.includes(tied))) return false
    return deployed !== undefined && changedAt(remote.existing, name) > deployed.createdAt
  })
  // A project sending a secret waits for every other that checks it.
  const waitsFor = new Map<Remote, Set<Remote>>()
  for (const sender of behind.filter((member) => !member.verifies)) {
    const key = shareKey(groups, sender.remote, sender.name)
    for (const checker of behind) {
      if (!checker.verifies || checker.remote === sender.remote) continue
      if (shareKey(groups, checker.remote, checker.name) !== key) continue
      waitsFor.set(sender.remote, (waitsFor.get(sender.remote) ?? new Set()).add(checker.remote))
    }
  }
  const order: Remote[] = []
  let left = [...new Set(behind.map((member) => member.remote))]
  while (left.length > 0) {
    const ready = left.filter((remote) => [...(waitsFor.get(remote) ?? [])].every((before) => order.includes(before)))
    if (ready.length === 0) {
      throw new Error(
        `${left.map((remote) => remote.target.project).join(' and ')} each check a secret another of them sends, ` +
          'and none has production made since it changed: whichever is redeployed first turns the other away until ' +
          'it is redeployed too. Redeploy them yourself, then rotate.'
      )
    }
    order.push(...ready)
    left = left.filter((remote) => !ready.includes(remote))
  }
  return order.map((remote) => ({
    remote,
    live: live.get(remote)!,
    secrets: behind.filter((member) => member.remote === remote).map((member) => member.name),
  }))
}

/** Redeploy production where it is behind its settings, in order, each before the next. */
export const applyCatchUp = (behind: CatchUp[], { onProgress }: { onProgress?: (line: string) => void } = {}): void => {
  for (const { remote, live } of behind) {
    onProgress?.(`${remote.target.project}  redeploying production, made before its secrets last changed…`)
    const url = redeploy(remote.target, live.id)
    onProgress?.(`${remote.target.project}  ${url || 'redeployed'}`)
  }
}

/**
 * The order rotating goes in, a phase at a time, each redeployed before the
 * next: what checks a shared secret first — it takes the new value and still
 * accepts the old — then what sends it. Each rotation writes a new value into
 * the slot not in use and points at it; nothing is read. Every variable a
 * group ties together moves to the same slot, with the same value.
 */
export const planRotation = (remotes: Remote[], only: string[] = []): Rotation[][] => {
  const apps = everyApp(remotes)
  assertTies(apps)
  const groups = groupsOf(apps)
  const rotated = rotatedOf(apps)
  // Naming a secret that is not one would rotate nothing, and say it had.
  const unknown = only.filter((name) => !rotated.has(name))
  if (unknown.length > 0) {
    throw new Error(
      `Nothing declares ${unknown.join(', ')} as a rotated secret. What is: ${[...rotated.keys()].join(', ') || 'nothing'}.`
    )
  }
  const groupOf = (name: string): string[] => groups.get(name) ?? [name]
  const found = rotatedIn(remotes).filter(
    ({ name }) => only.length === 0 || groupOf(name).some((tied) => only.includes(tied))
  )

  // One new value, and one slot, for each group, chosen from all of it.
  const chosen = new Map<string, { value: string; slot: Slot }>()
  for (const { remote, name } of found) {
    const key = shareKey(groups, remote, name)
    if (chosen.has(key)) continue
    const members = found.filter((each) => shareKey(groups, each.remote, each.name) === key)
    chosen.set(key, { value: newSecret(), slot: targetSlot(members) })
  }

  const phases: Rotation[][] = [[], []]
  for (const { remote, name, verifies } of found) {
    const { value, slot } = chosen.get(shareKey(groups, remote, name))!
    // Set by hand before the slots, it was kept alongside them for one
    // rotation; this is the next.
    const removes = currentSlot(remote.existing, name) && remote.existing.has(name) ? [name] : []
    const alone = groupOf(name).length === 1
    // What checks a shared secret goes first; every other side of it after.
    phases[alone || verifies ? 0 : 1].push({ remote, variable: name, writes: intoSlot(remote, name, slot, value), removes, alone })
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
      const url = redeploy(remote.target, live.id)
      onProgress?.(`${remote.target.project}  ${url || 'redeployed'}`)
    }
  }
}
