/**
 * Unit tests for the JWT helpers
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const env = require('../../src/config/env');
const { signToken, verifyToken, signTeamToken, signAdminToken, extractBearerToken } = require('../../src/utils/token');

test('signTeamToken carries the team claims', () => {
  const payload = verifyToken(signTeamToken({ id: 7, teamName: 'bit bandits' }));

  assert.equal(payload.role, 'team');
  assert.equal(payload.teamId, 7);
  assert.equal(payload.teamName, 'bit bandits');
  assert.equal(payload.sub, '7');
  assert.equal(payload.iss, env.JWT_ISSUER);
});

test('signAdminToken carries the admin claims', () => {
  const payload = verifyToken(signAdminToken({ id: 3, username: 'gm' }));

  assert.equal(payload.role, 'admin');
  assert.equal(payload.adminId, 3);
  assert.equal(payload.username, 'gm');
  assert.equal(payload.sub, '3');
});

test('tokens expire', () => {
  const expired = jwt.sign({ role: 'team' }, env.JWT_SECRET, {
    expiresIn: '-1s',
    issuer: env.JWT_ISSUER
  });

  assert.throws(() => verifyToken(expired), (error) => error.name === 'TokenExpiredError');
});

test('a tampered token is rejected', () => {
  const token = signToken({ role: 'admin' });
  const tampered = `${token.slice(0, -3)}abc`;

  assert.throws(() => verifyToken(tampered));
});

test('a token signed with another secret is rejected', () => {
  const foreign = jwt.sign({ role: 'admin' }, 'some-other-secret', {
    expiresIn: '1h',
    issuer: env.JWT_ISSUER
  });

  assert.throws(() => verifyToken(foreign));
});

test('extractBearerToken reads the Authorization header', () => {
  assert.equal(extractBearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(extractBearerToken({ headers: { Authorization: 'bearer abc' } }), 'abc');
});

test('extractBearerToken returns null for missing or malformed headers', () => {
  assert.equal(extractBearerToken({ headers: {} }), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'abc' } }), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'Bearer ' } }), null);
});
