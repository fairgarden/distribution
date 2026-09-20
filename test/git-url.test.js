import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toHttps, isSsh, describeRemote } from '../dist/git-url.js'

test('rewrites scp-style urls, which are the usual copy-paste from a host', () => {
  assert.equal(toHttps('git@github.com:acme/widget.git'), 'https://github.com/acme/widget.git')
  assert.equal(toHttps('git@gitlab.com:group/sub/widget.git'), 'https://gitlab.com/group/sub/widget.git')
})

test('rewrites ssh:// urls, dropping the user and any port', () => {
  assert.equal(toHttps('ssh://git@github.com/acme/widget.git'), 'https://github.com/acme/widget.git')
  assert.equal(toHttps('ssh://git@github.com:22/acme/widget.git'), 'https://github.com/acme/widget.git')
  assert.equal(toHttps('ssh://github.com/acme/widget.git'), 'https://github.com/acme/widget.git')
})

test('leaves urls that already speak http alone', () => {
  assert.equal(toHttps('https://github.com/acme/widget.git'), 'https://github.com/acme/widget.git')
  assert.equal(toHttps('http://example.com/widget.git'), 'http://example.com/widget.git')
})

test('leaves local paths alone, since there is no host to rewrite', () => {
  assert.equal(toHttps('../widget'), '../widget')
  assert.equal(toHttps('/srv/widget'), '/srv/widget')
  assert.equal(toHttps('file:///srv/widget'), 'file:///srv/widget')
})

test('recognises which urls a keyless clone cannot use', () => {
  assert.equal(isSsh('git@github.com:acme/widget.git'), true)
  assert.equal(isSsh('ssh://git@github.com/acme/widget.git'), true)
  assert.equal(isSsh('https://github.com/acme/widget.git'), false)
  assert.equal(isSsh('../widget'), false)
  assert.equal(isSsh('/srv/widget'), false)
})

test('does not mistake a windows path for scp shorthand', () => {
  assert.equal(isSsh('C:/repos/widget'), false)
  assert.equal(toHttps('C:/repos/widget'), 'C:/repos/widget')
})

test('names a remote readably', () => {
  assert.equal(describeRemote('https://github.com/acme/widget.git'), 'github.com/acme/widget')
  assert.equal(describeRemote('git@github.com:acme/widget.git'), 'github.com:acme/widget')
})
