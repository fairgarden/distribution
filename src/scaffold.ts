import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { checkWorkflows, publishWorkflow, releaseScripts } from './workflows.ts'
import { CHANGELOG, newChangelog } from './changelog.ts'
import { firstRelease } from './calver.ts'

/** Files to write, keyed by path relative to the target directory. */
export type Files = Record<string, string>

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Versions the generated projects pin, kept beside the ones this package uses. */
export const VERSIONS = {
  monolith: '^0.1.0-alpha.0',
  // Provides `fg-dist`, which the release scripts and the publish workflow call.
  distribution: '^0.1.0-alpha.0',
  // Provides `fg-policy`, which `fg-dist policy` calls to build the organization's policy.
  policy: '^0.1.0-alpha.0',
  next: '^16.3.5',
  react: '^19.3.0',
  types: {
    node: '^26.6.2',
    react: '^19.3.0',
    reactDom: '^19.3.0',
  },
  eslint: '^9.39.5',
  eslintConfigNext: '^16.3.5',
  portless: '^0.15.6',
  typescript: '^6.0.3',
  // Exact, because this is what `packageManager` means. The publish workflow's
  // pnpm comes from it, so a module without one cannot build in CI.
  pnpm: 'pnpm@10.28.0',
} as const

const WORKSPACE = `packages:
  - "apps/*"
  - "packages/*"
  # a module's docs site is its own workspace member
  - "apps/*/docs"
  - "packages/*/docs"
`

/**
 * The root's scripts.
 *
 * With a monolith, `dev` and `build` are the monolith: it serves every
 * mounted app, so running their own dev servers as well would be the same
 * routes twice. `modular:*` runs each app on its own instead, as a
 * deployment without the monolith would. Without one, every app is its own
 * deployment and both are that. Documentation sites run with neither.
 */
const rootScripts = (monolith: boolean): Record<string, string> => {
  const apps = monolith
    ? "--filter='./apps/*' --filter='!./apps/monolith'"
    : "--filter='./apps/*'"
  const docs = "--filter='./apps/*/docs' --filter='./packages/*/docs'"
  // A build migrates what it deploys once it has built — see `fg-dist
  // migrate` — and outside turbo, which would keep from it every variable an
  // app's database may be named by that turbo.json does not list, and could
  // skip it on a cache hit.
  const migrate = (filter: string) => `pnpm ${filter} run --if-present migrate`
  // And before anything is built, it refuses to deploy without what the apps
  // need in their environment: see `fg-dist env check`.
  const checkEnv = (filter: string) => `pnpm ${filter} run --if-present check-env`
  const deploy = (filter: string) => `${checkEnv(filter)} && turbo run build ${filter} && ${migrate(filter)}`
  return {
    build: deploy(monolith ? '--filter=./apps/monolith' : apps),
    dev: monolith ? 'turbo run dev --filter=./apps/monolith' : `turbo run dev ${apps}`,
    'modular:build': deploy(apps),
    'modular:dev': `turbo run dev ${apps}`,
    'docs:build': `turbo run build ${docs}`,
    'docs:dev': `turbo run dev ${docs}`,
    lint: 'turbo run lint',
  }
}

const BUILD_OUTPUTS = ['.next/**', '!.next/cache/**', 'dist/**']

/**
 * The monolith compiles every app from its source, so its build waits for
 * the libraries they use but not for the apps' own builds. `build:libs`
 * runs no script: a library's is its build, and a mounted app's — written
 * by `add-module` — is only its dependencies'. Turbo still hashes each app
 * into the monolith's, so changing one builds the monolith again.
 */
const turboJson = (monolith: string | undefined): string =>
  json({
    $schema: 'https://turbo.build/schema.json',
    tasks: {
      build: { dependsOn: ['^build'], outputs: BUILD_OUTPUTS },
      ...(monolith ? { 'build:libs': { dependsOn: ['^build:libs', 'build'] } } : {}),
      lint: { dependsOn: ['^lint'] },
      // A fresh checkout has built none of the libraries an app's config loads.
      dev: { dependsOn: ['^build'], persistent: true, cache: false },
      ...(monolith
        ? {
            [`${monolith}#build`]: { dependsOn: ['^build:libs'], outputs: BUILD_OUTPUTS },
            [`${monolith}#dev`]: { dependsOn: ['^build:libs'], persistent: true, cache: false },
          }
        : {}),
    },
  })

/**
 * The MIT license, which every repository this scaffolds starts under. Who
 * holds the copyright is asked for — \`--copyright\`, or the git user — since
 * nothing here can know it.
 */
export const mitLicense = (holder: string, year = new Date().getUTCFullYear()): string =>
  `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

export interface LicenseOptions {
  /** Who holds the copyright. Defaults to "The <name> authors". */
  copyright?: string
}

const GITIGNORE = `node_modules
.next
.turbo
out
build
next-env.d.ts
*.tsbuildinfo
.env*.local

# derived mount points; the symlinks under src/ are what is committed
/app/
/pages/

# fg-dist policy use: the distribution's policy, for this build to run
/.policy

# generated by next dev
AGENTS.md
CLAUDE.md
`

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2017',
    lib: ['dom', 'dom.iterable', 'esnext'],
    allowJs: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'preserve',
    incremental: true,
    plugins: [{ name: 'next' }],
  },
  include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
  exclude: ['node_modules'],
}

/**
 * A repository that composes modules.
 *
 * The monolith app lives at `apps/monolith` so modules can be added beside it
 * as `apps/<name>`, which is where `add-module` puts them.
 */
export const monolithRepo = (
  name: string,
  origin?: string,
  { copyright = `The ${name} authors` }: LicenseOptions = {}
): Files => ({
  LICENSE: mitLicense(copyright),
  '.gitignore': `node_modules\n.turbo\n`,
  // Modules are linked through the workspace, so nothing here carries a
  // version: the submodule commit is the pin and its package.json is the
  // version. Keeping the workspace protocol stops pnpm writing one back in.
  '.npmrc': `link-workspace-packages=true\nsave-workspace-protocol=true\n`,
  'pnpm-workspace.yaml': WORKSPACE,
  // turbo refuses a --filter naming a directory that does not exist, so the
  // root's scripts need it before any package has been added.
  'packages/.gitkeep': '',
  'package.json': json({
    name,
    version: '0.1.0-alpha.0',
    license: 'MIT',
    private: true,
    ...(origin ? { repository: { type: 'git', url: origin } } : {}),
    scripts: { ...rootScripts(true), dist: 'fg-dist' },
    devDependencies: { '@fairgarden/distribution': VERSIONS.distribution, turbo: '^2.11.2' },
  }),
  'turbo.json': turboJson(`${name}-monolith`),
  'apps/monolith/package.json': json({
    name: `${name}-monolith`,
    version: '0.1.0-alpha.0',
    license: 'MIT',
    private: true,
    scripts: {
      // Each takes a copy of the organization's policy to run, when there is one.
      dev: 'fg-dist policy use && next dev -p 3000',
      build: 'fg-dist policy use && next build',
      // What every app it mounts needs set, before a build deploys it.
      'check-env': 'fg-dist env check --build',
      // Every app it mounts that has a database, each into its own.
      migrate: 'fg-dist migrate --build',
      start: 'next start -p 3000',
      lint: 'eslint',
    },
    dependencies: {
      '@fairgarden/monolith': VERSIONS.monolith,
      next: VERSIONS.next,
      react: VERSIONS.react,
      'react-dom': VERSIONS.react,
    },
    devDependencies: {
      '@fairgarden/distribution': VERSIONS.distribution,
      '@types/node': VERSIONS.types.node,
      '@types/react': VERSIONS.types.react,
      '@types/react-dom': VERSIONS.types.reactDom,
      eslint: VERSIONS.eslint,
      'eslint-config-next': VERSIONS.eslintConfigNext,
      typescript: VERSIONS.typescript,
    },
  }),
  'apps/monolith/next.config.ts': `import { withMonolith } from '@fairgarden/monolith'

export default withMonolith(
  {
    // the monolith's own Next config
  },
  {
    // mount name -> module, added by \`fg-dist add-module\`
  }
)
`,
  'apps/monolith/tsconfig.json': json(TSCONFIG),
  'apps/monolith/eslint.config.mjs': `import next from 'eslint-config-next/core-web-vitals'

/** @type {import('eslint').Linter.Config[]} */
const config = [{ ignores: ['node_modules/**', '.next/**', 'app/**', 'pages/**'] }, ...next]

export default config
`,
  'apps/monolith/.gitignore': GITIGNORE,
  'apps/monolith/src/app/layout.tsx': `export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`,
  'apps/monolith/src/app/page.tsx': `export default function Home() {
  return <main>Nothing mounted yet. Add a module with \`pnpm dist add-module\`.</main>
}
`,
})

/**
 * A repository that can be mounted into a monolith.
 *
 * It is an ordinary Next app; the only additions are the portability check and
 * the lint rules that keep it mountable.
 */
/** `@acme/widget` -> `widget`, which is what a hostname wants. */
const unscoped = (packageName: string): string =>
  packageName.replace(/^@[^/]+\//, '')

export const moduleRepo = (
  packageName: string,
  origin?: string,
  { copyright = `The ${packageName} authors` }: LicenseOptions = {}
): Files => ({
  LICENSE: mitLicense(copyright),
  // A module releases on its own schedule, so it carries its own workflow, and
  // its own changelog, which every pull request adds to.
  ...publishWorkflow(packageName),
  ...checkWorkflows({ submodules: false }),
  [CHANGELOG]: newChangelog('0.1.0-alpha.0'),
  '.gitignore': `node_modules\n.next\n.turbo\nnext-env.d.ts\n*.tsbuildinfo\n\n# generated by next dev\nAGENTS.md\nCLAUDE.md\n`,
  'package.json': json({
    name: packageName,
    version: '0.1.0-alpha.0',
    license: 'MIT',
    // Not private: a module publishes itself, so that a monolith which cannot
    // reach it as a submodule can install it as a package instead. Scoped
    // packages publish restricted by default; say so rather than leave it to
    // whoever reads this to remember.
    publishConfig: { access: 'restricted' },
    // What CI installs with — see .github/actions/publish-prepare.
    packageManager: VERSIONS.pnpm,
    // A module is consumed as source — its routes are read out of the package —
    // so the tarball carries the source rather than a build.
    files: ['app', 'lib', 'pages', 'public', 'next.config.ts'],
    // A monolith adds this repository as a submodule, so record where it lives.
    ...(origin ? { repository: { type: 'git', url: origin } } : {}),
    scripts: {
      // Served at a stable hostname instead of a port, so every app that
      // `modular:dev` runs at once has its own without colliding:
      // https://${unscoped(packageName)}.localhost. A monolith compiles this app
      // itself and never runs it.
      dev: `portless ${unscoped(packageName)} next dev`,
      build: 'next build',
      start: 'next start',
      lint: 'eslint',
      // Called by .github/workflows/publish.yml, and by you — see the readme.
      ...releaseScripts(packageName),
    },
    dependencies: {
      next: VERSIONS.next,
      react: VERSIONS.react,
      'react-dom': VERSIONS.react,
    },
    devDependencies: {
      '@fairgarden/distribution': VERSIONS.distribution,
      '@fairgarden/monolith': VERSIONS.monolith,
      '@types/node': VERSIONS.types.node,
      '@types/react': VERSIONS.types.react,
      '@types/react-dom': VERSIONS.types.reactDom,
      eslint: VERSIONS.eslint,
      'eslint-config-next': VERSIONS.eslintConfigNext,
      // `dev` serves this at a stable hostname instead of a port.
      portless: VERSIONS.portless,
      typescript: VERSIONS.typescript,
    },
  }),
  'next.config.ts': `import type { NextConfig } from 'next'
import { withMonolithicPortability } from '@fairgarden/monolith'

const nextConfig: NextConfig = {}

// Reports anything that would not survive being mounted in a monolith.
export default withMonolithicPortability(nextConfig)
`,
  'tsconfig.json': json({
    ...TSCONFIG,
    compilerOptions: {
      ...TSCONFIG.compilerOptions,
      // So this module's own files can import each other by package name,
      // which is what keeps them resolvable once mounted.
      paths: { [`${packageName}/*`]: ['./*'] },
    },
  }),
  'eslint.config.mjs': `import next from 'eslint-config-next/core-web-vitals'
import monolith from '@fairgarden/monolith/eslint'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  { ignores: ['node_modules/**', '.next/**'] },
  ...next,
  ...monolith.configs.recommended,
]

export default config
`,
  'lib/link.ts': `import { createHref, createLink } from '@fairgarden/monolith/link'

// Use these instead of next/link so hrefs carry the mount point when this
// module is served inside a monolith.
export const Link = createLink('${packageName}')
export const href = createHref('${packageName}')
`,
  'app/layout.tsx': `export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`,
  'app/page.tsx': `import { Link } from '${packageName}/lib/link'

export default function Home() {
  return (
    <main>
      <h1>${packageName}</h1>
      <Link href="/">Home</Link>
    </main>
  )
}
`,
})

/** Write a file map, creating directories as needed. */
export const write = async (root: string, files: Files): Promise<string[]> => {
  const written: string[] = []

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, contents)
    written.push(relative)
  }

  return written.sort()
}

/** Whether a directory has anything in it, so `init` never writes over work. */
export const isEmpty = async (dir: string): Promise<boolean> => {
  const entries = await readdir(dir).catch(() => undefined)
  if (!entries) return true
  return entries.filter((entry) => entry !== '.git').length === 0
}

export const readPackageName = async (root: string): Promise<string | undefined> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    return typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}


/**
 * The organization's `policies/`: its `.manifest`, and a workspace package
 * that builds and tests it with `fg-dist policy`. Empty of rules: until the
 * organization writes some, the modules' own decide.
 */
const policiesFiles = (name: string, origin?: string): Files => ({
  'policies/.manifest': json({
    metadata: {
      organization: name,
      ...(origin ? { source: origin.replace(/\.git$/, '') } : {}),
    },
  }),
  'policies/package.json': json({
    name: `${name}-policies`,
    license: 'MIT',
    private: true,
    type: 'module',
    scripts: { build: 'fg-dist policy build', test: 'fg-dist policy test' },
    devDependencies: {
      '@fairgarden/distribution': VERSIONS.distribution,
      '@fairgarden/policy': VERSIONS.policy,
    },
  }),
  'policies/.gitignore': '/dist\n/node_modules\n/.turbo\n',
  'policies/Readme.md': `# Policies

The organization's rules for the services this distribution ships: who may
join, what is shared and with whom. Each module brings its own rules, in its
own \`policies/\`; the organization's go here, in the same Rego packages,
adding to the places those rules leave for them — so upgrading a module keeps
them.

Change them by pull request, like anything else here: what is merged is what
the next deployment runs, and anyone can read it on the id service's
\`/policy\` page.

\`\`\`bash
pnpm dist policy test     # each module's tests, then these on top
pnpm dist policy build    # what the services will run
\`\`\`

\`.manifest\` says whose rules these are; its \`metadata\` is shown with them.
`,
})

/**
 * A repository that ships a set of modules to end users.
 *
 * The root package.json is the distribution manifest: its version names the
 * month and which release of it this is (see calver.ts), and the modules it
 * ships are its submodules, each at a semver version. `extends` names another distribution whose modules this one
 * inherits and may move ahead of, but never behind.
 */
export const distributionRepo = (
  name: string,
  origin?: string,
  parent?: string,
  { monolith = true, copyright = `The ${name} authors` }: { monolith?: boolean } & LicenseOptions = {}
): Files => {
  // A distribution of only Next apps can deploy as one. A complex one cannot,
  // and then each app under apps/ is deployed on its own — which is fine for
  // an audience that already has deployment infrastructure.
  const files = monolith
    ? monolithRepo(name, origin, { copyright })
    : {
        LICENSE: mitLicense(copyright),
        '.gitignore': `node_modules\n.turbo\n`,
        '.npmrc': `link-workspace-packages=true\nsave-workspace-protocol=true\n`,
        'pnpm-workspace.yaml': WORKSPACE,
        // turbo refuses a --filter naming a directory that does not exist.
        'apps/.gitkeep': '',
        'packages/.gitkeep': '',
        'turbo.json': turboJson(undefined),
      }

  // What it ships, noted as fg-dist changes it; pull requests that change its
  // policy add their own line, which CI checks — as it checks that what
  // fg-dist writes here is current.
  Object.assign(files, checkWorkflows({ submodules: true }))

  // The organization's policy, built on every module's own; a workspace
  // package, so turbo builds it once for every service that runs it.
  files['pnpm-workspace.yaml'] = files['pnpm-workspace.yaml'].replace(
    '  - "packages/*"\n',
    '  - "packages/*"\n  - "policies"\n'
  )
  Object.assign(files, policiesFiles(name, origin))

  const version = firstRelease()
  files[CHANGELOG] = newChangelog(version)
  files['package.json'] = json({
    name,
    // End users read the month, not a semver range: it says how old their copy
    // is. It starts as this month's first release, in alpha — see calver.ts.
    version,
    license: 'MIT',
    private: true,
    ...(origin ? { repository: { type: 'git', url: origin } } : {}),
    ...(parent ? { distribution: { extends: parent } } : {}),
    scripts: {
      ...rootScripts(monolith),
      // `pnpm dist <command>`, and what the workflows run.
      ...releaseScripts(name),
    },
    // Modules go here, each pinned to the semver version this ships.
    dependencies: parent ? { [parent]: 'latest' } : {},
    devDependencies: { '@fairgarden/distribution': VERSIONS.distribution, turbo: '^2.11.2' },
  })

  files['Readme.md'] = `# ${name}

A distribution: the set of modules shipped together, released under a calendar
version — \`26.09.01\` is the first release of September 2026 — so it is obvious
how old a copy is.

Modules are listed in \`dependencies\`, each pinned to a semver version, and
checked out as submodules. Add one with \`pnpm dist add-module <url>\`, and see
what has moved with \`pnpm dist sync\`.

## Running
${
  monolith
    ? `
\`\`\`bash
pnpm dev             # the monolith, serving every app, on port 3000
pnpm build           # the monolith, as it is deployed
pnpm modular:dev     # each app on its own instead
pnpm modular:build
pnpm docs:dev        # the documentation sites, which neither runs
\`\`\`
`
    : `
\`\`\`bash
pnpm dev             # every app, each on its own
pnpm build
pnpm docs:dev        # the documentation sites, which neither runs
\`\`\`
`
}
## Deploying
${
  monolith
    ? `
Every module is mounted into \`apps/monolith\`, which deploys as one Next app.
`
    : `
Each app under \`apps/\` is deployed on its own. There is no monolith app,
which is the right shape once the distribution is too complex to serve from one
deployment — and fine for an audience that already runs deployment
infrastructure.
`
}${
  parent
    ? `
## Extends

This distribution extends \`${parent}\`. It ships that distribution's modules
and may move ahead of them, but can never ship anything older. \`pnpm dist check\`
fails when it does${monolith ? ', and so does the monolith build' : ''}.
`
    : ''
}`

  return files
}
