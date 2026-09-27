import semver from 'semver'

/**
 * A distribution's version: `YY.MM.NN`, and a prerelease stage on the way.
 *
 * `26.09.01-alpha.0` is the first release of September 2026, at its first
 * alpha. A release goes through its stages — alpha, beta, then stable — and the
 * next release that month is `26.09.02`. The month is when it is published, so
 * a new month starts again at `.01`, stage counter at 0, whatever was
 * unfinished before: a distribution still in alpha publishes `alpha.0`,
 * `alpha.1`, … until the month turns.
 *
 * End users read the month: `26.03` against `26.09` says six months, where
 * `1.1.1` against `1.2.1` says nothing. The day is not in it — it says nothing
 * a reader needs — and neither is `20`.
 *
 * npm takes semver only, which allows no leading zeros, so the registry spells
 * it `26.9.1-alpha.0`: the same version, which sorts the same way. The
 * distribution — its manifest, its tags — keeps the padded form.
 */
export interface CalendarVersion {
  /** Two digits: 26 for 2026. */
  year: number
  month: number
  /** Which release of the month, from 1. */
  release: number
  /** The stage it is at, until it is stable. */
  prerelease: { id: string; number: number } | undefined
}

const PATTERN = /^(\d{2})\.(\d{2})\.(\d{2,})(?:-([a-z]+)\.(\d+))?$/

export const parseCalendarVersion = (version: string): CalendarVersion | undefined => {
  const match = PATTERN.exec(version)
  if (!match) return undefined
  const [, year, month, release, id, number] = match
  const parsed = {
    year: Number(year),
    month: Number(month),
    release: Number(release),
    prerelease: id ? { id, number: Number(number) } : undefined,
  }
  if (parsed.month < 1 || parsed.month > 12 || parsed.release < 1) return undefined
  return parsed
}

const pad = (value: number): string => String(value).padStart(2, '0')

export const formatCalendarVersion = (version: CalendarVersion): string =>
  `${pad(version.year)}.${pad(version.month)}.${pad(version.release)}` +
  (version.prerelease ? `-${version.prerelease.id}.${version.prerelease.number}` : '')

/** Throw unless `version` is a distribution's; the message says what one looks like. */
export const assertCalendarVersion = (version: string): CalendarVersion => {
  const parsed = parseCalendarVersion(version)
  if (!parsed) {
    throw new Error(
      `${version} is not a distribution version. One is YY.MM.NN — the year, the month, ` +
        'and which release of the month — with a stage until it is stable: 26.09.01-alpha.0.'
    )
  }
  return parsed
}

/** How npm spells it: the same version, without the zeros semver does not allow. */
export const npmVersion = (version: string): string => {
  const cleaned = semver.clean(version, { loose: true })
  if (!cleaned) throw new Error(`${version} is not a version npm can publish.`)
  return cleaned
}

/** The year and month a release is published in, which the version names. UTC, as CI is. */
export const monthOf = (on: Date = new Date()): { year: number; month: number } => ({
  year: on.getUTCFullYear() % 100,
  month: on.getUTCMonth() + 1,
})

/** The first release of the month: `26.09.01-alpha.0`, or with `false`, stable. */
export const firstRelease = (on: Date = new Date(), id: string | false = 'alpha'): string =>
  formatCalendarVersion({ ...monthOf(on), release: 1, prerelease: id ? { id, number: 0 } : undefined })

export interface NextOptions {
  /** Whether `current` has been published already. */
  published: boolean
  on?: Date
  /** Move to this stage — alpha, beta, rc. */
  id?: string
  /** Leave the prerelease stages: this release is stable. */
  stable?: boolean
}

const compareStages = (a: string, b: string): number =>
  semver.compare(`1.0.0-${a}.0`, `1.0.0-${b}.0`)

/**
 * The version a distribution publishes next.
 *
 * Published, it moves on: the next attempt at the same stage, the next stage
 * when one is asked for, stable with `stable`, or — once stable — the month's
 * next release. Not yet published, it stays what it is, unless a stage is
 * asked for. Either way, a version from a month already over becomes this
 * month's first release, at the stage it was at or the one asked for.
 */
export const nextCalendarVersion = (current: string, options: NextOptions): string => {
  const version = assertCalendarVersion(current)
  const { published, id, stable = false } = options
  const now = monthOf(options.on)
  if (id && stable) throw new Error('Ask for a stage or for stable, not both.')

  const newMonth =
    now.year > version.year || (now.year === version.year && now.month > version.month)
  if (!newMonth && (now.year !== version.year || now.month !== version.month)) {
    throw new Error(`${current} is in a month still to come; it cannot be moved on from yet.`)
  }

  const stageAfter = stable ? undefined : (id ?? version.prerelease?.id)
  if (newMonth) {
    return formatCalendarVersion({
      ...now,
      release: 1,
      prerelease: stageAfter ? { id: stageAfter, number: 0 } : undefined,
    })
  }

  const same = { ...version }
  const pre = version.prerelease

  // Moving to another stage of the same release: only ever forward.
  const toStage = (next: string): string => {
    if (pre && compareStages(next, pre.id) < 0) {
      throw new Error(`${current} is at ${pre.id} already, which is past ${next}.`)
    }
    if (!pre && !published) {
      // An unpublished stable release can still be taken back to a stage.
      return formatCalendarVersion({ ...same, prerelease: { id: next, number: 0 } })
    }
    if (!pre) {
      return formatCalendarVersion({ ...same, release: same.release + 1, prerelease: { id: next, number: 0 } })
    }
    return formatCalendarVersion({ ...same, prerelease: { id: next, number: 0 } })
  }

  if (!published) {
    if (stable) return formatCalendarVersion({ ...same, prerelease: undefined })
    if (id && id !== pre?.id) return toStage(id)
    return current
  }

  if (stable) {
    if (!pre) return formatCalendarVersion({ ...same, release: same.release + 1 })
    return formatCalendarVersion({ ...same, prerelease: undefined })
  }
  if (id && id !== pre?.id) return toStage(id)
  if (pre) return formatCalendarVersion({ ...same, prerelease: { id: pre.id, number: pre.number + 1 } })
  // Stable, and published: the month's next release.
  return formatCalendarVersion({ ...same, release: same.release + 1 })
}

/** Whether `version` names a month before the one it is now. */
export const isFromPastMonth = (version: string, on: Date = new Date()): boolean => {
  const parsed = parseCalendarVersion(version)
  if (!parsed) return false
  const now = monthOf(on)
  return now.year > parsed.year || (now.year === parsed.year && now.month > parsed.month)
}
