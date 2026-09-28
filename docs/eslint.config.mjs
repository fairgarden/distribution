import next from 'eslint-config-next/core-web-vitals'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // .next*: the default distDir and the NEXT_DIST_DIR ones parallel builds use.
  { ignores: ['node_modules/**', '.next*/**'] },
  ...next,
]

export default config
