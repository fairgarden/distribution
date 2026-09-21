# FairGarden Distribution

<!-- fg:version -->

Version **0.1.0-alpha.0**

<!-- /fg:version -->

<!-- fg:releasing -->

## Releasing

This module releases on its own. `0.1.0-alpha.0` is what main is working towards,
not what is published — the version here is always the next one.

1. **Publish it.** Run the *Publish* workflow from the Actions tab, picking the
   dist tag. It refuses if that version is already on npm.
2. **Move it on.** `pnpm release` — opens a pull request bumping this branch
   to `0.1.0-alpha.1`, or `pnpm release --id rc` to change
   identifier. A prerelease gets no maintenance branch; there is no released
   line behind it yet.

Every push to main publishes `@fairgarden/distribution@canary`. A canary is not a release and
carries no promise; it is there so main can be tried without a checkout.

<!-- /fg:releasing -->

Ship a set of versioned modules together.

End users do not care about semver — they want to know how old their copy is,
and `2024.12.01` says that at a glance where `1.2.1` does not. Developers do
care, because semver says how much work an upgrade will be. A distribution uses
each where it belongs: the distribution is versioned by date, the modules inside
it by semver.

```
@fairgarden/core  2024.12.01
  @fairgarden/id          1.2.3
  @fairgarden/design      1.5.6
  @fairgarden/membership  1.0.0
```

Modules are git submodules, so the commit is the pin and the version is whatever
the module's own `package.json` says. Nothing in the distribution repository
restates it.

## Documentation

The docs are a site in this repository. Run them with:

```bash
pnpm --filter @fairgarden/distribution-docs dev
```

- **Versioning** — why two schemes, where a version comes from, and LTS branches
- **Modules** — apps, packages, and how they resolve
- **Extending** — one distribution built on another
- **Deploying** — one deployment, or many
- **Running it** — dev modes, and a hostname per app
- **Growing a module** — building in place, then extracting
- **Releasing a module** — semver, maintenance branches and dist-tags
- **Submodule urls** — what a build host can actually clone
- **Commands** and **Functions** — the `fg-dist` CLI and its API

## Install

```bash
pnpm add -D @fairgarden/distribution
```

Or scaffold without installing anything:

```bash
pnpx @fairgarden/distribution init distribution acme --name @acme/core
```

```bash
fg-dist init <kind> [dir]    # scaffold a distribution, monolith or module
fg-dist add-module <url>     # add a module repository as a submodule
fg-dist extract <path>       # turn a directory here into its own repository
fg-dist sync                 # what has moved, and whether the floor holds
fg-dist bump [name...]       # take the newest non-major version
fg-dist check                # fail when this ships older than what it extends
fg-dist use-https            # rewrite ssh submodule urls, and check they are public
fg-dist readme               # write the module versions into the readmes
fg-dist overrides            # resolve modules from the tree, not the registry
fg-dist workflows            # give every module a publishing workflow
fg-dist canary               # stamp a canary version, for CI
fg-dist release --minor      # open the next version on main, and a branch behind it
fg-dist prerelease --major   # start the next line on a branch, leaving main alone
```

Mounting a distribution's apps into one Next deployment is a separate concern,
handled by `@fairgarden/monolith`.
