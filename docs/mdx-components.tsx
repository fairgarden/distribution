import type { MDXComponents } from 'mdx/types'

/**
 * Required by `@next/mdx` in the App Router.
 *
 * Nothing is overridden yet, so pages render as plain HTML elements.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return components
}
