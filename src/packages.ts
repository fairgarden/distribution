import { existsSync, readFileSync, realpathSync } from 'node:fs'
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

/**
 * Where a package is installed, seen from `base`: the node_modules folders
 * Node looks in, nearest first. Not by resolving it, which goes by its exports
 * map — one that hides package.json, or offers an ESM-only app nothing to
 * require, would have it missed.
 */
export const packageDir = (base: string, name: string): string | undefined => {
  for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
    const installed = path.join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(path.join(installed, 'package.json'))) return realpathSync(installed)
    if (path.dirname(dir) === dir) return undefined
  }
}
