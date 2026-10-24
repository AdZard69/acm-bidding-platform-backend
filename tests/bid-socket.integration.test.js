/**
 * Integration tests for Socket.IO event handlers:
 * - Team bid:place and bid:update
 * - Admin round controls (admin:start-round, admin:pause, admin:resume, etc.)
 * - Broadcasts: bid:new, bid:updated, timer:tick, prompt:reveal
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
const SOCKET_EVENTS = require('../src/constants/socketEvents');
const GAME_STATUS = require('../src/constants/gameStatus');

const ADMIN_PASSWORD = 'admin123';

let server;
let baseUrl;
let port;

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

const connectSocket = (token) => {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true
    });

    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
};

before(async () => {
  server = http.createServer(app);
  initSocket(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
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

describe('Socket.IO Bidding Events', () => {
  it('team socket places bid successfully and triggers bid:new broadcast', async () => {
    const adminToken = await getAdminToken();
    const { token: team1Token, team: team1 } = await getTeamToken('Team Alpha');
    const { token: team2Token } = await getTeamToken('Team Beta');

    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });

    // Start round
    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const socket1 = await connectSocket(team1Token);
    const socket2 = await connectSocket(team2Token);

    try {
      const broadcastPromise = new Promise((resolve) => {
        socket2.on(SOCKET_EVENTS.SERVER.BID_NEW, (data) => resolve(data));
      });

      const ackResponse = await new Promise((resolve) => {
        socket1.emit(SOCKET_EVENTS.CLIENT.BID_PLACE, { bidMinutes: 45 }, (ack) => {
          resolve(ack);
        });
      });

      assert.equal(ackResponse.success, true);
      assert.equal(ackResponse.bid.teamId, team1.id);
      assert.equal(ackResponse.bid.bidMinutes, 45);

      const broadcastData = await broadcastPromise;
      assert.equal(broadcastData.teamId, team1.id);
      assert.equal(broadcastData.bidMinutes, 45);
      assert.equal(broadcastData.promptId, prompt.id);
    } finally {
      socket1.disconnect();
      socket2.disconnect();
    }
  });

  it('team socket bid:place handles collision and emits error', async () => {
    const adminToken = await getAdminToken();
    const { token: team1Token } = await getTeamToken('Team Alpha');
    const { token: team2Token } = await getTeamToken('Team Beta');

    await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const socket1 = await connectSocket(team1Token);
    const socket2 = await connectSocket(team2Token);

    try {
      // Team 1 bids 50
      await new Promise((resolve) => {
        socket1.emit(SOCKET_EVENTS.CLIENT.BID_PLACE, { bidMinutes: 50 }, resolve);
      });

      // Team 2 bids 50 -> error
      const errorPromise = new Promise((resolve) => {
        socket2.on(SOCKET_EVENTS.SERVER.ERROR, (err) => resolve(err));
      });

      const ackResponse = await new Promise((resolve) => {
        socket2.emit(SOCKET_EVENTS.CLIENT.BID_PLACE, { bidMinutes: 50 }, (ack) => {
          resolve(ack);
        });
      });

      assert.equal(ackResponse.success, false);
      assert.match(ackResponse.error.message, /already been placed by another team/i);

      const errData = await errorPromise;
      assert.match(errData.message, /already been placed by another team/i);
    } finally {
      socket1.disconnect();
      socket2.disconnect();
    }
  });

  it('team socket updates bid successfully and triggers bid:updated broadcast', async () => {
    const adminToken = await getAdminToken();
    const { token: team1Token, team: team1 } = await getTeamToken('Team Alpha');
    const { token: team2Token } = await getTeamToken('Team Beta');

    const prompt = await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });

    await api('/api/admin/round/start', { method: 'POST', token: adminToken });

    const socket1 = await connectSocket(team1Token);
    const socket2 = await connectSocket(team2Token);

    try {
      // Team 1 places initial bid of 60
      await new Promise((resolve) => {
        socket1.emit(SOCKET_EVENTS.CLIENT.BID_PLACE, { bidMinutes: 60 }, resolve);
      });

      const updateBroadcastPromise = new Promise((resolve) => {
        socket2.on(SOCKET_EVENTS.SERVER.BID_UPDATED, (data) => resolve(data));
      });

      // Team 1 updates bid to 40
      const ackResponse = await new Promise((resolve) => {
        socket1.emit(SOCKET_EVENTS.CLIENT.BID_UPDATE, { bidMinutes: 40 }, (ack) => {
          resolve(ack);
        });
      });

      assert.equal(ackResponse.success, true);
      assert.equal(ackResponse.bid.bidMinutes, 40);

      const broadcastData = await updateBroadcastPromise;
      assert.equal(broadcastData.teamId, team1.id);
      assert.equal(broadcastData.bidMinutes, 40);
      assert.equal(broadcastData.promptId, prompt.id);
    } finally {
      socket1.disconnect();
      socket2.disconnect();
    }
  });

  it('admin socket controls: start-round, pause, resume, extend, next-prompt, end-round', async () => {
    const adminToken = await getAdminToken();
    await createTeam('Team Alpha', 'pass123');
    await prisma.prompt.create({
      data: { title: 'P1', description: 'D1', displayOrder: 1 }
    });
    await prisma.prompt.create({
      data: { title: 'P2', description: 'D2', displayOrder: 2 }
    });

    const adminSocket = await connectSocket(adminToken);

    try {
      // 1. admin:start-round
      const startRes = await new Promise((resolve) => {
        adminSocket.emit(SOCKET_EVENTS.ADMIN.START_ROUND, { roundNumber: 1 }, resolve);
      });
      assert.equal(startRes.success, true);
      assert.equal(startRes.status, GAME_STATUS.BIDDING);

      // 2. admin:pause
      const pauseRes = await new Promise((resolve) => {
        adminSocket.emit(SOCKET_EVENTS.ADMIN.PAUSE, {}, resolve);
      });
      assert.equal(pauseRes.success, true);
      assert.equal(pauseRes.status, GAME_STATUS.PAUSED);

      // 3. admin:resume
      const resumeRes = await new Promise((resolve) => {
        adminSocket.emit(SOCKET_EVENTS.ADMIN.RESUME, {}, resolve);
      });
      assert.equal(resumeRes.success, true);
      assert.equal(resumeRes.status, GAME_STATUS.BIDDING);

      // 4. admin:extend
      const extendRes = await new Promise((resolve) => {
        adminSocket.emit(SOCKET_EVENTS.ADMIN.EXTEND, { extraSeconds: 20 }, resolve);
      });
      assert.equal(extendRes.success, true);
      assert.equal(extendRes.extraSeconds, 20);

      // 5. admin:next-prompt
      const nextRes = await new Promise((resolve) => {
        adminSocket.emit(SOCKET_EVENTS.ADMIN.NEXT_PROMPT, {}, resolve);
      });
      assert.equal(nextRes.success, true);
      assert.equal(nextRes.promptIndex, 1);

      // 6. admin:end-round
      const endRes = await new Promise((resolve) => {
        adminSocket.emit(SOCKET_EVENTS.ADMIN.END_ROUND, {}, resolve);
      });
      assert.equal(endRes.success, true);
      assert.equal(endRes.status, GAME_STATUS.ROUND_ENDED);
    } finally {
      adminSocket.disconnect();
    }
  });
});
