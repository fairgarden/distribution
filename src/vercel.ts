import { spawnSync } from 'node:child_process'

/**
 * The Vercel CLI, for a distribution's environment.
 *
 * Through the CLI rather than the REST API, so it signs in however the CLI is
 * signed in: `vercel login` on a workstation, `VERCEL_TOKEN` in CI. Values go
 * in on standard input, never as arguments, which any process can read.
 */

export interface VercelProject {
  /** The project's name or ID. */
  project: string
  /** The team it belongs to, when not the signed-in account's own. */
  scope?: string
}

export interface VercelVariable {
  /** Undefined for a sensitive variable, which cannot be read back. */
  value: string | undefined
  type: string
}

export class VercelError extends Error {}

/** `VERCEL_CLI`, else `vercel` on the PATH, else the latest from npm. */
const command = (): [string, string[]] => {
  if (process.env.VERCEL_CLI) return [process.env.VERCEL_CLI, []]
  if (spawnSync('vercel', ['--version'], { stdio: 'ignore' }).status === 0) return ['vercel', []]
  return ['npx', ['--yes', 'vercel@latest']]
}

const run = (target: VercelProject, args: string[], input?: string): string => {
  const [bin, prefix] = command()
  const result = spawnSync(bin, [...prefix, ...args, ...(target.scope ? ['--scope', target.scope] : [])], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new VercelError(`Could not run the Vercel CLI: ${result.error.message}`)
  if (result.status !== 0) {
    throw new VercelError(`\`vercel ${args[0]} ${args[1] ?? ''}\` failed:\n${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

/** The variables set for `environment`, other than a single branch's. */
export const listVariables = (target: VercelProject, environment: string): Map<string, VercelVariable> => {
  const out = run(target, ['env', 'list', environment, '--project', target.project, '--json'])
  const { envs } = JSON.parse(out) as {
    envs: Array<{ key: string; value?: string; type: string; target?: string[] | string; gitBranch?: string }>
  }
  const found = new Map<string, VercelVariable>()
  for (const variable of envs) {
    const targets = Array.isArray(variable.target) ? variable.target : [variable.target]
    if (variable.gitBranch || !targets.includes(environment)) continue
    found.set(variable.key, { value: variable.value, type: variable.type })
  }
  return found
}

export const addVariable = (
  target: VercelProject,
  name: string,
  environment: string,
  value: string,
  { sensitive }: { sensitive: boolean }
): void => {
  run(
    target,
    ['env', 'add', name, environment, '--project', target.project, '--yes', sensitive ? '--sensitive' : '--no-sensitive'],
    value
  )
}

export const updateVariable = (target: VercelProject, name: string, environment: string, value: string): void => {
  run(target, ['env', 'update', name, environment, '--project', target.project, '--yes'], value)
}

/**
 * The deployment serving production now — after an instant rollback, not the
 * newest — which redeploying applies new values to without undoing it.
 */
export const productionDeployment = (target: VercelProject): string | undefined => {
  const project = JSON.parse(run(target, ['api', `/v9/projects/${encodeURIComponent(target.project)}`, '--raw'])) as {
    targets?: { production?: { id?: string } }
  }
  return project.targets?.production?.id
}

/** Build `deployment` again with the variables as they are now, and wait for it. */
export const redeploy = (target: VercelProject, deployment: string): string =>
  run(target, ['redeploy', deployment, '--target', 'production']).trim()
