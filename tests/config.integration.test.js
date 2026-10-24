/**
 * Integration tests for:
 * GET /api/admin/config
 * PUT /api/admin/config
 */

const { before, after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, resetDatabase, createTeam } = require('./helpers/setup');
const { app } = require('../src/server');
const { ensureAdminAccount } = require('../src/services/authService');
const timerManager = require('../src/socket/timerManager');
const GAME_STATUS = require('../src/constants/gameStatus');

const ADMIN_PASSWORD = 'admin123';

let server;
let baseUrl;

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

const getAdminToken = async () => {
  const res = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });
  return res.body.token;
};

const getTeamToken = async (teamName, password = 'password123') => {
  await createTeam(teamName, password);
  const res = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName, password }
  });
  return res.body.token;
};

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  timerManager.resetTimer();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

beforeEach(async () => {
  timerManager.resetTimer();
  await resetDatabase();
  await ensureAdminAccount();
});

describe('GET /api/admin/config', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/config');
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/config', { token: teamToken });
    assert.equal(res.status, 403);
  });

  it('returns default config when database table is fresh', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/config', { token: adminToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.config.baseTime, 120);
    assert.equal(res.body.config.minBid, 30);
    assert.equal(res.body.config.maxTeams, 10);
    assert.equal(res.body.config.slotsPerPrompt, 3);
    assert.equal(res.body.config.bidDurationSeconds, 60);
    assert.equal(res.body.config.status, GAME_STATUS.WAITING);
  });

  it('returns existing config from database', async () => {
    const adminToken = await getAdminToken();
    await prisma.gameConfig.create({
      data: {
        baseTime: 100,
        minBid: 25,
        maxTeams: 8,
        slotsPerPrompt: 2,
        bidDurationSeconds: 45,
        status: GAME_STATUS.ROUND_ENDED
      }
    });

    const res = await api('/api/admin/config', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.config.baseTime, 100);
    assert.equal(res.body.config.minBid, 25);
    assert.equal(res.body.config.maxTeams, 8);
    assert.equal(res.body.config.slotsPerPrompt, 2);
    assert.equal(res.body.config.bidDurationSeconds, 45);
  });
});

describe('PUT /api/admin/config', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/config', {
      method: 'PUT',
      body: { baseTime: 100 }
    });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/config', {
      method: 'PUT',
      token: teamToken,
      body: { baseTime: 100 }
    });
    assert.equal(res.status, 403);
  });

  it('rejects empty payload when nothing is provided to update', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: {}
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /nothing to update/i);
  });

  it('rejects invalid config values', async () => {
    const adminToken = await getAdminToken();

    // Invalid baseTime
    let res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { baseTime: -10 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /baseTime/i);

    // Invalid minBid
    res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { minBid: 0 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /minBid/i);

    // Invalid maxTeams
    res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { maxTeams: 100 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /maxTeams/i);

    // Invalid slotsPerPrompt
    res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { slotsPerPrompt: 0 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /slotsPerPrompt/i);

    // Invalid bidDurationSeconds (< 10)
    res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { bidDurationSeconds: 5 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /bidDurationSeconds/i);
  });

  it('rejects when minBid exceeds baseTime', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { baseTime: 50, minBid: 60 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /minBid cannot be greater than baseTime/i);
  });

  it('rejects updating settings when a round is in progress', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team Alpha', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    // Start round
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Try to update config while bidding
    const res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: { baseTime: 90 }
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /round is in progress/i);
  });

  it('successfully updates game configuration', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/config', {
      method: 'PUT',
      token: adminToken,
      body: {
        baseTime: 100,
        minBid: 25,
        maxTeams: 12,
        slotsPerPrompt: 4,
        bidDurationSeconds: 45
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.config.baseTime, 100);
    assert.equal(res.body.config.minBid, 25);
    assert.equal(res.body.config.maxTeams, 12);
    assert.equal(res.body.config.slotsPerPrompt, 4);
    assert.equal(res.body.config.bidDurationSeconds, 45);

    // Verify DB
    const dbConfig = await prisma.gameConfig.findFirst();
    assert.equal(dbConfig.baseTime, 100);
    assert.equal(dbConfig.minBid, 25);
    assert.equal(dbConfig.maxTeams, 12);
    assert.equal(dbConfig.slotsPerPrompt, 4);
    assert.equal(dbConfig.bidDurationSeconds, 45);

    // Verify AdminLog
    const log = await prisma.adminLog.findFirst({ where: { action: 'CONFIG_UPDATE' } });
    assert.ok(log);
  });
});
