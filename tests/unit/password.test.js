/**
 * Unit tests for the password hashing helpers
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../../src/utils/password');

test('hashPassword returns a bcrypt hash that is not the plain password', async () => {
  const hash = await hashPassword('super-secret');

  assert.notEqual(hash, 'super-secret');
  assert.match(hash, /^\$2[aby]\$\d{2}\$/);
});

test('hashPassword is salted, the same password hashes differently every time', async () => {
  const [first, second] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);

  assert.notEqual(first, second);
});

test('verifyPassword accepts the correct password', async () => {
  const hash = await hashPassword('correct-horse');

  assert.equal(await verifyPassword('correct-horse', hash), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('correct-horse');

  assert.equal(await verifyPassword('wrong-horse', hash), false);
});

test('verifyPassword rejects garbage hashes without throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword(undefined, undefined), false);
});

test('hashPassword rejects empty input', async () => {
  await assert.rejects(() => hashPassword(''));
});
