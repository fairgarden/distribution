# Changelog

## 0.1.0-alpha.8

## 0.1.0-alpha.7

- `pnpm dist migrate` migrates the databases of what a build deploys, after building it: an app its own, a monolith every app it mounts, each into the database that app uses. Vercel production builds migrate; previews only with `FG_MIGRATE=build`. New distributions run it after `turbo run build`, outside turbo, which would keep an app's database variables from it ([#8](https://github.com/fairgarden/distribution/pull/8))
- `@fairgarden/distribution/migrations` is the migrator apps share, for their embedded databases too; an app declares its migrations under `fairgarden.migrations` in package.json ([#8](https://github.com/fairgarden/distribution/pull/8))
- `pnpm dist env check --build` refuses to deploy without what the apps need, naming each variable and what it is for; an app declares them under `fairgarden.env` in package.json, and new distributions check before building ([#8](https://github.com/fairgarden/distribution/pull/8))
- `pnpm dist env setup` adds what each Vercel project lacks through the Vercel CLI — one project for a monolith, one per app without one — generating secrets, setting shared ones alike, and asking for the rest ([#8](https://github.com/fairgarden/distribution/pull/8))
- `pnpm dist env rotate` rotates the generated secrets with no downtime, redeploying production after each step, and `pnpm dist env workflow` schedules it monthly ([#8](https://github.com/fairgarden/distribution/pull/8))

## 0.1.0-alpha.6

- `next-version` starts the next development cycle after a release, and asks what its version is. It was `release`, which still works and says so; `workflows` renames a module's script ([#6](https://github.com/fairgarden/distribution/pull/6))
- A pull request that starts the next version is only excused its changelog line when that is all it does ([#6](https://github.com/fairgarden/distribution/pull/6))

## 0.1.0-alpha.5

- Improve the readme and command docs experience ([#4](https://github.com/fairgarden/distribution/pull/4))

## 0.1.0-alpha.4

## 0.1.0-alpha.3

## 0.1.0-alpha.2
