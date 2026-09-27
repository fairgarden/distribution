# Changelog

## 0.1.0-alpha.7

- `pnpm dist migrate` migrates the databases of what a build deploys, after building it: an app its own, a monolith every app it mounts, each into the database that app uses. Vercel production builds migrate; previews only with `FG_MIGRATE=build`. New distributions run it as a turbo task after `build` ([#8](https://github.com/fairgarden/distribution/pull/8))
- `@fairgarden/distribution/migrations` is the migrator apps share, for their embedded databases too; an app declares its migrations under `fairgarden.migrations` in package.json ([#8](https://github.com/fairgarden/distribution/pull/8))

## 0.1.0-alpha.6

- `next-version` starts the next development cycle after a release, and asks what its version is. It was `release`, which still works and says so; `workflows` renames a module's script ([#6](https://github.com/fairgarden/distribution/pull/6))
- A pull request that starts the next version is only excused its changelog line when that is all it does ([#6](https://github.com/fairgarden/distribution/pull/6))

## 0.1.0-alpha.5

- Improve the readme and command docs experience ([#4](https://github.com/fairgarden/distribution/pull/4))

## 0.1.0-alpha.4

## 0.1.0-alpha.3

## 0.1.0-alpha.2
