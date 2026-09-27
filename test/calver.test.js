import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertCalendarVersion,
  firstRelease,
  isFromPastMonth,
  nextCalendarVersion,
  npmVersion,
  parseCalendarVersion,
} from '../dist/calver.js'

const september = new Date('2026-09-15T12:00:00Z')
const october = new Date('2026-10-01T00:30:00Z')
const next = (current, options) => nextCalendarVersion(current, { on: september, published: true, ...options })

test('a version is the year, the month and the release of the month, with a stage until stable', () => {
  assert.deepEqual(parseCalendarVersion('26.09.01-alpha.0'), {
    year: 26,
    month: 9,
    release: 1,
    prerelease: { id: 'alpha', number: 0 },
  })
  assert.equal(parseCalendarVersion('26.09.02').prerelease, undefined)
  for (const wrong of ['2026.9.27', '26.9.1', '26.13.01', '26.09.00', '26.09.01-alpha']) {
    assert.equal(parseCalendarVersion(wrong), undefined, wrong)
  }
  assert.throws(() => assertCalendarVersion('2026.9.27'), /YY\.MM\.NN/)
})

test('npm spells it without the zeros, and sorts it the same', () => {
  assert.equal(npmVersion('26.09.01-alpha.0'), '26.9.1-alpha.0')
  assert.equal(npmVersion('26.10.02'), '26.10.2')
})

test("a new distribution starts at this month's first release, in alpha", () => {
  assert.equal(firstRelease(september), '26.09.01-alpha.0')
  assert.equal(firstRelease(new Date('2027-01-03T00:00:00Z'), false), '27.01.01')
})

test('a published prerelease moves on to the next attempt at the same stage', () => {
  assert.equal(next('26.09.01-alpha.0'), '26.09.01-alpha.1')
  assert.equal(next('26.09.01-beta.3'), '26.09.01-beta.4')
})

test('a release moves forward through its stages, then to stable', () => {
  assert.equal(next('26.09.01-alpha.4', { id: 'beta' }), '26.09.01-beta.0')
  assert.equal(next('26.09.01-beta.1', { id: 'rc' }), '26.09.01-rc.0')
  assert.equal(next('26.09.01-rc.0', { stable: true }), '26.09.01')
  assert.throws(() => next('26.09.01-beta.0', { id: 'alpha' }), /past alpha/)
})

test("after a stable release comes the month's next one, which may start in a stage", () => {
  assert.equal(next('26.09.01'), '26.09.02')
  assert.equal(next('26.09.01', { id: 'alpha' }), '26.09.02-alpha.0')
})

test('a new month starts again at its first release, the stage counter at zero', () => {
  assert.equal(next('26.09.01-alpha.7', { on: october }), '26.10.01-alpha.0')
  assert.equal(next('26.09.03', { on: october }), '26.10.01')
  assert.equal(next('26.09.01-beta.2', { on: october, stable: true }), '26.10.01')
  assert.equal(next('26.12.02-alpha.1', { on: new Date('2027-01-05T00:00:00Z') }), '27.01.01-alpha.0')
  // whether or not it was ever published
  assert.equal(next('26.09.01-alpha.1', { on: october, published: false }), '26.10.01-alpha.0')
})

test('one not published yet stays what it is, unless a stage is asked for', () => {
  assert.equal(next('26.09.01-alpha.1', { published: false }), '26.09.01-alpha.1')
  assert.equal(next('26.09.01-alpha.1', { published: false, id: 'beta' }), '26.09.01-beta.0')
  assert.equal(next('26.09.02', { published: false, id: 'alpha' }), '26.09.02-alpha.0')
})

test('a version of a month still to come cannot be moved on from', () => {
  assert.throws(() => next('26.11.01-alpha.0'), /still to come/)
  assert.equal(isFromPastMonth('26.09.01-alpha.0', october), true)
  assert.equal(isFromPastMonth('26.10.01-alpha.0', october), false)
})
