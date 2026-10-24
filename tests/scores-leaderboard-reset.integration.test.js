/**
 * Integration tests for:
 * POST /api/admin/scores/:teamId
 * GET  /api/admin/leaderboard
 * POST /api/admin/reset
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

describe('POST /api/admin/scores/:teamId', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/scores/1', {
      method: 'POST',
      body: { judgeScore: 85 }
    });
    assert.equal(res.status, 401);
  });

  it('rejects with team token (forbidden)', async () => {
    const teamToken = await getTeamToken('Team 1');
    const res = await api('/api/admin/scores/1', {
      method: 'POST',
      token: teamToken,
      body: { judgeScore: 85 }
    });
    assert.equal(res.status, 403);
  });

  it('rejects invalid teamId', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/scores/abc', {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 85 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /invalid team id/i);
  });

  it('rejects non-existent teamId', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/scores/9999', {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 85 }
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /team not found/i);
  });

  it('rejects when team has no assignment', async () => {
    const adminToken = await getAdminToken();
    const team = await createTeam('Unassigned Team', 'pass123');

    const res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 85 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not been assigned a prompt/i);
  });

  it('rejects missing or invalid judge score', async () => {
    const adminToken = await getAdminToken();
    const team = await createTeam('Team With Prompt', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });
    await prisma.assignment.create({
      data: {
        teamId: team.id,
        promptId: prompt.id,
        bidMinutes: 60,
        round: 1,
        multiplier: 1.649
      }
    });

    // Missing
    let res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: {}
    });
    assert.equal(res.status, 400);

    // Negative
    res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: -5 }
    });
    assert.equal(res.status, 400);

    // Over 100
    res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 105 }
    });
    assert.equal(res.status, 400);

    // Non-integer
    res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 85.5 }
    });
    assert.equal(res.status, 400);

    // Non-numeric
    res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 'bad' }
    });
    assert.equal(res.status, 400);
  });

  it('successfully submits judge score and calculates final score', async () => {
    const adminToken = await getAdminToken();
    const team = await createTeam('Scored Team', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });
    await prisma.assignment.create({
      data: {
        teamId: team.id,
        promptId: prompt.id,
        bidMinutes: 50,
        round: 1,
        multiplier: 1.792
      }
    });

    // Judge gives 80
    // Expected final score = 80 * 1.792 = 143.36
    const res = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 80 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.score.teamId, team.id);
    assert.equal(res.body.score.judgeScore, 80);
    assert.equal(res.body.score.multiplier, 1.792);
    assert.equal(res.body.score.finalScore, 143.36);

    // Check DB record
    const dbScore = await prisma.score.findUnique({ where: { teamId: team.id } });
    assert.ok(dbScore);
    assert.equal(dbScore.judgeScore, 80);
    assert.equal(Number(dbScore.finalScore), 143.36);

    // Check AdminLog
    const log = await prisma.adminLog.findFirst({ where: { action: 'SUBMIT_SCORE' } });
    assert.ok(log);
  });

  it('successfully updates an existing judge score', async () => {
    const adminToken = await getAdminToken();
    const team = await createTeam('Rescored Team', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });
    await prisma.assignment.create({
      data: {
        teamId: team.id,
        promptId: prompt.id,
        bidMinutes: 50,
        round: 1,
        multiplier: 1.792
      }
    });

    // Initial score 70
    await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 70 }
    });

    // Updated score 90
    // Final score = 90 * 1.792 = 161.28
    const updateRes = await api(`/api/admin/scores/${team.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 90 }
    });

    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.success, true);
    assert.equal(updateRes.body.score.judgeScore, 90);
    assert.equal(updateRes.body.score.finalScore, 161.28);

    const log = await prisma.adminLog.findFirst({ where: { action: 'SCORE_OVERRIDE' } });
    assert.ok(log);
  });
});

describe('GET /api/admin/leaderboard', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/leaderboard');
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team 1');
    const res = await api('/api/admin/leaderboard', { token: teamToken });
    assert.equal(res.status, 403);
  });

  it('returns empty leaderboard when no teams exist', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/leaderboard', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.leaderboard, []);
  });

  it('correctly ranks teams by final score descending and lists unscored teams', async () => {
    const adminToken = await getAdminToken();
    const teamA = await createTeam('Team A', 'pass123');
    const teamB = await createTeam('Team B', 'pass123');
    const teamC = await createTeam('Team C', 'pass123');

    const prompt1 = await prisma.prompt.create({
      data: { title: 'Prompt Alpha', description: 'Desc A', displayOrder: 1 }
    });

    // Team A bids 50 mins -> multiplier 1.792, judge score 70 -> final 125.44
    await prisma.assignment.create({
      data: { teamId: teamA.id, promptId: prompt1.id, bidMinutes: 50, round: 1, multiplier: 1.792 }
    });
    await api(`/api/admin/scores/${teamA.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 70 }
    });

    // Team B bids 110 mins -> multiplier 1.087, judge score 90 -> final 97.83
    await prisma.assignment.create({
      data: { teamId: teamB.id, promptId: prompt1.id, bidMinutes: 110, round: 1, multiplier: 1.087 }
    });
    await api(`/api/admin/scores/${teamB.id}`, {
      method: 'POST',
      token: adminToken,
      body: { judgeScore: 90 }
    });

    // Team C has assignment but not scored yet
    await prisma.assignment.create({
      data: { teamId: teamC.id, promptId: prompt1.id, bidMinutes: 60, round: 1, multiplier: 1.649 }
    });

    const res = await api('/api/admin/leaderboard', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.leaderboard.length, 3);

    // Rank 1: Team A (125.44)
    assert.equal(res.body.leaderboard[0].rank, 1);
    assert.equal(res.body.leaderboard[0].teamId, teamA.id);
    assert.equal(res.body.leaderboard[0].finalScore, 125.44);
    assert.equal(res.body.leaderboard[0].prompt.title, 'Prompt Alpha');

    // Rank 2: Team B (97.83)
    assert.equal(res.body.leaderboard[1].rank, 2);
    assert.equal(res.body.leaderboard[1].teamId, teamB.id);
    assert.equal(res.body.leaderboard[1].finalScore, 97.83);

    // Rank 3: Team C (unscored)
    assert.equal(res.body.leaderboard[2].rank, 3);
    assert.equal(res.body.leaderboard[2].teamId, teamC.id);
    assert.equal(res.body.leaderboard[2].judgeScore, null);
    assert.equal(res.body.leaderboard[2].finalScore, null);
  });
});

describe('POST /api/admin/reset', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/reset', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team 1');
    const res = await api('/api/admin/reset', { method: 'POST', token: teamToken });
    assert.equal(res.status, 403);
  });

  it('resets game state and clears bids, assignments, scores while preserving teams/prompts', async () => {
    const adminToken = await getAdminToken();
    const team = await createTeam('Team 1', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });

    await prisma.bid.create({
      data: { teamId: team.id, promptId: prompt.id, bidMinutes: 45, round: 1 }
    });
    await prisma.assignment.create({
      data: { teamId: team.id, promptId: prompt.id, bidMinutes: 45, round: 1, multiplier: 1.868 }
    });
    await prisma.score.create({
      data: { teamId: team.id, judgeScore: 80, multiplier: 1.868, finalScore: 149.44 }
    });

    await prisma.gameConfig.create({
      data: { currentRound: 1, currentPromptIndex: 0, status: GAME_STATUS.BIDDING }
    });

    const res = await api('/api/admin/reset', { method: 'POST', token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, GAME_STATUS.WAITING);

    // Bids, assignments, scores should be empty
    assert.equal(await prisma.bid.count(), 0);
    assert.equal(await prisma.assignment.count(), 0);
    assert.equal(await prisma.score.count(), 0);

    // Team and prompt preserved
    assert.equal(await prisma.team.count(), 1);
    assert.equal(await prisma.prompt.count(), 1);

    // GameConfig reset
    const config = await prisma.gameConfig.findFirst();
    assert.equal(config.status, GAME_STATUS.WAITING);
    assert.equal(config.currentRound, 0);
    assert.equal(config.currentPromptIndex, -1);

    // AdminLog created
    const log = await prisma.adminLog.findFirst({ where: { action: 'RESET' } });
    assert.ok(log);
  });

  it('wipes teams and prompts when requested', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });

    const res = await api('/api/admin/reset', {
      method: 'POST',
      token: adminToken,
      body: { wipeAll: true }
    });

    assert.equal(res.status, 200);
    assert.equal(await prisma.team.count(), 0);
    assert.equal(await prisma.prompt.count(), 0);
  });
});
