# Fair Garden Distribution

A package that provides a set of tools to distribute software to users.

## Versioning

End users don't care about Semantic Versioning. They just want to get the latest version and know that it's up to date.

If a user is on version `2023.12.01` and the latest version is `2024.12.01`, they know it's been an entire year since they received a new version. If a user is on version `1.1.1` and the latest version is `1.2.1`, it's not immediately clear how long it's been since they received an update. Secure software requires regular updates. It should always be as easy as possible to bump a time based version.

On the other hand, developers love Semver because it helps them gauge how easy it will be to upgrade. If a package is on version `1.1.1` and the latest version is `1.2.1`, they know that it's a minor version bump and that it should be safe to upgrade. If the latest version is `2.0.0`, they know that it's a major version bump and that it might require more work to upgrade.

## Hybridized Monorepo Submodule Versioning

To achieve the best of both worlds, we use both versioning strategies based on the audience. End users consume software through a "distribution" package. Developers consume software through the individual modules. For example:

`@fairgarden/core`: `2023.12.01`
Depends on:

- `@fairgarden/id`: `1.2.3`
- `@fairgarden/design`: `1.5.6`
- `@fairgarden/membership`: `1.0.0`

Different distributions can contain a different set of modules, and can be versioned independently. For example:

`@fairgarden/enterprise`: `2023.12.01` <-- Proprietary distributions
Depends on:

- `@fairgarden/id`: `1.2.3` <-- Public module
- `@fairgarden/design`: `1.5.6` <-- Public module
- `@fairgarden/enterprise-membership`: `1.0.0` <-- Proprietary extension of public module
- `@fairgarden/enterprise-phone`: `1.9.9` <-- Proprietary package

External developers can create their own distribution, or simply consume the modules directly from within their own project.

Git tags are applied to the module directly. Monorepos today add a tag for each package in the monorepo adding a lot of noise to the git history. This is not necessary. The distribution package is the only package that needs to be tagged when consuming the distribution itself.

## Extending a Distribution

A distribution may extend another. The extension ships the parent's modules and
may move ahead of them, but can never ship anything older — otherwise "extends"
would mean shipping a regression.

`@acme/core`: `2024.06.01`, extending `@fairgarden/core`: `2024.01.01`

| Module | `@fairgarden/core` ships | `@acme/core` ships | |
| --- | --- | --- | --- |
| `@fairgarden/id` | `1.2.3` | `1.4.0` | ahead, fine |
| `@fairgarden/design` | `1.5.6` | `1.5.6` | matching, fine |
| `@fairgarden/membership` | `1.0.0` | `0.9.0` | behind, refused |

The parent is an ordinary dependency, so whatever version is installed is the
one being extended:

```json
{
  "name": "@acme/core",
  "version": "2024.06.01",
  "dependencies": { "@fairgarden/core": "2024.01.01" },
  "distribution": { "extends": "@fairgarden/core" }
}
```

Note what is *not* there: no module versions. Nothing in a distribution
repository pins one.

## Where a version comes from

The submodule commit is the pin, and the version is whatever the `package.json`
inside that checkout says. pnpm links the checkout into the workspace, so that
is also the version everything in the repository resolves against — an app
depending on a package gets the checkout, not a published copy.

That means a version is stated once, by the module itself. A repository that
also wrote `"@acme/design": "1.4.0"` somewhere would be carrying a second copy
of the same fact, free to drift. So modules are depended on with
`workspace:*`, and `sync` reports the version it reads out of each checkout:

```
apps/widget      v1.2.0  -> v1.3.0 (minor)
packages/design  v1.4.0  up to date
```

A published distribution has no submodules, so its manifest carries the
versions it shipped — which is what an extension is compared against. Ranges
are compared by the oldest version they allow, since that is the oldest thing
the distribution could resolve to.

## Apps and Packages

A distribution is apps and the packages they share. `add-module` reads the
checkout to tell them apart: a repository with routes is an app, mounted at a
path; one without is a package, depended on rather than served.

```
Added packages/design from https://github.com/acme/design.git
Shipping @acme/design@1.4.0, as the checkout declares it
Linked through the workspace in apps/monolith/package.json
It has no routes, so it is a package the apps depend on rather than one to mount.
```

An app depending on such a package should declare it as a `peerDependency`, so
the workspace supplies it and the app never carries a version of its own.

This is what lets a stricter license sit on top of a permissive base. The
proprietary distribution extends the MIT one, reuses its modules, and adds or
replaces the ones it needs. It is also how someone outside the project keeps
their own `core` repository extending the published one.

`fg-dist sync` reports any module that has fallen behind, `fg-dist check` fails
on it, and a monolith refuses to build — shipping a regression should stop a
build rather than wait to be noticed. A distribution whose apps deploy
separately has no monolith build, so `check` is what to run in CI.

## Growing a Module In Place

A new app or package is easier to get working inside the distribution, where the
workspace already resolves it and there is one repository to run. It only wants
its own history once it works.

```bash
fg-dist extract packages/charts --url https://github.com/acme/charts.git
```

```
packages/charts is now a repository and a submodule of this one
Shipping @acme/charts@0.3.0
Tagged v0.3.0, so sync can track it
origin is https://github.com/acme/charts.git

Push it before anyone else clones this:
    git -C packages/charts push -u origin main --tags
Then commit the new submodule here.
```

The directory becomes a repository, its contents are committed, its manifest
version becomes its first tag, and the distribution picks it straight back up as
a submodule. Nothing is re-cloned and nothing moves on disk — `git submodule
add` adopts a repository that is already at the path — so this works before the
remote exists. Push afterwards; until you do, the submodule points at a remote
nobody else can fetch.

An existing repository at the path is kept, history and all. An SSH url is
rewritten like everywhere else, and `--no-tag` skips the tag.

## Running It

```bash
pnpm dev            # the monolith, plus the packages it builds from
pnpm dev-services   # every app on its own, no monolith
```

With a monolith, `dev` runs it and the packages — not the mounted apps, since
the monolith already serves their routes and running both would be the same
routes twice.

`dev-services` is the other shape: each app on its own, which is what you want
to work on one in isolation, and the only shape available to a distribution too
complex to serve from one deployment. A `--separate` distribution has no
monolith, so its `dev` is `dev-services`.

Each app runs through [portless](https://portless.sh), which gives it a stable
hostname instead of a port so several can run at once:

```
@acme/widget:dev:service: > portless widget next dev
                          -> https://widget.localhost
```

A scaffolded module gets the `dev:service` script and `portless` as a
devDependency; `dev` stays plain `next dev`, so nothing depends on portless
unless you run the services mode.

## Public / Private Boundaries

A private distribution may depend some public code and some private code.

A private module might extend a public module.

A module might be a fork of a third-party module, forking an entire project is not necessary to extend it. You just create your own distribution, reuse all the modules except the one you want to extend, and replace it with your own fork.

## Deploying a Distribution

When a distribution is made up of only Next.js projects, you can deploy them into a single deployment. Only advanced use cases require users to deploy each app separately. When scaling, it is often helpful to split deployments.

A distribution complex enough that one deployment will not do has no monolith
app at all. Scaffold it with `--separate`, and each app under `apps/` is
deployed on its own — which is no hardship for an audience that already runs
deployment infrastructure:

```bash
fg-dist init distribution enterprise --name @acme/enterprise --separate
```

`add-module` then records the module in the distribution manifest and stops
there, rather than mounting it:

```
Added apps/widget from https://github.com/acme/widget.git
Shipping @acme/widget@1.2.0 in package.json
No monolith app here, so it is shipped but not mounted. Deploy it on its own.
```

The app that composes modules is identified by its Next config calling
`withMonolith`, not by depending on `@fairgarden/monolith` — every module
depends on that too, for the portability check and the portable Link.

Because there is no monolith build to fail, `fg-dist check` is what enforces the
floor for such a distribution. Run it in CI.

## Maintenance Branches

When a distribution becomes more mature, users may be slow to make major upgrades. In this case, an LTS branch should be created.

Depending on how often you create breaking changes, you may want to create a new LTS branch once or twice a year, or every two years. This is a balance between the cost of maintaining multiple branches and the cost of forcing users to upgrade too often.

### Yearly Example

`lts-2023` is created in 2023 and maintained until 2025.

- tags: `2023.01-lts`, `2023.02-lts`, etc.

`lts-2024` is created in 2024 and maintained until 2026.

- tags: `2024.01-lts`, `2024.02-lts`, etc.

### Quarterly Example

`lts-2023-q2` is created in Q2 2023 and maintained until Q2 2024.

- tags: `2023.04.01-lts`, `2023.04.02-lts`, etc.

`lts-2023-q4` is created in Q4 2023 and maintained until Q4 2024.

- tags: `2023.10.01-lts`, `2023.10.02-lts`, etc.

`lts-2024-q2` is created in Q2 2024 and maintained until Q2 2025.

- tags: `2024.04.01-lts`, `2024.04.02-lts`, etc.

### Module Branches

Modules should not have LTS releases. If a module changes often enough, it should have maintenance branches based on the patch version. For example:

`@fairgarden/id`:
  `1.2.3` is the latest version
  `1.2.x` is the `main` branch, until branched off when `1.3.0` is released
  `1.1.x` is the previous maintenance branch

Where:

`@fairgarden/core:2023.04.01` depends on `1.1.x` of `@fairgarden/id`.
`@fairgarden/core:2023.10.01` depends on `1.2.x` of `@fairgarden/id`.

Module maintenance branches are only necessary if LTS is being used in a distribution. When a module is being used within an LTS distribution, it means the module itself is probably more dependable for external use of just that module.

## Commands

```bash
fg-dist init distribution acme --name @acme/core --extends @fairgarden/core
fg-dist init module widget --name @acme/widget --url https://github.com/acme/widget.git
fg-dist add-module https://github.com/acme/widget.git
fg-dist extract packages/charts --url https://github.com/acme/charts.git
fg-dist check                # fail when it ships anything older than its parent
fg-dist sync                 # what has moved, and whether the floor holds
fg-dist bump [name...]       # take the newest non-major version
fg-dist use-https            # rewrite ssh submodule urls, and check they are public
```

Mounting those modules into one Next deployment is a separate concern, handled
by `@fairgarden/monolith` and its `fg-monolith` command.

## Build Scripts

Build scripts should be written directly in the `package.json`, or if more complex, in a `scripts` directory. This way, the build scripts are versioned with the package and are easy to find. If CLI tools are used, they should be executed using `zx`.

## Modules Not Written in Javascript

Many projects depend on modules that are not written in Javascript. They should still have a package.json, but not be published to npm. They should be included in the distribution as a submodule. Build scripts should be documented in the package.json, so that it is run cohesively so we have a unified development environment. `zx` is a great tool that makes scripts easier to write than in bash.
