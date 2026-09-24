export type { Files } from './scaffold.ts'
export {
  VERSIONS,
  distributionRepo,
  moduleRepo,
  monolithRepo,
  isEmpty,
  readPackageName,
  write,
} from './scaffold.ts'

export { addModule, findMonolith, nameFromUrl } from './add-module.ts'
export type { AddModuleOptions, AddModuleResult } from './add-module.ts'

export { addMount, ConfigEditError } from './config-edit.ts'
export type { EditResult } from './config-edit.ts'

export { describeRemote, isSsh, toHttps } from './git-url.ts'

export {
  inspect,
  isPublic,
  moveTo,
  repositoryRoot,
  setUrl,
  submodules,
  target,
} from './submodules.ts'
export type { ReleaseKind, Submodule, SubmoduleState } from './submodules.ts'

export {
  assertExtends,
  describeViolations,
  findFloorViolations,
  inspectExtends,
  readDistribution,
  readParent,
} from './extends.ts'
export type { Distribution, ExtendsReport, FloorViolation } from './extends.ts'

export { buildPolicy, findPolicy, setupTurbo, testPolicy, turboTasks, usePolicy } from './policy.ts'
export type { DistributionPolicy } from './policy.ts'
