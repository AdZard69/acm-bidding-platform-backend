/**
 * Integration tests for the Admin Round endpoints:
 * POST /api/admin/round/start
 * POST /api/admin/round/pause
 * POST /api/admin/round/resume
 * POST /api/admin/round/extend
 * POST /api/admin/round/next-prompt
 * POST /api/admin/round/end
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

describe('POST /api/admin/round/start', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/round/start', { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
  });

  it('rejects with team token (forbidden)', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: teamToken
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
  });

  it('rejects when no prompts exist', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error.message, /no prompts found/i);
  });

  it('rejects when no active teams exist', async () => {
    const adminToken = await getAdminToken();
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error.message, /no active teams found/i);
  });

  it('rejects round extending beyond number of prompts or non-positive round number', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    // 1 prompt exists, so round 3 extends beyond the number of prompts
    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 3 }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error.message, /cannot extend beyond the total number of prompts/i);

    // Negative or 0 round number is rejected
    const zeroRes = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 0 }
    });
    assert.equal(zeroRes.status, 400);
    assert.match(zeroRes.body.error.message, /round number must be a positive integer/i);
  });

  it('successfully starts round 1 with omitted body (defaults to 1)', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'Reverse a Linked List', description: 'Solve in O(N)', displayOrder: 1 }
    });

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.round, 1);
    assert.equal(res.body.status, GAME_STATUS.BIDDING);
    assert.equal(res.body.currentPrompt.id, prompt.id);
    assert.equal(res.body.currentPrompt.title, prompt.title);
    assert.equal(typeof res.body.secondsRemaining, 'number');

    // Verify DB GameConfig
    const config = await prisma.gameConfig.findFirst();
    assert.equal(config.status, GAME_STATUS.BIDDING);
    assert.equal(config.currentRound, 1);
    assert.equal(config.currentPromptIndex, 0);

    // Verify AdminLog
    const log = await prisma.adminLog.findFirst({ where: { action: 'ROUND_START' } });
    assert.ok(log);
    assert.match(log.details, /round 1/i);
  });

  it('rejects starting a round when already in progress', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    const secondRes = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    assert.equal(secondRes.status, 400);
    assert.equal(secondRes.body.success, false);
    assert.match(secondRes.body.error.message, /already in progress/i);
  });

  it('rejects starting round 2 if round 1 was never completed', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await prisma.prompt.create({
      data: { title: 'P2', description: 'Desc 2', displayOrder: 2 }
    });

    const res = await api('/api/admin/round/round/start' /* typo check */, {
      method: 'POST',
      token: adminToken,
      body: { round: 2 }
    });
    // With correct path:
    const correctRes = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 2 }
    });

    assert.equal(correctRes.status, 400);
    assert.equal(correctRes.body.success, false);
    assert.match(correctRes.body.error.message, /round 1 must be completed/i);
  });

  it('opens prompt 2 when an admin starts round 2 even if all teams already have assignments', async () => {
    const adminToken = await getAdminToken();
    const team = await createTeam('Team 1', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await prisma.prompt.create({
      data: { title: 'P2', description: 'Desc 2', displayOrder: 2 }
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

    await prisma.gameConfig.create({
      data: {
        currentRound: 1,
        status: GAME_STATUS.ROUND_ENDED
      }
    });

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 2 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.currentRound, 2);
    assert.equal(res.body.currentPrompt.displayOrder, 2);
  });

  it('does not substitute another prompt for round 2 when its slots are full', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');
    const team2 = await createTeam('Team 2', 'pass123');
    const team3 = await createTeam('Team 3', 'pass123');
    const prompt1 = await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    const prompt2 = await prisma.prompt.create({
      data: { title: 'P2', description: 'Desc 2', displayOrder: 2 }
    });

    // Slots per prompt = 1
    await prisma.gameConfig.create({
      data: {
        currentRound: 1,
        slotsPerPrompt: 1,
        status: GAME_STATUS.ROUND_ENDED
      }
    });

    await prisma.assignment.create({
      data: {
        teamId: team1.id,
        promptId: prompt1.id,
        bidMinutes: 50,
        round: 1,
        multiplier: 1.792
      }
    });
    await prisma.assignment.create({
      data: {
        teamId: team2.id,
        promptId: prompt2.id,
        bidMinutes: 50,
        round: 1,
        multiplier: 1.792
      }
    });

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 2 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.currentRound, 2);
    assert.equal(res.body.currentPrompt.id, prompt2.id);
    assert.equal(res.body.availableSlots, 0);
  });

  it('successfully starts round 2 when unassigned teams and open slots exist', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');
    const team2 = await createTeam('Team 2', 'pass123');
    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await prisma.prompt.create({
      data: { title: 'P2', description: 'Desc 2', displayOrder: 2 }
    });

    await prisma.assignment.create({
      data: {
        teamId: team1.id,
        promptId: prompt.id,
        bidMinutes: 50,
        round: 1,
        multiplier: 1.792
      }
    });

    await prisma.gameConfig.create({
      data: {
        currentRound: 1,
        slotsPerPrompt: 3, // 2 slots still open
        status: GAME_STATUS.ROUND_ENDED
      }
    });

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 2 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.round, 2);
    assert.equal(res.body.status, GAME_STATUS.BIDDING);
  });

  it('successfully starts round 3 when 3 prompts exist and round 2 is completed', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');
    const team2 = await createTeam('Team 2', 'pass123');
    const team3 = await createTeam('Team 3', 'pass123');

    const prompt1 = await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    const prompt2 = await prisma.prompt.create({
      data: { title: 'P2', description: 'Desc 2', displayOrder: 2 }
    });
    const prompt3 = await prisma.prompt.create({
      data: { title: 'P3', description: 'Desc 3', displayOrder: 3 }
    });

    // Team 1 assigned in round 1, team 2 assigned in round 2, team 3 unassigned
    await prisma.assignment.create({
      data: {
        teamId: team1.id,
        promptId: prompt1.id,
        bidMinutes: 50,
        round: 1,
        multiplier: 1.792
      }
    });
    await prisma.assignment.create({
      data: {
        teamId: team2.id,
        promptId: prompt2.id,
        bidMinutes: 60,
        round: 2,
        multiplier: 1.649
      }
    });

    await prisma.gameConfig.create({
      data: {
        currentRound: 2,
        slotsPerPrompt: 3,
        status: GAME_STATUS.ROUND_ENDED
      }
    });

    const res = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 3 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.round, 3);
    assert.equal(res.body.status, GAME_STATUS.BIDDING);
  });
});

describe('POST /api/admin/round/pause', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/round/pause', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/round/pause', { method: 'POST', token: teamToken });
    assert.equal(res.status, 403);
  });

  it('rejects when round is not actively bidding', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/round/pause', { method: 'POST', token: adminToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not actively bidding/i);
  });

  it('successfully pauses an active round', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const pauseRes = await api('/api/admin/round/pause', { method: 'POST', token: adminToken });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.body.success, true);
    assert.equal(pauseRes.body.status, GAME_STATUS.PAUSED);
    assert.equal(typeof pauseRes.body.secondsRemaining, 'number');

    const config = await prisma.gameConfig.findFirst();
    assert.equal(config.status, GAME_STATUS.PAUSED);

    const log = await prisma.adminLog.findFirst({ where: { action: 'ROUND_PAUSE' } });
    assert.ok(log);
  });

  it('rejects if already paused', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/admin/round/pause', { method: 'POST', token: adminToken });

    const secondPause = await api('/api/admin/round/pause', { method: 'POST', token: adminToken });
    assert.equal(secondPause.status, 400);
    assert.match(secondPause.body.error.message, /already paused/i);
  });
});

describe('POST /api/admin/round/resume', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/round/resume', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/round/resume', { method: 'POST', token: teamToken });
    assert.equal(res.status, 403);
  });

  it('rejects when round is not paused', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/round/resume', { method: 'POST', token: adminToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not paused/i);
  });

  it('successfully resumes a paused round', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/admin/round/pause', { method: 'POST', token: adminToken });

    const resumeRes = await api('/api/admin/round/resume', { method: 'POST', token: adminToken });
    assert.equal(resumeRes.status, 200);
    assert.equal(resumeRes.body.success, true);
    assert.equal(resumeRes.body.status, GAME_STATUS.BIDDING);

    const config = await prisma.gameConfig.findFirst();
    assert.equal(config.status, GAME_STATUS.BIDDING);

    const log = await prisma.adminLog.findFirst({ where: { action: 'ROUND_RESUME' } });
    assert.ok(log);
  });
});

describe('POST /api/admin/round/extend', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/round/extend', { method: 'POST', body: { extraSeconds: 30 } });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/round/extend', {
      method: 'POST',
      token: teamToken,
      body: { extraSeconds: 30 }
    });
    assert.equal(res.status, 403);
  });

  it('rejects when no round is active', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { extraSeconds: 30 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /no prompt is currently active/i);
  });

  it('rejects invalid extraSeconds values', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Negative
    let res = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { extraSeconds: -10 }
    });
    assert.equal(res.status, 400);

    // Zero
    res = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { extraSeconds: 0 }
    });
    assert.equal(res.status, 400);

    // Non-integer
    res = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { extraSeconds: 15.5 }
    });
    assert.equal(res.status, 400);

    // String/garbage
    res = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { extraSeconds: 'abc' }
    });
    assert.equal(res.status, 400);
  });

  it('successfully extends timer with extraSeconds', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const extendRes = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { extraSeconds: 30 }
    });

    assert.equal(extendRes.status, 200);
    assert.equal(extendRes.body.success, true);
    assert.equal(extendRes.body.extraSeconds, 30);
    assert.ok(extendRes.body.secondsRemaining >= 80); // 60 + 30 = 90 approx

    const log = await prisma.adminLog.findFirst({ where: { action: 'ROUND_EXTEND' } });
    assert.ok(log);
  });

  it('successfully extends timer while paused', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/admin/round/pause', { method: 'POST', token: adminToken });

    const extendRes = await api('/api/admin/round/extend', {
      method: 'POST',
      token: adminToken,
      body: { seconds: 15 } // tests 'seconds' alias
    });

    assert.equal(extendRes.status, 200);
    assert.equal(extendRes.body.success, true);
    assert.equal(extendRes.body.extraSeconds, 15);
  });
});

describe('POST /api/admin/round/next-prompt', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/round/next-prompt', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/round/next-prompt', { method: 'POST', token: teamToken });
    assert.equal(res.status, 403);
  });

  it('rejects when no round is in progress', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/round/next-prompt', { method: 'POST', token: adminToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /no round in progress/i);
  });

  it('advances to next prompt and awards winning bids', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');
    const team2 = await createTeam('Team 2', 'pass123');
    const team3 = await createTeam('Team 3', 'pass123');

    const prompt1 = await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Desc 1', displayOrder: 1 }
    });
    const prompt2 = await prisma.prompt.create({
      data: { title: 'Prompt 2', description: 'Desc 2', displayOrder: 2 }
    });

    // Start Round 1
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Team 1 bids 50 mins, Team 2 bids 70 mins on Prompt 1
    await prisma.bid.create({
      data: { teamId: team1.id, promptId: prompt1.id, bidMinutes: 50, round: 1 }
    });
    await prisma.bid.create({
      data: { teamId: team2.id, promptId: prompt1.id, bidMinutes: 70, round: 1 }
    });

    // Admin skips to next prompt
    const nextRes = await api('/api/admin/round/next-prompt', { method: 'POST', token: adminToken });

    assert.equal(nextRes.status, 200);
    assert.equal(nextRes.body.success, true);
    assert.equal(nextRes.body.promptIndex, 1);
    assert.equal(nextRes.body.currentRound, 2);
    assert.equal(nextRes.body.completedRound.round, 1);
    assert.equal(nextRes.body.prompt.id, prompt2.id);
    assert.equal(nextRes.body.completedRound.winners.length, 2);
    assert.equal(nextRes.body.completedRound.winners[0].teamId, team1.id);
    assert.equal(nextRes.body.completedRound.winners[0].bidMinutes, 50);
    assert.equal(nextRes.body.completedRound.winners[1].teamId, team2.id);
    assert.equal(nextRes.body.completedRound.winners[1].bidMinutes, 70);

    // Verify Assignments were created in DB
    const assignment1 = await prisma.assignment.findUnique({ where: { teamId: team1.id } });
    assert.ok(assignment1);
    assert.equal(assignment1.promptId, prompt1.id);
    assert.equal(assignment1.bidMinutes, 50);

    const assignment2 = await prisma.assignment.findUnique({ where: { teamId: team2.id } });
    assert.ok(assignment2);
    assert.equal(assignment2.promptId, prompt1.id);
    assert.equal(assignment2.bidMinutes, 70);

    // Verify AdminLog
    const log = await prisma.adminLog.findFirst({ where: { action: 'NEXT_PROMPT' } });
    assert.ok(log);
  });

  it('ends round on last prompt and auto-assigns single remaining team', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');
    const team2 = await createTeam('Team 2', 'pass123');

    const prompt1 = await prisma.prompt.create({
      data: { title: 'Only Prompt', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Team 1 bids 40 mins; Team 2 does not bid
    await prisma.bid.create({
      data: { teamId: team1.id, promptId: prompt1.id, bidMinutes: 40, round: 1 }
    });

    const nextRes = await api('/api/admin/round/next-prompt', { method: 'POST', token: adminToken });

    assert.equal(nextRes.status, 200);
    assert.equal(nextRes.body.success, true);
    assert.equal(nextRes.body.status, GAME_STATUS.ROUND_ENDED);
    assert.equal(nextRes.body.winners.length, 1);
    assert.equal(nextRes.body.winners[0].teamId, team1.id);

    // Team 2 should be auto-assigned at base time (120 mins) with multiplier 1.000
    const assignment2 = await prisma.assignment.findUnique({ where: { teamId: team2.id } });
    assert.ok(assignment2);
    assert.equal(assignment2.promptId, prompt1.id);
    assert.equal(assignment2.bidMinutes, 120);
    assert.equal(Number(assignment2.multiplier), 1.0);

    // Game status in DB should be round_ended
    const config = await prisma.gameConfig.findFirst();
    assert.equal(config.status, GAME_STATUS.ROUND_ENDED);
  });

  it('opens the next prompt only on the admin action even when all teams are assigned', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');

    const prompt1 = await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });
    await prisma.prompt.create({
      data: { title: 'P2', description: 'Desc 2', displayOrder: 2 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    // Only 1 team exists and bids on P1
    await prisma.bid.create({
      data: { teamId: team1.id, promptId: prompt1.id, bidMinutes: 45, round: 1 }
    });

    const nextRes = await api('/api/admin/round/next-prompt', { method: 'POST', token: adminToken });

    assert.equal(nextRes.status, 200);
    assert.equal(nextRes.body.status, GAME_STATUS.BIDDING);
    assert.equal(nextRes.body.currentRound, 2);
    assert.equal(nextRes.body.currentPrompt.displayOrder, 2);
    assert.equal(nextRes.body.completedRound.summary.unassignedTeams, 0);
  });
});

describe('POST /api/admin/round/end', () => {
  it('rejects without auth token', async () => {
    const res = await api('/api/admin/round/end', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects with team token', async () => {
    const teamToken = await getTeamToken('Team Alpha');
    const res = await api('/api/admin/round/end', { method: 'POST', token: teamToken });
    assert.equal(res.status, 403);
  });

  it('rejects when no round is in progress', async () => {
    const adminToken = await getAdminToken();
    const res = await api('/api/admin/round/end', { method: 'POST', token: adminToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /no round is currently in progress/i);
  });

  it('successfully force-ends an active round and awards current bids', async () => {
    const adminToken = await getAdminToken();
    const team1 = await createTeam('Team 1', 'pass123');
    const team2 = await createTeam('Team 2', 'pass123');

    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    await prisma.bid.create({
      data: { teamId: team1.id, promptId: prompt.id, bidMinutes: 60, round: 1 }
    });

    const endRes = await api('/api/admin/round/end', { method: 'POST', token: adminToken });

    assert.equal(endRes.status, 200);
    assert.equal(endRes.body.success, true);
    assert.equal(endRes.body.status, GAME_STATUS.ROUND_ENDED);
    assert.equal(endRes.body.winners.length, 1);
    assert.equal(endRes.body.winners[0].teamId, team1.id);
    assert.equal(endRes.body.summary.assignedTeams, 1);
    assert.equal(endRes.body.summary.unassignedTeams, 1);

    const config = await prisma.gameConfig.findFirst();
    assert.equal(config.status, GAME_STATUS.ROUND_ENDED);

    const log = await prisma.adminLog.findFirst({ where: { action: 'ROUND_END' } });
    assert.ok(log);
  });

  it('successfully force-ends a paused round', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team 1', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'Desc 1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await api('/api/admin/round/pause', { method: 'POST', token: adminToken });

    const endRes = await api('/api/admin/round/end', { method: 'POST', token: adminToken });

    assert.equal(endRes.status, 200);
    assert.equal(endRes.body.success, true);
    assert.equal(endRes.body.status, GAME_STATUS.ROUND_ENDED);
  });
});


describe('manual prompt rounds', () => {
  it('retains round 1 on expiry, waits for Next, and isolates round 2 bids', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const adminToken = await getAdminToken();
    const first = await createTeam('Manual First', 'pass123');
    const second = await createTeam('Manual Second', 'pass123');
    const prompt1 = await prisma.prompt.create({ data: { title: 'Manual 1', description: 'One', displayOrder: 1 } });
    const prompt2 = await prisma.prompt.create({ data: { title: 'Manual 2', description: 'Two', displayOrder: 2 } });
    const begun = await api('/api/admin/round/start', { method: 'POST', token: adminToken });
    await prisma.bid.create({ data: { teamId: first.id, promptId: prompt1.id, round: 1, bidMinutes: 45 } });
    timerManager.endsAt = Date.now() - 1;
    t.mock.timers.tick(100);
    await Promise.resolve();
    const ended = await api('/api/bid/current');
    assert.equal(ended.body.status, GAME_STATUS.ROUND_ENDED);
    assert.equal(ended.body.currentRound, 1);
    assert.equal(ended.body.currentPrompt.id, prompt1.id);
    assert.equal(ended.body.bids.length, 1);
    const next = await api('/api/admin/round/next-prompt', { method: 'POST', token: adminToken, body: { timerId: begun.body.timerId } });
    assert.equal(next.body.currentRound, 2);
    assert.equal(next.body.currentPrompt.id, prompt2.id);
    await prisma.bid.create({ data: { teamId: second.id, promptId: prompt2.id, round: 2, bidMinutes: 50 } });
    const history = await api('/api/admin/bids?round=2', { token: adminToken });
    assert.equal(history.body.bids.length, 1);
    assert.equal(history.body.bids[0].promptId, prompt2.id);
    assert.equal(history.body.bids[0].round, 2);
  });
});
