/**
 * Integration tests for Team Bidding Endpoints:
 * GET  /api/bid/current
 * POST /api/bid/place
 * PUT  /api/bid/update
 * GET  /api/bid/my-bids
 * GET  /api/bid/assignment
 * GET  /api/bid/leaderboard
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
  const team = await createTeam(teamName, password);
  const res = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName, password }
  });
  return { token: res.body.token, team };
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

describe('GET /api/bid/current', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/bid/current');
    assert.equal(res.status, 401);
  });

  it('rejects with admin token (forbidden)', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/bid/current', { token: adminToken });
    assert.equal(res.status, 403);
  });

  it('returns waiting status and null prompt when round has not started', async () => {
    const { token } = await getTeamToken('Team Alpha');
    const res = await api('/api/bid/current', { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, GAME_STATUS.WAITING);
    assert.equal(res.body.currentPrompt, null);
    assert.equal(res.body.secondsRemaining, 0);
    assert.deepEqual(res.body.bids, []);
    assert.equal(res.body.myBid, null);
    assert.equal(res.body.hasAssignment, false);
    assert.equal(res.body.assignment, null);
  });

  it('returns active prompt, seconds remaining, bids, and myBid when bidding is active', async () => {
    const adminToken = await getAdminToken();
    const { token: team1Token, team: team1 } = await getTeamToken('Team Alpha');
    const { team: team2 } = await getTeamToken('Team Beta');

    const prompt = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    // Start Round 1
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Place a bid for team 2
    await prisma.bid.create({
      data: { teamId: team2.id, promptId: prompt.id, bidMinutes: 75, round: 1 }
    });

    // Team 1 calls /api/bid/current before placing a bid
    let res = await api('/api/bid/current', { token: team1Token });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, GAME_STATUS.BIDDING);
    assert.equal(res.body.currentPrompt.id, prompt.id);
    assert.equal(res.body.currentPrompt.title, 'Prompt 1');
    assert.equal(res.body.bids.length, 1);
    assert.equal(res.body.bids[0].teamName, 'Team Beta');
    assert.equal(res.body.bids[0].bidMinutes, 75);
    assert.equal(res.body.myBid, null);

    // Now Team 1 places a bid
    await prisma.bid.create({
      data: { teamId: team1.id, promptId: prompt.id, bidMinutes: 50, round: 1 }
    });

    res = await api('/api/bid/current', { token: team1Token });
    assert.equal(res.status, 200);
    assert.equal(res.body.bids.length, 2);
    assert.ok(res.body.myBid);
    assert.equal(res.body.myBid.bidMinutes, 50);
  });

  it('returns paused status and isPaused=true when round is paused', async () => {
    const adminToken = await getAdminToken();
    const { token: teamToken } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/admin/round/pause', { method: 'POST', token: adminToken });

    const res = await api('/api/bid/current', { token: teamToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, GAME_STATUS.PAUSED);
    assert.equal(res.body.isPaused, true);
  });
});

describe('POST /api/bid/place', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/bid/place', { method: 'POST', body: { bidMinutes: 60 } });
    assert.equal(res.status, 401);
  });

  it('rejects with admin token', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/bid/place', {
      method: 'POST',
      token: adminToken,
      body: { bidMinutes: 60 }
    });
    assert.equal(res.status, 403);
  });

  it('rejects if bidding is not active', async () => {
    const { token } = await getTeamToken('Team Alpha');
    const res = await api('/api/bid/place', {
      method: 'POST',
      token,
      body: { bidMinutes: 60 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /bidding is not currently active/i);
  });

  it('rejects if round is paused', async () => {
    const adminToken = await getAdminToken();
    const { token } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/admin/round/pause', { method: 'POST', token: adminToken });

    const res = await api('/api/bid/place', {
      method: 'POST',
      token,
      body: { bidMinutes: 60 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /paused/i);
  });

  it('rejects if team is deactivated', async () => {
    const adminToken = await getAdminToken();
    const { token, team } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Admin deactivates team
    await api(`/api/admin/teams/${team.id}/toggle`, { method: 'PATCH', token: adminToken });

    const res = await api('/api/bid/place', {
      method: 'POST',
      token,
      body: { bidMinutes: 60 }
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /deactivated/i);
  });

  it('rejects if team already has an assignment', async () => {
    const adminToken = await getAdminToken();
    const { token, team } = await getTeamToken('Team Alpha');
    const prompt = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await prisma.assignment.create({
      data: { teamId: team.id, promptId: prompt.id, bidMinutes: 60, round: 1, multiplier: 1.649 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const res = await api('/api/bid/place', {
      method: 'POST',
      token,
      body: { bidMinutes: 45 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /already been assigned a prompt/i);
  });

  it('rejects invalid bid values', async () => {
    const adminToken = await getAdminToken();
    const { token } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Missing bid
    let res = await api('/api/bid/place', { method: 'POST', token, body: {} });
    assert.equal(res.status, 400);

    // Below minBid (30)
    res = await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 20 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /minimum allowable bid is 30/i);

    // Above baseTime (120)
    res = await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 130 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /maximum allowable bid is 120/i);

    // Non-integer
    res = await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 45.5 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /whole number/i);
  });

  it('successfully places a bid and creates record in DB', async () => {
    const adminToken = await getAdminToken();
    const { token, team } = await getTeamToken('Team Alpha');
    const prompt = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const res = await api('/api/bid/place', {
      method: 'POST',
      token,
      body: { bidMinutes: 50 }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.bid.teamId, team.id);
    assert.equal(res.body.bid.teamName, 'Team Alpha');
    assert.equal(res.body.bid.promptId, prompt.id);
    assert.equal(res.body.bid.bidMinutes, 50);
    assert.equal(res.body.bid.round, 1);

    // Verify in DB
    const dbBid = await prisma.bid.findUnique({
      where: {
        teamId_promptId_round: {
          teamId: team.id,
          promptId: prompt.id,
          round: 1
        }
      }
    });
    assert.ok(dbBid);
    assert.equal(dbBid.bidMinutes, 50);
  });

  it('rejects duplicate bid by the same team on the same prompt', async () => {
    const adminToken = await getAdminToken();
    const { token } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 50 } });

    const secondBid = await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 60 } });
    assert.equal(secondBid.status, 400);
    assert.match(secondBid.body.error.message, /already placed a bid/i);
  });

  it('rejects collision bid (same minutes as another team on the same prompt)', async () => {
    const adminToken = await getAdminToken();
    const { token: team1Token } = await getTeamToken('Team Alpha');
    const { token: team2Token } = await getTeamToken('Team Beta');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Team 1 bids 60
    const res1 = await api('/api/bid/place', { method: 'POST', token: team1Token, body: { bidMinutes: 60 } });
    assert.equal(res1.status, 201);

    // Team 2 bids 60 -> conflict
    const res2 = await api('/api/bid/place', { method: 'POST', token: team2Token, body: { bidMinutes: 60 } });
    assert.equal(res2.status, 409);
    assert.match(res2.body.error.message, /already been placed by another team/i);
  });
});

describe('PUT /api/bid/update', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/bid/update', { method: 'PUT', body: { bidMinutes: 55 } });
    assert.equal(res.status, 401);
  });

  it('rejects if team has no existing bid for this prompt', async () => {
    const adminToken = await getAdminToken();
    const { token } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const res = await api('/api/bid/update', { method: 'PUT', token, body: { bidMinutes: 55 } });
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /no existing bid found/i);
  });

  it('rejects updating to the exact same bidMinutes', async () => {
    const adminToken = await getAdminToken();
    const { token } = await getTeamToken('Team Alpha');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 50 } });

    const res = await api('/api/bid/update', { method: 'PUT', token, body: { bidMinutes: 50 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /must be different/i);
  });

  it('rejects collision with another team on update', async () => {
    const adminToken = await getAdminToken();
    const { token: team1Token } = await getTeamToken('Team Alpha');
    const { token: team2Token } = await getTeamToken('Team Beta');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Team 1 bids 50, Team 2 bids 70
    await api('/api/bid/place', { method: 'POST', token: team1Token, body: { bidMinutes: 50 } });
    await api('/api/bid/place', { method: 'POST', token: team2Token, body: { bidMinutes: 70 } });

    // Team 2 tries to update bid to 50
    const res = await api('/api/bid/update', { method: 'PUT', token: team2Token, body: { bidMinutes: 50 } });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /already been placed by another team/i);
  });

  it('successfully updates bid value', async () => {
    const adminToken = await getAdminToken();
    const { token, team } = await getTeamToken('Team Alpha');
    const prompt = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/bid/place', { method: 'POST', token, body: { bidMinutes: 50 } });

    const updateRes = await api('/api/bid/update', { method: 'PUT', token, body: { bidMinutes: 40 } });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.success, true);
    assert.equal(updateRes.body.bid.bidMinutes, 40);

    // Verify in DB
    const dbBid = await prisma.bid.findUnique({
      where: {
        teamId_promptId_round: {
          teamId: team.id,
          promptId: prompt.id,
          round: 1
        }
      }
    });
    assert.equal(dbBid.bidMinutes, 40);
  });
});

describe('GET /api/bid/my-bids', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/bid/my-bids');
    assert.equal(res.status, 401);
  });

  it('returns all bids placed by the team', async () => {
    const { token, team } = await getTeamToken('Team Alpha');
    const prompt1 = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });
    const prompt2 = await prisma.prompt.create({
      data: { title: 'Prompt 2', description: 'Desc 2', displayOrder: 2 }
    });

    await prisma.bid.create({
      data: { teamId: team.id, promptId: prompt1.id, bidMinutes: 60, round: 1 }
    });
    await prisma.bid.create({
      data: { teamId: team.id, promptId: prompt2.id, bidMinutes: 45, round: 1 }
    });

    const res = await api('/api/bid/my-bids', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.bids.length, 2);
    assert.equal(res.body.bids[0].promptTitle, 'Prompt 1');
    assert.equal(res.body.bids[0].bidMinutes, 60);
    assert.equal(res.body.bids[1].promptTitle, 'Prompt 2');
    assert.equal(res.body.bids[1].bidMinutes, 45);
  });
});

describe('GET /api/bid/assignment', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/bid/assignment');
    assert.equal(res.status, 401);
  });

  it('returns assignment: null when team is not yet assigned', async () => {
    const { token } = await getTeamToken('Team Alpha');
    const res = await api('/api/bid/assignment', { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.assignment, null);
  });

  it('returns assignment details and multiplier when team is assigned', async () => {
    const { token, team } = await getTeamToken('Team Alpha');
    const prompt = await prisma.prompt.create({
      data: { title: 'Hard Problem', description: 'Solve it fast', displayOrder: 1 }
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

    const res = await api('/api/bid/assignment', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.assignment.teamId, team.id);
    assert.equal(res.body.assignment.promptId, prompt.id);
    assert.equal(res.body.assignment.title, 'Hard Problem');
    assert.equal(res.body.assignment.bidMinutes, 50);
    assert.equal(res.body.assignment.multiplier, 1.792);
    assert.equal(res.body.assignment.codingTimeMinutes, 50);
  });
});

describe('GET /api/bid/leaderboard', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/bid/leaderboard');
    assert.equal(res.status, 401);
  });

  it('returns public leaderboard for team', async () => {
    const { token: team1Token, team: team1 } = await getTeamToken('Team Alpha');
    const { team: team2 } = await getTeamToken('Team Beta');

    const prompt = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });

    await prisma.assignment.create({
      data: { teamId: team1.id, promptId: prompt.id, bidMinutes: 50, round: 1, multiplier: 1.792 }
    });
    await prisma.assignment.create({
      data: { teamId: team2.id, promptId: prompt.id, bidMinutes: 80, round: 1, multiplier: 1.396 }
    });

    await prisma.score.create({
      data: { teamId: team1.id, judgeScore: 80, multiplier: 1.792, finalScore: 143.36 }
    });
    await prisma.score.create({
      data: { teamId: team2.id, judgeScore: 90, multiplier: 1.396, finalScore: 125.64 }
    });

    const res = await api('/api/bid/leaderboard', { token: team1Token });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.leaderboard.length, 2);
    assert.equal(res.body.leaderboard[0].rank, 1);
    assert.equal(res.body.leaderboard[0].teamName, 'Team Alpha');
    assert.equal(res.body.leaderboard[0].finalScore, 143.36);
  });
});
