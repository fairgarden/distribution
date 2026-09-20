import { parse } from '@babel/parser'
import type { Node } from '@babel/types'

/**
 * Add a mount to a monolith's Next config.
 *
 * The file is parsed to find where the mount map is, and the new entry is
 * spliced into the original text at that offset rather than regenerated from
 * the tree. Printing the tree back out would reformat the whole file and move
 * its comments, over a one-line change.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Walk every node, depth first, until `visit` returns a value. */
const find = <T>(node: unknown, visit: (node: Node) => T | undefined): T | undefined => {
  if (!node || typeof node !== 'object') return undefined

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, visit)
      if (found !== undefined) return found
    }
    return undefined
  }

  const candidate = node as Node
  if (typeof candidate.type === 'string') {
    const found = visit(candidate)
    if (found !== undefined) return found
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const found = find(value, visit)
    if (found !== undefined) return found
  }

  return undefined
}

/** What the config calls `withMonolith`, which an import may have renamed. */
const localName = (ast: Node): string | undefined =>
  find(ast, (node) => {
    if (node.type !== 'ImportDeclaration') return undefined
    if (!String(node.source.value).startsWith('@fairgarden/monolith')) return undefined

    for (const specifier of node.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        specifier.imported.name === 'withMonolith'
      ) {
        return specifier.local.name
      }
      if (specifier.type === 'ImportDefaultSpecifier') return specifier.local.name
    }
    return undefined
  })

export interface EditResult {
  source: string
  /** False when the mount was already there. */
  changed: boolean
}

export class ConfigEditError extends Error {}

const keyOf = (name: string): string =>
  IDENTIFIER.test(name) ? name : `'${name}'`

/** The indent to give a new property, taken from whatever is already there. */
const indentFor = (source: string, offset: number, fallback: string): string => {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const line = source.slice(lineStart, offset)
  const leading = /^[ \t]*/.exec(line)?.[0]
  return leading && leading.length > 0 ? leading : fallback
}

export const addMount = (
  source: string,
  mount: string,
  module: string
): EditResult => {
  let ast: Node
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
      ranges: true,
    }) as unknown as Node
  } catch (cause) {
    throw new ConfigEditError('The config could not be parsed.', { cause })
  }

  const called = localName(ast)
  if (!called) {
    throw new ConfigEditError('The config does not import withMonolith.')
  }

  const call = find(ast, (node) =>
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === called
      ? node
      : undefined
  )
  if (!call || call.type !== 'CallExpression') {
    throw new ConfigEditError(`The config never calls ${called}().`)
  }

  const [first, apps] = call.arguments
  const entry = `${keyOf(mount)}: '${module}',`

  // No mount map yet, so give it one alongside the config it already passes.
  if (!apps) {
    if (!first || first.end === null || first.end === undefined) {
      throw new ConfigEditError(`${called}() was called without a config to extend.`)
    }
    const indent = indentFor(source, first.start ?? 0, '  ')
    const inner = `${indent}  `
    const insert = `,\n${indent}{\n${inner}${entry}\n${indent}}`
    return {
      source: source.slice(0, first.end) + insert + source.slice(first.end),
      changed: true,
    }
  }

  if (apps.type !== 'ObjectExpression') {
    throw new ConfigEditError(
      `The apps passed to ${called}() are not written inline, so they cannot be edited here.`
    )
  }

  const existing = apps.properties.some(
    (property) =>
      property.type === 'ObjectProperty' &&
      ((property.key.type === 'Identifier' && property.key.name === mount) ||
        (property.key.type === 'StringLiteral' && property.key.value === mount))
  )
  if (existing) return { source, changed: false }

  const open = apps.start ?? 0
  const close = (apps.end ?? 0) - 1
  const last = apps.properties.at(-1)

  if (!last || last.end === null || last.end === undefined) {
    // An empty map, possibly holding a comment; put the entry first.
    const indent = `${indentFor(source, open, '  ')}  `
    return {
      source: `${source.slice(0, open + 1)}\n${indent}${entry}${source.slice(open + 1)}`,
      changed: true,
    }
  }

  // Step over a trailing comma so the new entry does not double it, and
  // supply one when the last property does not already end in it.
  let at = last.end
  const between = source.slice(at, close)
  const comma = between.indexOf(',')
  const trailing = comma !== -1 && between.slice(0, comma).trim() === ''
  if (trailing) at += comma + 1

  const indent = indentFor(source, last.start ?? open, '  ')
  return {
    source: `${source.slice(0, at)}${trailing ? '' : ','}\n${indent}${entry}${source.slice(at)}`,
    changed: true,
  }
}

/**
 * Whether a Next config composes modules, rather than merely importing from
 * this package.
 *
 * A module depends on `@fairgarden/monolith` too — for the portability check
 * and the portable Link — so the dependency says nothing. Only a config that
 * calls `withMonolith` belongs to the app doing the composing.
 */
export const declaresMonolith = (source: string): boolean => {
  let ast: Node
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
      ranges: true,
    }) as unknown as Node
  } catch {
    return false
  }

  const called = localName(ast)
  if (!called) return false

  return (
    find(ast, (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === called
        ? true
        : undefined
    ) === true
  )
}
