/**
 * Integration tests for Server Clock and Time Synchronization
 * - GET /api/clock
 * - GET /api/clock/sync
 * - POST /api/clock/sync
 * - Response headers (X-Server-Time, X-Server-Time-ISO)
 * - Clock synchronization over WebSockets (time:sync)
 * - Discarding late bid requests past deadline (HTTP & WebSocket)
 * - Discarding bids during pause or for mismatched prompt IDs
 */

const { before, after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ioClient = require('socket.io-client');

const { prisma, resetDatabase, createTeam } = require('./helpers/setup');
const { app } = require('../src/server');
const { initSocket } = require('../src/socket');
const { ensureAdminAccount } = require('../src/services/authService');
const timerManager = require('../src/socket/timerManager');
const GAME_STATUS = require('../src/constants/gameStatus');
const SOCKET_EVENTS = require('../src/constants/socketEvents');

const ADMIN_PASSWORD = 'admin123';

let server;
let baseUrl;
let ioServer;

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

  return {
    status: response.status,
    headers: response.headers,
    body: parsed
  };
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
  server = http.createServer(app);
  ioServer = initSocket(server);
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  timerManager.resetTimer();
  if (ioServer) {
    await new Promise((resolve) => ioServer.close(resolve));
  }
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

beforeEach(async () => {
  timerManager.resetTimer();
  await resetDatabase();
  await ensureAdminAccount();
});

describe('Server Clock & Time Synchronization', () => {
  it('every HTTP response includes X-Server-Time and X-Server-Time-ISO headers', async () => {
    const res = await api('/api/clock');
    assert.equal(res.status, 200);

    const xServerTime = res.headers.get('x-server-time');
    const xServerTimeIso = res.headers.get('x-server-time-iso');

    assert.ok(xServerTime, 'X-Server-Time header should be present');
    assert.ok(!isNaN(Number(xServerTime)), 'X-Server-Time should be numeric timestamp');
    assert.ok(xServerTimeIso, 'X-Server-Time-ISO header should be present');
    assert.ok(!isNaN(new Date(xServerTimeIso).getTime()), 'X-Server-Time-ISO should be valid date');
  });

  it('GET /api/clock returns current server time and bidding clock status', async () => {
    const res = await api('/api/clock');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.serverTime === 'number');
    assert.ok(typeof res.body.serverTimeIso === 'string');
    assert.equal(res.body.timezone, 'UTC');
    assert.ok(typeof res.body.uptime === 'number');

    assert.ok(res.body.bidding);
    assert.equal(res.body.bidding.status, GAME_STATUS.WAITING);
    assert.equal(res.body.bidding.isRunning, false);
    assert.equal(res.body.bidding.hasExpired, true);
  });

  it('GET /api/clock/sync calculates Cristian / NTP offset metrics', async () => {
    const clientT0 = Date.now() - 15;
    const res = await api(`/api/clock/sync?t0=${clientT0}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.clientTime, clientT0);
    assert.ok(res.body.serverReceiveTime >= clientT0);
    assert.ok(res.body.serverTransmitTime >= res.body.serverReceiveTime);
    assert.equal(res.body.serverTime, res.body.serverTransmitTime);
    assert.equal(res.body.precision, 'millisecond');
  });

  it('POST /api/clock/sync accepts clientTime in json body', async () => {
    const clientT0 = 1700000000000;
    const res = await api('/api/clock/sync', {
      method: 'POST',
      body: { clientTime: clientT0 }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.clientTime, clientT0);
    assert.ok(typeof res.body.serverReceiveTime === 'number');
    assert.ok(typeof res.body.serverTransmitTime === 'number');
  });

  it('reflects active round timer, startTime, endsAt, and secondsRemaining in clock and bid status', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team Alpha', 'password123');
    await prisma.prompt.create({
      data: { title: 'Prompt 1', description: 'Test prompt 1', displayOrder: 1 }
    });

    const startRes = await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });
    assert.equal(startRes.status, 200);
    assert.ok(startRes.body.serverTime);
    assert.ok(startRes.body.startTime);
    assert.ok(startRes.body.endsAt);
    assert.equal(startRes.body.secondsRemaining, 60);

    const clockRes = await api('/api/clock');
    assert.equal(clockRes.status, 200);
    assert.equal(clockRes.body.bidding.status, GAME_STATUS.BIDDING);
    assert.equal(clockRes.body.bidding.isRunning, true);
    assert.equal(clockRes.body.bidding.hasExpired, false);
    assert.ok(clockRes.body.bidding.endsAt > clockRes.body.serverTime);
    assert.equal(clockRes.body.bidding.secondsRemaining, 60);

    const stateRes = await api('/api/bid/current');
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.status, GAME_STATUS.BIDDING);
    assert.ok(stateRes.body.serverTime);
    assert.ok(stateRes.body.endsAt);
    assert.equal(stateRes.body.hasExpired, false);
  });

  it('accepts bids within the synchronized timer window', async () => {
    const adminToken = await getAdminToken();
    const teamToken = await getTeamToken('Team Bravo');
    await prisma.prompt.create({
      data: { title: 'Prompt A', description: 'Desc A', displayOrder: 1 }
    });

    await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    const bidRes = await api('/api/bid', {
      method: 'POST',
      token: teamToken,
      body: { bidMinutes: 45 }
    });

    assert.equal(bidRes.status, 200);
    assert.equal(bidRes.body.success, true);
    assert.equal(bidRes.body.bid.bidMinutes, 45);
    assert.ok(bidRes.body.serverTime);
    assert.ok(bidRes.body.bid.serverTime);
    assert.ok(bidRes.body.bid.submittedAt);
  });

  it('discards late bid requests submitted after the server deadline has passed', async () => {
    const adminToken = await getAdminToken();
    const teamToken = await getTeamToken('Team Charlie');
    await prisma.prompt.create({
      data: { title: 'Prompt B', description: 'Desc B', displayOrder: 1 }
    });

    await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    // Simulate timer expiration by setting endsAt into the past
    timerManager.endsAt = Date.now() - 500;

    const lateBidRes = await api('/api/bid', {
      method: 'POST',
      token: teamToken,
      body: { bidMinutes: 50 }
    });

    assert.equal(lateBidRes.status, 400);
    assert.equal(lateBidRes.body.success, false);
    assert.match(lateBidRes.body.error.message, /expired/i);
  });

  it('rejects bids when round is paused', async () => {
    const adminToken = await getAdminToken();
    const teamToken = await getTeamToken('Team Delta');
    await prisma.prompt.create({
      data: { title: 'Prompt C', description: 'Desc C', displayOrder: 1 }
    });

    await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    await api('/api/admin/round/pause', {
      method: 'POST',
      token: adminToken
    });

    const pausedBidRes = await api('/api/bid', {
      method: 'POST',
      token: teamToken,
      body: { bidMinutes: 50 }
    });

    assert.equal(pausedBidRes.status, 400);
    assert.equal(pausedBidRes.body.success, false);
    assert.match(pausedBidRes.body.error.message, /paused/i);
  });

  it('rejects bids targeting an inactive or mismatched promptId', async () => {
    const adminToken = await getAdminToken();
    const teamToken = await getTeamToken('Team Echo');
    const prompt = await prisma.prompt.create({
      data: { title: 'Prompt D', description: 'Desc D', displayOrder: 1 }
    });

    await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    const wrongPromptBidRes = await api('/api/bid', {
      method: 'POST',
      token: teamToken,
      body: { bidMinutes: 50, promptId: prompt.id + 999 }
    });

    assert.ok([400, 409].includes(wrongPromptBidRes.status));
    assert.equal(wrongPromptBidRes.body.success, false);
    assert.match(wrongPromptBidRes.body.error.message, /prompt/i);
  });

  it('synchronizes clock and enforces deadlines over WebSockets', async () => {
    const adminToken = await getAdminToken();
    const teamToken = await getTeamToken('Team Foxtrot');
    await prisma.prompt.create({
      data: { title: 'Prompt WebSocket', description: 'WS Desc', displayOrder: 1 }
    });

    const clientSocket = ioClient(baseUrl, {
      auth: { token: teamToken },
      transports: ['websocket']
    });

    await new Promise((resolve, reject) => {
      clientSocket.on('connect', resolve);
      clientSocket.on('connect_error', reject);
    });

    // Test time:sync via socket
    const syncResult = await new Promise((resolve) => {
      clientSocket.emit(SOCKET_EVENTS.CLIENT.TIME_SYNC, { clientTime: 123456 }, (ack) => {
        resolve(ack);
      });
    });

    assert.equal(syncResult.clientTime, 123456);
    assert.ok(typeof syncResult.serverReceiveTime === 'number');
    assert.ok(typeof syncResult.serverTransmitTime === 'number');
    assert.ok(typeof syncResult.serverTime === 'number');

    // Start round
    await api('/api/admin/round/start', {
      method: 'POST',
      token: adminToken,
      body: { round: 1 }
    });

    // Place bid within valid window over socket
    const validBidResult = await new Promise((resolve) => {
      clientSocket.emit(SOCKET_EVENTS.CLIENT.BID_PLACE, { bidMinutes: 40 }, (ack) => {
        resolve(ack);
      });
    });

    assert.equal(validBidResult.success, true);
    assert.equal(validBidResult.bid.bidMinutes, 40);
    assert.ok(validBidResult.serverTime);

    // Simulate timer expired
    timerManager.endsAt = Date.now() - 500;

    // Late bid over socket should be rejected
    const lateBidResult = await new Promise((resolve) => {
      clientSocket.emit(SOCKET_EVENTS.CLIENT.BID_PLACE, { bidMinutes: 42 }, (ack) => {
        resolve(ack);
      });
    });

    assert.equal(lateBidResult.success, false);
    assert.match(lateBidResult.error.message, /expired/i);

    clientSocket.disconnect();
  });
});
