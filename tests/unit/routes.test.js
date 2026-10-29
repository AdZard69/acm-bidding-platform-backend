process.env.NODE_ENV = 'test';
process.env.BCRYPT_SALT_ROUNDS = '4';
process.env.GAME_QUEUE_WAIT_MS = '60';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryPrisma } = require('../helpers/memoryPrisma');
const database = createMemoryPrisma();
const prismaPath = require.resolve('../../src/config/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: database };
const { app, initializeDatabase } = require('../../src/server');
const { injectHttp, registeredRoutes } = require('../helpers/injectHttp');
const { hashPassword } = require('../../src/utils/password');
const { signAdminToken, signTeamToken } = require('../../src/utils/token');
const timer = require('../../src/socket/timerManager');
const { setIO } = require('../../src/socket/emitter');
const { withGameLock } = require('../../src/services/gameLock');
const readiness = require('../../src/services/readiness');
const inventory = registeredRoutes(app);
const covered = new Map();
let adminToken;
let teamToken;
let secondToken;
let events;
const keyFor = (method, path) => inventory.find((key) => {
  const [verb, pattern] = key.split(' ');
  return method === verb && new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}/?$`).test(path.split('?')[0]);
});
const api = async (path, options = {}) => {
  const method = options.method || 'GET';
  const result = await injectHttp(app, { path, ...options });
  if (result.status >= 200 && result.status < 300) {
    const key = keyFor(method, path);
    if (key) covered.set(key, { path, ...options });
  }
  return result;
};
const admin = (path, body, method = 'POST') => api(`/api/admin${path}`, { method, body, token: adminToken });
const start = async (config = {}) => {
  if (Object.keys(config).length) assert.equal((await admin('/config', config, 'PUT')).status, 200);
  const response = await admin('/round/start', { roundNumber: 1 });
  assert.equal(response.status, 200, response.text);
  return response.body;
};
const bid = (bidMinutes, options = {}) => api('/api/bid/place', { method: 'POST', body: { bidMinutes, ...options }, token: teamToken });

beforeEach(async () => {
  timer.resetTimer();
  database.reset();
  readiness.setReadiness({ status: 'idle' });
  const password = await hashPassword('password123');
  const actor = await database.admin.create({ data: { username: 'admin', password, role: 'admin' } });
  const team = await database.team.create({ data: { teamName: 'Team Alpha', password } });
  const other = await database.team.create({ data: { teamName: 'Team Beta', password } });
  await database.prompt.create({ data: { title: 'Prompt One', description: 'Build one', displayOrder: 1 } });
  await database.prompt.create({ data: { title: 'Prompt Two', description: 'Build two', displayOrder: 2 } });
  adminToken = signAdminToken(actor);
  teamToken = signTeamToken(team);
  secondToken = signTeamToken(other);
  events = [];
  setIO({ emit: (event, data) => events.push({ event, data }), to: (room) => ({ emit: (event, data) => events.push({ room, event, data }) }) });
});
afterEach(async () => {
  // Wait for notifications/queue release after the HTTP response is sent.
  await withGameLock(() => undefined);
  timer.resetTimer();
  readiness.setReadiness({ status: 'idle' });
  setIO(null);
});

test('health, readiness, documentation, clock and synchronization routes return their documented data', async () => {
  assert.equal((await api('/api/health')).body.status, 'ok');
  assert.equal((await api('/api/health/ready')).body.status, 'ready');
  assert.match((await api('/api/docs')).text, /SwaggerUIBundle/);
  const docs = await api('/api/docs.json');
  assert.equal(docs.status, 200);
  assert.ok(docs.body.paths['/admin/bids']);
  const clock = await api('/api/clock');
  assert.equal(clock.body.bidding.status, 'waiting');
  assert.equal(clock.headers['cache-control'], 'no-store');
  assert.ok(Number(clock.headers['x-server-time']) > 0);
  for (const options of [{ path: '/api/clock/sync?t0=123' }, { path: '/api/clock/sync', method: 'POST', body: { clientTime: 123 } }]) {
    const result = await api(options.path, options);
    assert.equal(result.body.clientTime, 123);
    assert.ok(result.body.serverTransmitTime >= result.body.serverReceiveTime);
  }
  assert.equal((await api('/api/missing')).status, 404);
  assert.equal((await api('/api/auth/team/login', { method: 'POST', rawBody: '{bad json' })).status, 400);
});

test('all protected route registrations reject missing tokens and wrong roles', async () => {
  for (const key of inventory) {
    const [method, pattern] = key.split(' ');
    const teamOnly = /^\/api\/bid\/(?:place|update|my-bids|assignment)$/.test(pattern) || (pattern === '/api/bid' && ['POST', 'PUT'].includes(method));
    const adminOnly = pattern.startsWith('/api/admin/');
    const session = ['/api/auth/me', '/api/auth/logout'].includes(pattern);
    const password = pattern.endsWith('/change-password');
    if (!teamOnly && !adminOnly && !session && !password) continue;
    const path = pattern.replace(/:[^/]+/g, '1');
    assert.equal((await api(path, { method, body: method === 'GET' ? undefined : {} })).status, 401, key);
    if (!session) {
      const token = teamOnly || pattern.includes('/team/change-password') ? adminToken : teamToken;
      assert.equal((await api(path, { method, token, body: method === 'GET' ? undefined : {} })).status, 403, key);
    }
  }
});

test('login, identity and logout return valid identities and reject invalid credentials/types', async () => {
  for (const [role, name, nameKey, token] of [['team', 'Team Alpha', 'teamName', teamToken], ['admin', 'admin', 'username', adminToken]]) {
    const loggedIn = await api(`/api/auth/${role}/login`, { method: 'POST', body: { [nameKey]: ` ${name} `, password: 'password123' } });
    assert.equal(loggedIn.status, 200);
    assert.ok(loggedIn.body.token);
    assert.match(loggedIn.headers.authorization, /^Bearer /);
    assert.equal((await api('/api/auth/me', { token })).body.role, role);
    assert.equal((await api('/api/auth/logout', { method: 'POST', token })).status, 200);
    for (const body of [{}, { [nameKey]: 7, password: 'password123' }, { [nameKey]: name, password: {} }]) {
      assert.equal((await api(`/api/auth/${role}/login`, { method: 'POST', body })).status, 400);
    }
    assert.equal((await api(`/api/auth/${role}/login`, { method: 'POST', body: { [nameKey]: name, password: 'wrong' } })).status, 401);
  }
});

test('team and admin password changes verify the current password and update future logins', async () => {
  for (const [role, name, key, token] of [['team', 'Team Alpha', 'teamName', teamToken], ['admin', 'admin', 'username', adminToken]]) {
    const path = `/api/auth/${role}/change-password`;
    assert.equal((await api(path, { method: 'POST', token, body: { currentPassword: 'wrong', newPassword: 'changed123' } })).status, 401);
    assert.equal((await api(path, { method: 'POST', token, body: { currentPassword: 'password123', newPassword: 'tiny' } })).status, 400);
    assert.equal((await api(path, { method: 'POST', token, body: { currentPassword: 'password123', newPassword: 'changed123' } })).status, 200);
    const login = (password) => api(`/api/auth/${role}/login`, { method: 'POST', body: { [key]: name, password } });
    assert.equal((await login('password123')).status, 401);
    assert.equal((await login('changed123')).status, 200);
  }
});

test('team CRUD returns safe records, enforces unique names and applies updates, toggles and deletion', async () => {
  const list = await admin('/teams', undefined, 'GET');
  assert.equal(list.status, 200);
  assert.equal(list.body.teams.length, 2);
  assert.ok(list.body.teams.every((team) => !('password' in team)));
  const created = await admin('/teams', { teamName: 'Team Gamma', password: 'password123' });
  assert.equal(created.status, 201);
  const id = created.body.team.id;
  assert.equal((await admin('/teams', { teamName: 'Team Gamma', password: 'password123' })).status, 409);
  for (const body of [{ teamName: 'x', password: 'valid123' }, { teamName: 'x'.repeat(51), password: 'valid123' }, { teamName: 'Good Name', password: 'p'.repeat(73) }])
    assert.equal((await admin('/teams', body)).status, 400);
  assert.equal((await admin(`/teams/${id}`, { teamName: 'Renamed Team', password: 'newpass123', isActive: false }, 'PUT')).status, 200);
  assert.equal((await admin(`/teams/${id}`, { isActive: 'false' }, 'PUT')).status, 400);
  assert.equal((await admin(`/teams/${id}/toggle`, undefined, 'PATCH')).body.team.isActive, true);
  assert.equal((await admin('/teams/nope', { teamName: 'Name' }, 'PUT')).status, 400);
  assert.equal((await admin('/teams/999', undefined, 'DELETE')).status, 404);
  assert.equal((await admin(`/teams/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await admin('/teams', undefined, 'GET')).body.teams.length, 2);
});

test('prompt CRUD validates content and display order and persists edits and deletion', async () => {
  assert.equal((await admin('/prompts', undefined, 'GET')).body.prompts.length, 2);
  const created = await admin('/prompts', { title: 'Third Prompt', description: 'Build three' });
  assert.equal(created.status, 201);
  assert.equal(created.body.prompt.displayOrder, 3);
  const id = created.body.prompt.id;
  assert.equal((await admin(`/prompts/${id}`, { title: 'Updated Prompt', description: 'Updated text', displayOrder: 4 }, 'PUT')).status, 200);
  assert.equal((await admin('/prompts', { title: 'Missing text' })).status, 400);
  assert.equal((await admin('/prompts', { title: 'Invalid order', description: 'Description', displayOrder: true })).status, 400);
  assert.equal((await admin(`/prompts/${id}`, { title: null, description: 'Text' }, 'PUT')).status, 400);
  assert.equal((await admin(`/prompts/${id}`, { title: 'Title', description: null }, 'PUT')).status, 400);
  assert.equal((await admin('/prompts/999', {}, 'PUT')).status, 404);
  assert.equal((await admin('/prompts/nope', undefined, 'DELETE')).status, 400);
  assert.equal((await admin(`/prompts/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await admin('/prompts', undefined, 'GET')).body.prompts.length, 2);
});

test('configuration stores each setting and rejects invalid types, bounds and incompatible values', async () => {
  assert.equal((await admin('/config', undefined, 'GET')).body.config.baseTime, 120);
  const changed = await admin('/config', { baseTime: 100, minBid: 20, maxTeams: 12, slotsPerPrompt: 2, bidDurationSeconds: 45 }, 'PUT');
  assert.equal(changed.status, 200);
  assert.equal(changed.body.config.bidDurationSeconds, 45);
  for (const body of [{}, { baseTime: true }, { baseTime: null }, { minBid: 101 }, { maxTeams: 51 }, { slotsPerPrompt: 0 }, { bidDurationSeconds: 9 }, { baseTime: 2147483648 }]) {
    assert.equal((await admin('/config', body, 'PUT')).status, 400, JSON.stringify(body));
  }
});

test('round controls start, pause, extend, resume and advance one shared timer with stale-session guards', async () => {
  const initial = await start({ slotsPerPrompt: 1 });
  assert.equal(initial.currentPrompt.id, 1);
  assert.equal((await admin('/round/start', {})).status, 400);
  assert.equal((await admin('/round/pause', { timerId: initial.timerId })).body.status, 'paused');
  assert.equal((await bid(45)).status, 400);
  const extend = await admin('/round/extend', { extraSeconds: 15, timerId: initial.timerId });
  assert.equal(extend.status, 200);
  assert.equal(extend.body.durationSeconds, 75);
  assert.ok(extend.body.remainingMs > 74000);
  assert.equal((await admin('/round/extend', { extraSeconds: 10, timerId: 'old' })).status, 409);
  assert.equal((await admin('/round/extend', { extraSeconds: true })).status, 400);
  const resumed = await admin('/round/resume', { timerId: initial.timerId });
  assert.equal(resumed.body.timerId, initial.timerId);
  assert.equal(resumed.body.status, 'bidding');
  assert.equal((await admin('/config', { baseTime: 200 }, 'PUT')).status, 400);
  assert.equal((await admin('/prompts', { title: 'New', description: 'Text' })).status, 400);
  assert.equal((await admin('/prompts/1', { title: 'Changed' }, 'PUT')).status, 400);
  assert.equal((await admin('/prompts/1', undefined, 'DELETE')).status, 400);
  const next = await admin('/round/next-prompt', { timerId: initial.timerId });
  assert.equal(next.body.currentPrompt.id, 2);
  assert.notEqual(next.body.timerId, initial.timerId);
  assert.equal((await admin('/round/next-prompt', { timerId: initial.timerId })).status, 409);
  assert.equal((await admin('/round/end', { timerId: next.body.timerId })).body.status, 'round_ended');
  const state = await api('/api/bid/current');
  assert.ok(state.body.timerId);
  assert.equal(state.body.currentRound, 2);
  assert.equal(state.body.currentPrompt.id, 2);
  assert.equal(state.body.secondsRemaining, 0);
});

test('every bid route alias places or updates one record and enforces collisions, ranges and deadlines', async () => {
  const state = await start();
  const input = { promptId: 1, round: 1, timerId: state.timerId };
  assert.equal((await bid(60, input)).status, 200);
  assert.equal((await api('/api/bid/place', { method: 'POST', body: { bidMinutes: 60, ...input }, token: secondToken })).status, 409);
  assert.equal((await api('/api/bid/update', { method: 'PUT', body: { bidMinutes: 55, ...input }, token: teamToken })).status, 200);
  assert.equal((await api('/api/bid', { method: 'POST', body: { bidMinutes: 50, ...input }, token: teamToken })).status, 200);
  assert.equal((await api('/api/bid', { method: 'PUT', body: { bidMinutes: 45, ...input }, token: teamToken })).status, 200);
  assert.equal(database.tables.bids.length, 1);
  for (const value of [29, 121, null, false, [], '']) assert.equal((await bid(value, input)).status, 400);
  assert.equal((await bid(40, { ...input, round: 2 })).status, 409);
  const current = await api('/api/bid/current');
  assert.equal(current.body.bids[0].bidMinutes, 45);
  assert.equal((await api('/api/bid/my-bids', { token: teamToken })).body.bids.length, 1);
  assert.equal((await api('/api/bid/assignment', { token: teamToken })).body.assignment, null);
  assert.equal((await admin('/bids', undefined, 'GET')).body.bids[0].teamName, 'Team Alpha');
  timer.endsAt = Date.now() - 10;
  assert.equal((await bid(40, input)).status, 400);
  assert.equal(database.tables.bids[0].bidMinutes, 45);
});

test('winner assignment, score submission/override and both leaderboards return consistent numeric results', async () => {
  await start({ slotsPerPrompt: 1 });
  await bid(45);
  assert.equal((await admin('/scores/2', { judgeScore: 80 })).status, 400);
  assert.equal((await admin('/scores/999', { judgeScore: 80 })).status, 404);
  await admin('/round/next-prompt', {});
  assert.equal((await bid(40)).status, 400);
  const assignment = await api('/api/bid/assignment', { token: teamToken });
  assert.equal(assignment.body.assignment.promptId, 1);
  assert.equal(typeof assignment.body.assignment.multiplier, 'number');
  const scored = await admin('/scores/1', { judgeScore: 80 });
  assert.equal(scored.status, 200);
  assert.equal(scored.body.score.finalScore, Math.round(80 * assignment.body.assignment.multiplier * 1000) / 1000);
  for (const score of [-1, 101, 3.5, false, null]) assert.equal((await admin('/scores/1', { judgeScore: score })).status, 400);
  assert.equal((await admin('/scores/1', { judgeScore: 0 })).body.score.finalScore, 0);
  const adminBoard = await admin('/leaderboard', undefined, 'GET');
  const publicBoard = await api('/api/bid/leaderboard');
  assert.deepEqual(publicBoard.body.leaderboard, adminBoard.body.leaderboard);
  assert.equal(publicBoard.body.leaderboard[0].finalScore, 0);
  assert.equal((await api('/api/bid/assignment', { token: teamToken })).body.score.judgeScore, 0);
  assert.ok(events.some((event) => event.event === 'score:received' && event.room === 'team:1'));
});

test('deleting an awarded prompt removes dependent bids, assignments and scores without damaging other prompts', async () => {
  await start();
  await bid(45);
  await admin('/round/end', {});
  await admin('/scores/1', { judgeScore: 80 });
  await database.assignment.create({ data: { teamId: 2, promptId: 2, bidMinutes: 60, round: 1, multiplier: 1.649 } });
  await admin('/scores/2', { judgeScore: 90 });
  assert.equal((await admin('/prompts/1', undefined, 'DELETE')).status, 400);
  await admin('/round/next-prompt', {});
  await admin('/round/end', {});
  assert.equal((await admin('/prompts/1', undefined, 'DELETE')).status, 200);
  assert.equal(database.tables.bids.length, 0);
  assert.equal(database.tables.assignments.length, 1);
  assert.equal(database.tables.assignments[0].teamId, 2);
  assert.equal(database.tables.scores.length, 1);
  assert.equal(database.tables.scores[0].teamId, 2);
  assert.equal(database.tables.prompts.length, 1);
});

test('reset validates destructive flags and atomically clears state with each supported wipe option', async () => {
  await start();
  await bid(45);
  assert.equal((await admin('/reset', { wipeAll: 'false' })).status, 400);
  assert.equal(database.tables.bids.length, 1);
  assert.equal(timer.isRunning(), true);
  assert.equal((await admin('/reset', {})).body.status, 'waiting');
  assert.equal(database.tables.bids.length, 0);
  assert.equal(database.tables.teams.length, 2);
  assert.equal(database.tables.prompts.length, 2);
  assert.equal((await admin('/reset', { wipeTeams: true })).status, 200);
  assert.equal(database.tables.teams.length, 0);
  assert.equal((await admin('/reset', { wipePrompts: true })).status, 200);
  assert.equal(database.tables.prompts.length, 0);
  assert.equal((await admin('/reset', { wipeAll: true })).status, 200);
  assert.ok(events.some((event) => event.event === 'game:reset'));
});

test('a score request receives a bounded 503 when the game queue is occupied and never executes later', async () => {
  let release;
  const held = withGameLock(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  try {
    const response = await admin('/scores/1', { judgeScore: 80 });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'GAME_BUSY');
    assert.equal((await api('/api/health')).status, 200);
    assert.equal((await api('/api/docs.json')).status, 200);
  } finally { release(); await held; }
  await withGameLock(() => undefined);
  assert.equal(database.tables.scores.length, 0);
});

test('simultaneous state refreshes share one read and never rewrite the configuration row', async () => {
  await admin('/config', undefined, 'GET');
  let reads = 0;
  let writes = 0;
  database.onQuery = async ({ model, action }) => {
    if (model !== 'config') return;
    if (action === 'findUnique') { reads++; await new Promise((resolve) => setTimeout(resolve, 5)); }
    else writes++;
  };
  const responses = await Promise.all(Array.from({ length: 20 }, () => api('/api/bid/current')));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test('a failed score audit rolls back the score and a failed reset leaves the active game intact', async () => {
  await start();
  await bid(45);
  await admin('/round/end', {});
  database.onQuery = ({ model, action }) => {
    if (model === 'logs' && action === 'create') throw Object.assign(new Error('audit timeout'), { code: 'P1008' });
  };
  assert.equal((await admin('/scores/1', { judgeScore: 80 })).status, 503);
  assert.equal(database.tables.scores.length, 0);
  database.onQuery = null;
  await admin('/reset', {});
  await start();
  await bid(45);
  database.onQuery = ({ model, action }) => {
    if (model === 'config' && action === 'updateMany') throw Object.assign(new Error('reset timeout'), { code: 'P1008' });
  };
  assert.equal((await admin('/reset', { wipeAll: true })).status, 503);
  assert.equal(database.tables.bids.length, 1);
  assert.equal(database.tables.teams.length, 2);
  assert.equal(timer.isRunning(), true);
  database.onQuery = null;
});

test('every registered route has been exercised successfully through the real HTTP parser and Express middleware', (t) => {
  const missing = inventory.filter((key) => !covered.has(key));
  assert.deepEqual(missing, [], `Missing successful route checks: ${missing.join(', ')}`);
  assert.ok(inventory.length >= 35);
  t.diagnostic(`${covered.size}/${inventory.length} HTTP method/path registrations passed`);
});

test('database timeouts return sanitized 503 responses on every database-dependent route and the queue recovers', async () => {
  const independent = new Set(['/api/health', '/api/docs', '/api/docs.json', '/api/auth/me', '/api/auth/logout', '/api/clock/sync']);
  const fault = Object.assign(new Error('Operation timed out with private database details'), { code: 'P1008' });
  database.onQuery = () => { throw fault; };
  for (const [key, example] of covered) {
    if (independent.has(example.path.split('?')[0])) continue;
    const response = await api(example.path, example);
    assert.equal(response.status, 503, key + ': ' + response.text);
    assert.equal(response.body.error.code, 'P1008', key);
    assert.equal(response.headers['retry-after'], '3');
    assert.ok(!response.text.includes('private database details'));
  }
  assert.equal((await api('/api/health')).status, 200);
  assert.equal((await api('/api/clock/sync')).status, 200);
  database.onQuery = null;
  assert.equal((await admin('/teams', undefined, 'GET')).status, 200);
});

test('startup exposes readiness failure, rejects database requests promptly, and recovers after connectivity returns', async () => {
  database.onQuery = () => { throw Object.assign(new Error('unreachable'), { code: 'P1001' }); };
  assert.equal(await initializeDatabase(), false);
  assert.equal((await api('/api/health')).status, 200);
  assert.equal((await api('/api/health/ready')).status, 503);
  assert.equal((await admin('/teams', undefined, 'GET')).status, 503);
  database.onQuery = null;
  assert.equal(await initializeDatabase(), true);
  assert.equal((await api('/api/health/ready')).status, 200);
  assert.equal((await admin('/teams', undefined, 'GET')).status, 200);
});


test('socket bid and admin actions acknowledge database failures with the same sanitized error as HTTP', async () => {
  database.onQuery = () => { throw Object.assign(new Error('private database details'), { code: 'P1008' }); };
  for (const [modulePath, event, user, payload] of [
    ['../../src/socket/bidHandler', 'bid:place', { teamId: 1 }, { bidMinutes: 45 }],
    ['../../src/socket/adminHandler', 'admin:start-round', { adminId: 1 }, { roundNumber: 1 }]
  ]) {
    const handlers = new Map();
    require(modulePath)(null, { user, on: (key, handler) => handlers.set(key, handler) });
    const response = await new Promise((resolve) => handlers.get(event)(payload, resolve));
    assert.equal(response.success, false);
    assert.equal(response.error.code, 'P1008');
    assert.ok(!response.error.message.includes('private'));
  }
});


test('HTTP manual progression increments the round and returns only the requested round history', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = await start({ slotsPerPrompt: 1 });
  await bid(40);
  await api('/api/bid/place', { method: 'POST', body: { bidMinutes: 45 }, token: secondToken });
  timer.endsAt = Date.now() - 1;
  t.mock.timers.tick(100);
  await Promise.resolve();
  const closed = await api('/api/bid/current');
  assert.equal(closed.body.status, 'round_ended');
  assert.equal(closed.body.currentRound, 1);
  assert.equal(closed.body.currentPrompt.id, 1);
  assert.equal(closed.body.bids.length, 2);
  assert.equal(events.filter((event) => event.event === 'prompt:next').length, 0);
  const next = await admin('/round/next-prompt', { timerId: first.timerId });
  assert.equal(next.status, 200);
  assert.equal(next.body.currentRound, 2);
  assert.equal(next.body.currentPrompt.id, 2);
  await api('/api/bid/place', { method: 'POST', body: { bidMinutes: 50, round: 2, promptId: 2, timerId: next.body.timerId }, token: secondToken });
  const firstHistory = await api('/api/admin/bids?round=1', { token: adminToken });
  const secondHistory = await api('/api/admin/bids?round=2', { token: adminToken });
  assert.equal(firstHistory.body.bids.length, 2);
  assert.equal(secondHistory.body.bids.length, 1);
  assert.ok(secondHistory.body.bids.every((entry) => entry.round === 2 && entry.promptId === 2));
  assert.equal((await api('/api/admin/bids?round=bad', { token: adminToken })).status, 400);
});
