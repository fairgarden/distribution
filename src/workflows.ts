import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { submodules } from './submodules.ts'
import type { Files } from './scaffold.ts'

/**
 * The publishing workflow a module carries.
 *
 * A module releases on its own schedule, so the workflow lives in the module
 * rather than the distribution. Authentication is npm trusted publishing over
 * OIDC — there is no token to leak, and the package must already exist on npm
 * with a trusted publisher pointing at this repository and this file.
 */
export const publishWorkflow = (packageName: string): Files => ({
  '.github/workflows/publish.yml': `name: Publish

# npm trusted publishing is configured against one workflow file per package,
# so canary and release both live here. There is no npm token: the package must
# already exist on npm with a trusted publisher pointing at this repository and
# this file. Bootstrap a new package by publishing it once from a workstation,
# then configure trusted publishing on npmjs.com.

on:
  push:
    branches:
      - main
  schedule:
    - cron: '0 0 * * *' # Daily at midnight UTC
  workflow_dispatch:
    inputs:
      dist-tag:
        description: 'npm dist tag to publish the release to'
        required: false
        type: string
        default: 'latest'
      dry-run:
        description: 'Pack and validate without publishing'
        required: false
        type: boolean
        default: false

permissions: {}

concurrency:
  group: publish-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  canary:
    name: Publish canary
    # Lockfile bumps do not warrant a canary.
    if: >
      github.event_name == 'schedule'
      || (github.event_name == 'push' && github.event.head_commit.author.name != 'renovate[bot]')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # Required for provenance and trusted publishing
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false

      - name: Prepare for publishing
        uses: ./.github/actions/publish-prepare

      - name: Stamp the canary version
        id: canary
        # \`fg-dist canary\` works out the version and whether there is anything
        # to publish: a canary records the commit it was built from, so a
        # nightly run with nothing new is a no-op rather than a version bump.
        run: pnpm run canary

      - name: Publish to npm
        if: steps.canary.outputs.skip != 'true'
        # Provenance only where npm will generate it: it refuses for anything
        # not published publicly, and refusing is a failed publish.
        run: |
          if [ "\${{ steps.canary.outputs.provenance }}" = "true" ]; then
            npm publish --tag canary --provenance
          else
            npm publish --tag canary
          fi

      - name: Summary
        run: |
          if [ "\${{ steps.canary.outputs.skip }}" = "true" ]; then
            echo "\\\`\${{ steps.canary.outputs.version }}\\\` is already the canary for this commit." >> "\$GITHUB_STEP_SUMMARY"
          else
            echo "Published \\\`${packageName}@\${{ steps.canary.outputs.version }}\\\` to the \\\`canary\\\` tag." >> "\$GITHUB_STEP_SUMMARY"
          fi

  release:
    name: Publish release
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: write # Required for pushing the tag and creating the release
      id-token: write # Required for provenance and trusted publishing
    environment:
      name: npm-publish
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          fetch-depth: 0 # \`gh release create --generate-notes\` needs history

      - name: Prepare for publishing
        uses: ./.github/actions/publish-prepare

      - name: Resolve version
        id: version
        # Refuses when the version is already on npm: main is meant to carry the
        # next unreleased version, so finding it published means \`fg-dist
        # release\` has not run since the last one.
        run: pnpm run release:check

      - name: Publish to npm
        env:
          DIST_TAG: \${{ inputs.dist-tag }}
          # npm refuses provenance for anything not published publicly.
          PROVENANCE: \${{ steps.version.outputs.provenance }}
          DRY_RUN: \${{ inputs.dry-run }}
        run: |
          flags="--tag \$DIST_TAG"
          [ "\$PROVENANCE" = "true" ] && flags="\$flags --provenance"
          [ "\$DRY_RUN" = "true" ] && flags="\$flags --dry-run"
          npm publish \$flags

      - name: Tag and create the GitHub release
        if: inputs.dry-run != true
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TAG: \${{ steps.version.outputs.tag }}
        run: |
          git tag "\$TAG"
          git push origin "\$TAG"
          gh release create "\$TAG" \\
            --title "\$TAG" \\
            --generate-notes \\
            --verify-tag

      - name: Summary
        run: |
          echo "Published \\\`${packageName}@\${{ steps.version.outputs.version }}\\\` to the \\\`\${{ inputs.dist-tag }}\\\` tag." >> "\$GITHUB_STEP_SUMMARY"
`,

  '.github/actions/publish-prepare/action.yml': `name: Prepare for publishing
description: Install dependencies and build, so the package is ready to publish.

# Kept as an action rather than repeated steps: npm trusted publishing pins one
# workflow file per package, so the canary and release jobs both have to share
# this.

runs:
  using: composite
  steps:
    # Pin these to a commit sha once Renovate is watching the repository. The
    # checkout in the workflow is pinned already, because it handles credentials.
    #
    # No \`version\` here: the \`packageManager\` field in package.json is what
    # pins pnpm, and giving both makes this action refuse to choose.
    - uses: pnpm/action-setup@v4

    - uses: actions/setup-node@v4
      with:
        # Inline rather than \`node-version-file\`, so this action works in a
        # repository that has no \`.nvmrc\`.
        node-version: 22
        # No \`cache: pnpm\`: it needs a lockfile to hash, and a module developed
        # inside a distribution keeps its lockfile in the distribution.
        registry-url: https://registry.npmjs.org

    - name: Install
      shell: bash
      run: |
        if [ -f pnpm-lock.yaml ]; then
          pnpm install --frozen-lockfile
        else
          # A module developed inside a distribution has no lockfile of its
          # own; the distribution's workspace holds it.
          pnpm install --no-frozen-lockfile
        fi

    - name: Build
      shell: bash
      # A module that is consumed as source has nothing to build; one that ships
      # a \`dist\` does. Neither should have to edit this file.
      run: pnpm run --if-present build
`,

})

export interface WorkflowUpdate {
  relativePath: string
  files: string[]
  skipped: boolean
  /** Whether `private: true` was taken off, so the module can publish at all. */
  unprivated: boolean
  /** True when nothing in the manifest says what the tarball should contain. */
  missingFiles: boolean
  /** True when nothing says whether the package publishes publicly. */
  missingAccess: boolean
}

const readManifest = async (
  root: string
): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The package whose CLI a module releases with. */
const TOOL = '@fairgarden/distribution'

/**
 * This tool's own version, which is what a module is given to release with.
 *
 * Read rather than written down, so a module is pinned to the CLI that set it
 * up instead of to whatever was current when this file was last edited.
 */
const toolVersion = async (): Promise<string | undefined> => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const own = await readManifest(path.join(here, '..'))
  return typeof own?.version === 'string' ? own.version : undefined
}

/**
 * The scripts the workflow calls, and a module releases by hand with.
 *
 * They are named rather than spelled out in the workflow so that every
 * module's workflow is the same file, and so `pnpm release` is the answer to
 * "how do I release this" wherever you are standing.
 */
export const releaseScripts = (packageName: string): Record<string, string> => {
  // The tool cannot depend on itself being published to release itself.
  const cli = packageName === TOOL ? 'node dist/cli.js' : 'fg-dist'
  return {
    canary: `${cli} canary`,
    release: `${cli} release`,
    'release:check': `${cli} release --check`,
  }
}

export interface ManifestChange {
  changed: boolean
  unprivated: boolean
  missingFiles: boolean
  missingAccess: boolean
}

/**
 * Give a module what it needs to publish itself.
 *
 * One pass over the manifest rather than several: a structural rewrite undoes
 * a careful textual splice, so doing both would mean the second silently
 * discarding the first's formatting. Two-space JSON is what npm and pnpm write
 * anyway.
 */
export const updateManifest = async (
  moduleRoot: string,
  packageName: string,
  version: string | undefined,
  packageManager: string | undefined,
  { write = true }: { write?: boolean } = {}
): Promise<ManifestChange> => {
  const manifest = await readManifest(moduleRoot)
  if (!manifest) {
    return { changed: false, unprivated: false, missingFiles: false, missingAccess: false }
  }

  const before = JSON.stringify(manifest)
  const updated: Record<string, unknown> = { ...manifest }

  // A private package cannot be published, which is the one thing the workflow
  // being added here is for.
  const unprivated = updated.private === true
  if (unprivated) delete updated.private

  // `pnpm/action-setup` takes its version from this field and will not run
  // without one. A module that pins its own is left alone.
  if (!updated.packageManager && packageManager) {
    updated.packageManager = packageManager
  }

  const scripts = { ...(updated.scripts as Record<string, string> | undefined) }
  for (const [name, command] of Object.entries(releaseScripts(packageName))) {
    // A script the module already defines may call the tool differently on
    // purpose.
    if (!scripts[name]) scripts[name] = command
  }
  updated.scripts = scripts

  const dependencies = updated.dependencies as Record<string, string> | undefined
  const devDependencies = updated.devDependencies as Record<string, string> | undefined

  // Whichever list already has it wins; the tool is only needed to release, so
  // a module that does not already depend on it gets it as a devDependency.
  if (packageName !== TOOL && !dependencies?.[TOOL] && !devDependencies?.[TOOL] && version) {
    updated.devDependencies = { ...devDependencies, [TOOL]: `^${version}` }
  }

  const changed = JSON.stringify(updated) !== before
  if (changed && write) {
    await writeFile(
      path.join(moduleRoot, 'package.json'),
      `${JSON.stringify(updated, null, 2)}\n`
    )
  }

  // Guessed at, this would be wrong: a module consumed as source ships `app`
  // and `lib`, one that builds ships `dist`, and npm's default ships both plus
  // whatever else is lying around. Report it instead.
  // Both of these are reported rather than guessed. `files` because a module
  // consumed as source ships `app` and `lib` while one that builds ships
  // `dist`. `publishConfig.access` because npm takes an explicit value as an
  // instruction to *change* an existing package's visibility — writing
  // `restricted` into an already-public package would make it private on the
  // next publish, or fail on an org with no paid plan.
  return {
    changed,
    unprivated,
    missingFiles: !updated.files,
    missingAccess:
      packageName.startsWith('@') &&
      (updated.publishConfig as { access?: unknown } | undefined)?.access === undefined,
  }
}


/**
 * Give every module a publishing workflow.
 *
 * A module that already has one is left alone: it may have been changed on
 * purpose, and overwriting it would be the kind of help nobody asked for.
 */
export const writeWorkflows = async (
  root: string,
  { force = false, dryRun = false }: { force?: boolean; dryRun?: boolean } = {}
): Promise<WorkflowUpdate[]> => {
  const updates: WorkflowUpdate[] = []
  // What the distribution builds with, which is what its modules are developed
  // against whether or not they say so themselves.
  const packageManager = (await readManifest(root))?.packageManager
  const spec = typeof packageManager === 'string' ? packageManager : undefined
  const tool = await toolVersion()

  for (const submodule of submodules(root)) {
    const name = (await readManifest(submodule.path))?.name
    if (typeof name !== 'string') continue

    const workflow = path.join(submodule.path, '.github/workflows/publish.yml')
    if (existsSync(workflow) && !force) {
      updates.push({
        relativePath: submodule.relativePath,
        files: [],
        skipped: true,
        unprivated: false,
        missingFiles: false,
        missingAccess: false,
      })
      continue
    }

    const written: string[] = []
    for (const [relative, contents] of Object.entries(publishWorkflow(name))) {
      const full = path.join(submodule.path, relative)
      if (!dryRun) {
        await mkdir(path.dirname(full), { recursive: true })
        await writeFile(full, contents)
      }
      written.push(relative)
    }

    // An earlier version of this command shipped the canary stamper as a file
    // in the module. It is a CLI command now, and a stale copy of it would go
    // on being the thing anyone reads.
    const stale = path.join(submodule.path, 'scripts/stampCanaryVersion.mjs')
    if (existsSync(stale)) {
      if (!dryRun) {
        await rm(stale)
        // And the directory, if that was the only thing in it. A module with
        // scripts of its own keeps them.
        await rm(path.dirname(stale), { recursive: false }).catch(() => {})
      }
      written.push('scripts/stampCanaryVersion.mjs (removed)')
    }

    const manifest = await updateManifest(submodule.path, name, tool, spec, {
      write: !dryRun,
    })
    if (manifest.changed) written.push('package.json')

    updates.push({
      relativePath: submodule.relativePath,
      files: written.sort(),
      skipped: false,
      unprivated: manifest.unprivated,
      missingFiles: manifest.missingFiles,
      missingAccess: manifest.missingAccess,
    })
  }

  return updates
}
