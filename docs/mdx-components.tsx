import NextLink from 'next/link'
import type { MDXComponents } from 'mdx/types'
import { createMdxComponents } from '@fairgarden/design/utils/docs/createMdxComponents'

/**
 * The design system's MDX map, with next/link for internal links. `pre` is
 * required: the docs pipeline replaces every fenced code block with
 * `<pre data-precompute=…>`, which only its Code Block can render.
 */
const mdxComponents: MDXComponents = createMdxComponents({ Link: NextLink })

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...components, ...mdxComponents }
}
