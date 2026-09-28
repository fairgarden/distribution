import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import createMDX from '@next/mdx'
import type { NextConfig } from 'next'
import {
  getFairGardenDocsMdxOptions,
  withDeploymentConfig,
  withFairGardenDocs,
} from '@fairgarden/docs/withFairGardenDocs'

// Section indexes: the section directories whose page.mdx the docs engine
// keeps as an index of the pages under it. The sitemap (app/sitemap/index.ts)
// is built from these indexes, and the sidebar and search from the sitemap.
// `pnpm validate` brings them up to date, and fails under CI when one was
// out of date.
const extractToIndex = {
  include: ['app/overview', 'app/commands', 'app/functions'],
  exclude: [],
}

const withMDX = createMDX({
  options: getFairGardenDocsMdxOptions({
    // Plugin names are resolved from each .mdx file's directory, so every one
    // must be a direct dependency of this package. rehype-slug gives each
    // heading the id its self-link and `#` links point at.
    additionalRehypePlugins: ['rehype-slug'],
    extractToIndex,
  }),
})

// Turbopack resolves nothing outside its root, which it puts at the nearest
// lockfile or repository: this module's own. Installed from a distribution,
// `next` and the other dependencies live in the distribution's store above
// it, so the root is the directory whose node_modules holds the `next` this
// site resolves: the module on its own, or the distribution around it.
const nextPackage = realpathSync(
  createRequire(path.join(process.cwd(), 'package.json')).resolve('next/package.json')
)
const installRoot = nextPackage.slice(0, nextPackage.indexOf(`${path.sep}node_modules${path.sep}`))

const nextConfig: NextConfig = {
  // Parallel builds and dev servers can each use their own build dir.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  turbopack: { root: installRoot },
  // withDeploymentConfig defaults both of these the other way.
  trailingSlash: false,
  typescript: { ignoreBuildErrors: false },
  // Pages that have moved, so links to where they were still arrive.
  redirects: async () => [
    { source: '/commands/release', destination: '/commands/next-version', permanent: true },
  ],
}

export default withDeploymentConfig(
  withFairGardenDocs({
    // The default (true) sets output: 'export', which breaks `next start`.
    enableExportOutput: false,
  })(withMDX(nextConfig))
)
