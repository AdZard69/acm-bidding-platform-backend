/**
 * Integration tests for the auth endpoints.
 * Runs against a real postgres test database and the real express app.
 */

const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, resetDatabase, createTeam } = require('./helpers/setup');
const { app } = require('../src/server');
const { ensureAdminAccount } = require('../src/services/authService');

const TEAM_NAME = 'bit bandits';
const TEAM_PASSWORD = 'team-pass-123';
const ADMIN_PASSWORD = 'admin123';

let server;
let baseUrl;

/**
 * Small fetch wrapper returning status + parsed body
 */
const api = async (path, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed };
};

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  await ensureAdminAccount();
});

test('team login returns a token, team id and team name', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const { status, body } = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.teamName, TEAM_NAME);
  assert.equal(typeof body.teamId, 'number');
  assert.equal(typeof body.token, 'string');
});

test('team login rejects a wrong password', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const { status, body } = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: 'nope' }
  });

  assert.equal(status, 401);
  assert.equal(body.success, false);
  assert.match(body.error.message, /Incorrect password/);
});

test('team login rejects an unknown team', async () => {
  const { status } = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: 'ghost team', password: TEAM_PASSWORD }
  });

  assert.equal(status, 401);
});

test('team login rejects a deactivated team', async () => {
  const team = await createTeam(TEAM_NAME, TEAM_PASSWORD);
  await prisma.team.update({ where: { id: team.id }, data: { isActive: false } });

  const { status, body } = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  assert.equal(status, 403);
  assert.match(body.error.message, /deactivated/i);
});

test('team login requires both fields', async () => {
  const { status } = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME }
  });

  assert.equal(status, 400);
});

test('admin login returns a token with the admin role', async () => {
  const { status, body } = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.role, 'admin');
  assert.equal(typeof body.token, 'string');
});

test('admin login rejects a wrong password', async () => {
  const { status } = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'wrong' }
  });

  assert.equal(status, 401);
});

test('the bootstrap admin is only created once', async () => {
  await resetDatabase();

  const first = await ensureAdminAccount();
  const second = await ensureAdminAccount();

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
});

test('the admin password is stored hashed, never in plain text', async () => {
  const admin = await prisma.admin.findUnique({ where: { username: 'admin' } });

  assert.notEqual(admin.password, ADMIN_PASSWORD);
  assert.match(admin.password, /^\$2[aby]\$/);
});

test('GET /api/auth/me returns the team identity', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const login = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  const { status, body } = await api('/api/auth/me', { token: login.body.token });

  assert.equal(status, 200);
  assert.equal(body.role, 'team');
  assert.equal(body.teamName, TEAM_NAME);
  assert.equal(body.teamId, login.body.teamId);
});

test('GET /api/auth/me returns the admin identity', async () => {
  const login = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });

  const { status, body } = await api('/api/auth/me', { token: login.body.token });

  assert.equal(status, 200);
  assert.equal(body.role, 'admin');
  assert.equal(body.username, 'admin');
});

test('GET /api/auth/me rejects a missing token', async () => {
  const { status } = await api('/api/auth/me');

  assert.equal(status, 401);
});

test('GET /api/auth/me rejects a garbage token', async () => {
  const { status } = await api('/api/auth/me', { token: 'not-a-jwt' });

  assert.equal(status, 401);
});

test('a team token cannot be used on the admin change password route', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const login = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  const { status } = await api('/api/auth/admin/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: TEAM_PASSWORD, newPassword: 'new-admin-pass' }
  });

  assert.equal(status, 403);
});

test('an admin token cannot be used on the team change password route', async () => {
  const login = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });

  const { status } = await api('/api/auth/team/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: ADMIN_PASSWORD, newPassword: 'new-team-pass' }
  });

  assert.equal(status, 403);
});

test('a team can change its password and then log in with the new one', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const login = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  const change = await api('/api/auth/team/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: TEAM_PASSWORD, newPassword: 'brand-new-pass' }
  });

  assert.equal(change.status, 200);

  const withOld = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });
  const withNew = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: 'brand-new-pass' }
  });

  assert.equal(withOld.status, 401);
  assert.equal(withNew.status, 200);
});

test('changing a team password requires the correct current password', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const login = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  const { status, body } = await api('/api/auth/team/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: 'not-my-password', newPassword: 'brand-new-pass' }
  });

  assert.equal(status, 401);
  assert.match(body.error.message, /Current password is incorrect/);
});

test('a team cannot reuse its current password', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const login = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  const { status, body } = await api('/api/auth/team/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: TEAM_PASSWORD, newPassword: TEAM_PASSWORD }
  });

  assert.equal(status, 400);
  assert.match(body.error.message, /different/);
});

test('a short new password is rejected', async () => {
  await createTeam(TEAM_NAME, TEAM_PASSWORD);

  const login = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName: TEAM_NAME, password: TEAM_PASSWORD }
  });

  const { status } = await api('/api/auth/team/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: TEAM_PASSWORD, newPassword: 'abc' }
  });

  assert.equal(status, 400);
});

test('an admin can change its password and then log in with the new one', async () => {
  const login = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });

  const change = await api('/api/auth/admin/change-password', {
    method: 'POST',
    token: login.body.token,
    body: { currentPassword: ADMIN_PASSWORD, newPassword: 'new-admin-pass' }
  });

  assert.equal(change.status, 200);

  const withNew = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'new-admin-pass' }
  });

  assert.equal(withNew.status, 200);
});

test('logout acknowledges the request', async () => {
  const login = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });

  const { status, body } = await api('/api/auth/logout', {
    method: 'POST',
    token: login.body.token
  });

  assert.equal(status, 200);
  assert.equal(body.success, true);
});

test('logout without a token is rejected', async () => {
  const { status } = await api('/api/auth/logout', { method: 'POST' });

  assert.equal(status, 401);
});

test('unknown routes return a 404 json envelope', async () => {
  const { status, body } = await api('/api/does-not-exist');

  assert.equal(status, 404);
  assert.equal(body.success, false);
});

test('the health endpoint is public', async () => {
  const { status, body } = await api('/api/health');

  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});
