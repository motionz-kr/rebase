const assert = require('node:assert/strict');

const {
  isTransientNotarytoolOutput,
  shouldSkipNotarization,
  notarytoolArgs,
} = require('./notarize-after-sign.cjs');

assert.equal(isTransientNotarytoolOutput('Error: HTTP status code: 500. Service unavailable'), true);
assert.equal(isTransientNotarytoolOutput('Error: HTTP status code: 503'), true);
assert.equal(isTransientNotarytoolOutput('Error: HTTP status code: 401. Invalid credentials'), false);
assert.equal(isTransientNotarytoolOutput('{"status":"Accepted"}'), false);

assert.equal(shouldSkipNotarization({ platform: 'darwin', enabled: '1', appPath: '/tmp/Rebase.app' }), false);
assert.equal(shouldSkipNotarization({ platform: 'darwin', enabled: '', appPath: '/tmp/Rebase.app' }), true);
assert.equal(shouldSkipNotarization({ platform: 'win32', enabled: '1', appPath: '/tmp/Rebase.app' }), true);
assert.equal(shouldSkipNotarization({ platform: 'darwin', enabled: '1', appPath: '' }), true);

assert.deepEqual(notarytoolArgs('/tmp/Rebase.zip', '/tmp/key.p8', 'KEY', 'ISSUER'), [
  'notarytool',
  'submit',
  '/tmp/Rebase.zip',
  '--key',
  '/tmp/key.p8',
  '--key-id',
  'KEY',
  '--issuer',
  'ISSUER',
  '--wait',
  '--output-format',
  'json',
]);

console.log('notarize-after-sign tests passed');
