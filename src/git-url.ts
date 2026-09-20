/**
 * Git remote URLs, normalised for hosts that clone submodules anonymously.
 *
 * A submodule URL is recorded in `.gitmodules` and committed, so whatever is
 * written there is what every later clone uses — including builds on a host
 * that has no SSH key. Vercel clones submodules over HTTPS and only public
 * ones, so an `scp`-style or `ssh://` URL checks out fine locally and then
 * fails in the build.
 */

/** `git@host:owner/repo.git` — git's scp-like shorthand, not a real URL. */
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/

/** A path or a `file:` URL, which has no host to rewrite. */
const isLocal = (url: string): boolean =>
  url.startsWith('.') ||
  url.startsWith('/') ||
  url.startsWith('file:') ||
  /^[A-Za-z]:[\\/]/.test(url)

/** `ssh://`, and git's own `git+ssh://` spelling. */
const SSH_SCHEME = /^(?:git\+)?ssh:\/\//i

export const isSsh = (url: string): boolean => {
  if (isLocal(url)) return false
  if (SSH_SCHEME.test(url)) return true
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && SCP_LIKE.test(url)
}

/**
 * The HTTPS form of a remote, or the URL unchanged when there is none.
 *
 * Local paths and URLs that already speak HTTP are left alone.
 */
export const toHttps = (url: string): string => {
  const trimmed = url.trim()
  if (isLocal(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const scheme = SSH_SCHEME.exec(trimmed)
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length)
    const at = rest.indexOf('@')
    const withoutUser = at === -1 ? rest : rest.slice(at + 1)
    // Strip a port, which is an SSH port and means nothing over HTTPS.
    const normalised = withoutUser.replace(/^([^/]+?):\d+\//, '$1/')
    return `https://${normalised}`
  }

  const scp = SCP_LIKE.exec(trimmed)
  if (scp) {
    const [, , host, path] = scp
    return `https://${host}/${path}`
  }

  return trimmed
}

/** `https://github.com/acme/widget.git` -> `acme/widget`, for messages. */
export const describeRemote = (url: string): string =>
  url.replace(/^[a-z]+:\/\//i, '').replace(/^[^@]+@/, '').replace(/\.git$/, '')
