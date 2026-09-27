import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { submodules, uninitialised } from './submodules.ts'
import { readPackageName } from './scaffold.ts'

const MARKER = '# fg:overrides'
const WORKSPACE = 'pnpm-workspace.yaml'

/**
 * The block that makes a distribution's own checkouts win.
 *
 * Without it, a module resolves a sibling through its declared range, and the
 * range stops matching the moment the sibling's submodule is bumped past it —
 * at which point pnpm quietly installs the published copy instead of the
 * checkout. `workspace:*` says what the distribution means: whatever is in the
 * tree, whatever version it is at.
 *
 * Names, not versions. The version still comes from the submodule pin, which
 * is the whole point of pinning it there.
 */
export const overridesBlock = (names: string[]): string =>
  [
    MARKER,
    '# A distribution uses its own checkouts, whatever version they are at. The',
    '# ranges in each module stay honest for publishing; this is what stops them',
    '# being resolved from the registry once a submodule moves past them.',
    'overrides:',
    ...names.map((name) => `  "${name}": "workspace:*"`),
    `${MARKER}:end`,
  ].join('\n')

export class OverridesError extends Error {}

/**
 * What is inside the block that this did not write.
 *
 * pnpm edits pnpm-workspace.yaml itself — `allowBuilds` when a build is
 * approved, an override of its own from `pnpm audit --fix` — and puts what it
 * adds wherever it likes, including between the markers. Rewriting the block
 * wholesale would delete it. So only the module entries are this block's: its
 * own comment and every `workspace:*` override, which a module removed since
 * leaves behind. Everything else is kept.
 */
const foreign = (inside: string): { keys: string; overrides: string[] } => {
  const header = new Set(overridesBlock([]).split('\n'))
  const keys: string[] = []
  const overrides: string[] = []
  let inOverrides = false

  for (const line of inside.split('\n')) {
    if (/^overrides:\s*$/.test(line)) {
      inOverrides = true
      continue
    }
    if (inOverrides && /^\s/.test(line)) {
      if (line.trim() !== '' && !/:\s*["']?workspace:\*["']?\s*$/.test(line)) overrides.push(line)
      continue
    }
    inOverrides = false
    if (!header.has(line)) keys.push(line)
  }

  return { keys: keys.join('\n').trim(), overrides }
}

/** Replace the block if it is there, otherwise put one at the end. */
const splice = (source: string, names: string[]): string => {
  const start = source.indexOf(`${MARKER}\n`)
  const end = source.indexOf(`${MARKER}:end`)

  if (start !== -1 && end !== -1) {
    const kept = foreign(source.slice(start, end))
    // The block's own lines, with any override pnpm added kept inside it: a
    // second `overrides:` key would not be valid YAML.
    const block = overridesBlock(names).replace(
      `\n${MARKER}:end`,
      kept.overrides.map((line) => `\n${line}`).join('') + `\n${MARKER}:end`
    )
    // pnpm's own settings go above the block, where they no longer look like
    // part of it.
    const before = kept.keys ? `${kept.keys}\n\n` : ''
    return source.slice(0, start) + before + block + source.slice(end + `${MARKER}:end`.length)
  }

  // A second `overrides:` key is not a merge, it is a YAML file pnpm will
  // either reject or read half of. Whoever wrote the existing one meant it.
  if (/^overrides:/m.test(source)) {
    throw new OverridesError(
      `${WORKSPACE} already has an \`overrides:\` key that this did not write. ` +
        `Put ${MARKER} and ${MARKER}:end around it, or fold the modules into it yourself.`
    )
  }

  const separator = source.endsWith('\n') ? '\n' : '\n\n'
  return `${source}${separator}${overridesBlock(names)}\n`
}

export interface OverridesResult {
  file: string
  names: string[]
  changed: boolean
  /** True when there is no pnpm-workspace.yaml to write into. */
  missing: boolean
}

/**
 * Point the distribution's overrides at every module it ships.
 *
 * A distribution with no submodules is left alone: there is nothing to
 * override, and writing an empty block would only be noise.
 */
export const writeOverrides = async (
  root: string,
  { check = false }: { check?: boolean } = {}
): Promise<OverridesResult> => {
  const file = path.join(root, WORKSPACE)

  // A submodule with no checkout has no package.json to read a name from, and
  // dropping its entry would quietly let that module resolve from the registry
  // — which is the exact thing these overrides exist to prevent.
  const absent = uninitialised(root)
  if (absent.length > 0) {
    throw new OverridesError(
      `These submodules are not checked out, so their names cannot be read: ` +
        `${absent.join(', ')}.\nRun \`git submodule update --init\` first.`
    )
  }

  const names: string[] = []
  for (const submodule of submodules(root)) {
    const name = await readPackageName(submodule.path)
    if (name) names.push(name)
  }
  names.sort()

  const existing = await readFile(file, 'utf8').catch(() => undefined)
  if (existing === undefined) return { file, names, changed: false, missing: true }
  if (names.length === 0) return { file, names, changed: false, missing: false }

  const updated = splice(existing, names)
  if (updated === existing) return { file, names, changed: false, missing: false }

  if (!check) await writeFile(file, updated)
  return { file, names, changed: true, missing: false }
}
