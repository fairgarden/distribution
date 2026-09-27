import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Where a package is installed, seen from `base`, whether or not it exports its package.json. */
export const packageDir = (base: string, name: string): string | undefined => {
  const require = createRequire(path.join(base, 'package.json'))
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
