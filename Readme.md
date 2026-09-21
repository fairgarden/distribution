# FairGarden Distribution

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
```

Mounting a distribution's apps into one Next deployment is a separate concern,
handled by `@fairgarden/monolith`.
