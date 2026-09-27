import createMDX from '@next/mdx'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // `.mdx` is not a route on its own; Next only picks these up once the
  // extension is listed here and the loader below is attached.
  pageExtensions: ['ts', 'tsx', 'mdx'],
  // Pages that have moved, so links to where they were still arrive.
  redirects: async () => [
    { source: '/commands/release', destination: '/commands/next-version', permanent: true },
  ],
}

export default createMDX()(nextConfig)
