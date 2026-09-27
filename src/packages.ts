import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { declaresMonolith } from './config-edit.ts'

const NEXT_CONFIGS = ['next.config.ts', 'next.config.mts', 'next.config.js', 'next.config.mjs', 'next.config.cjs']

/**
 * Whether a package composes others: its Next config calls `withMonolith`.
 * Depending on `@fairgarden/monolith` says nothing — every module does, for
 * its portable Link — and neither does declaring migrations or variables of
 * its own, which a monolith may as well.
 */
export const composesApps = (dir: string): boolean => {
  for (const file of NEXT_CONFIGS) {
    const config = path.join(dir, file)
    if (existsSync(config)) return declaresMonolith(readFileSync(config, 'utf8'))
  }
  return false
}

/** Where a package is installed, seen from `base`, whether or not it exports its package.json. */
export const packageDir = (base: string, name: string): string | undefined => {
  // createRequire takes nothing but an absolute path.
  const require = createRequire(path.resolve(base, 'package.json'))
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    // Not exported: find it from its entry point instead.
  }
  try {
    for (let dir = path.dirname(require.resolve(name)); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      const file = path.join(dir, 'package.json')
      if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name === name) return dir
    }
  } catch {
    // Not installed here.
  }
  return undefined
}
