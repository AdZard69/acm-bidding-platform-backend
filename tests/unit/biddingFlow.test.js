const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryPrisma } = require('../helpers/memoryPrisma');
const database = createMemoryPrisma({ slotsPerPrompt: 1 });
const prismaPath = require.resolve('../../src/config/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: database };
const game = require('../../src/services/gameService');
const { submitBid } = require('../../src/services/bidService');
const controller = require('../../src/controllers/bidController');
const adminController = require('../../src/controllers/adminController');
const registerBids = require('../../src/socket/bidHandler');
const registerAdmin = require('../../src/socket/adminHandler');
const { authSocket } = require('../../src/middleware/authSocket');
const timer = require('../../src/socket/timerManager');
const { setIO } = require('../../src/socket/emitter');
const { runOperation, outsideOperation, assertOperationActive } = require('../../src/utils/operation');
let events;
const invoke = (handler, req = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { resolve(body); } };
  Promise.resolve(handler(req, res, reject)).catch(reject);
});
const socket = (user, register) => {
  const handlers = new Map();
  const result = { user, on: (event, handler) => handlers.set(event, handler) };
  register(null, result);
  return (event, data = {}) => new Promise((resolve, reject) => {
    Promise.resolve(handlers.get(event)(data, resolve)).catch(reject);
  });
};
const setup = async (teamCount = 3, promptCount = 3) => {
  if (!database.tables.admins.length) await database.admin.create({ data: { username: 'admin', password: 'test-hash' } });
  for (let i = 1; i <= teamCount; i++) await database.team.create({ data: { teamName: `Team ${i}` } });
  for (let i = 1; i <= promptCount; i++) await database.prompt.create({ data: { title: `Prompt ${i}`, description: `Description ${i}`, displayOrder: i } });
};
beforeEach(() => {
  timer.resetTimer();
  database.reset();
  events = [];
  setIO({ emit: (event, data) => events.push({ event, data }),
    to: (room) => ({ emit: (event, data) => events.push({ room, event, data }) }) });
});
afterEach(() => { timer.resetTimer(); setIO(null); });

test('HTTP and socket controls publish the same complete bidding snapshot to all viewers', async () => {
  await setup();
  const admin = socket({ adminId: 1, role: 'admin' }, registerAdmin);
  const started = await invoke(adminController.startRound, { auth: { adminId: 1 }, body: { roundNumber: 1 } });
  assert.equal(started.status, 'bidding');
  assert.equal(started.currentPrompt.id, 1);
  assert.ok(started.timerId);
  assert.equal(started.secondsRemaining, 60);
  const paused = await admin('admin:pause');
  assert.equal(paused.success, true);
  const extended = await invoke(adminController.extendRound, { auth: { adminId: 1 }, body: { extraSeconds: 15 } });
  assert.equal(extended.isPaused, true);
  assert.equal(extended.endsAt, null);
  assert.ok(extended.remainingMs > 74000);
  assert.equal(extended.durationSeconds, 75);
  const snapshot = events.filter((event) => event.event === 'game:status').at(-1).data;
  assert.equal(snapshot.remainingMs, extended.remainingMs);
  assert.equal(snapshot.timerId, started.timerId);
  assert.deepEqual(snapshot.currentPrompt, started.currentPrompt);
  const resumed = await admin('admin:resume');
  assert.equal(resumed.status, 'bidding');
  assert.equal(resumed.timerId, started.timerId);
  assert.ok(resumed.remainingMs > 74000);
});

test('concurrent HTTP and WebSocket bids accept one unique value with the same error contract', async () => {
  await setup();
  const state = await game.startRound(1);
  const team = socket({ teamId: 2, role: 'team' }, registerBids);
  const input = { bidMinutes: 45, promptId: 1, round: 1, timerId: state.timerId };
  const results = await Promise.allSettled([
    invoke(controller.placeBid, { auth: { teamId: 1 }, body: input }), team('bid:place', input)
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.success, true);
  assert.equal(results[1].value.success, false);
  assert.match(results[1].value.error.message, /already bid/);
  assert.equal(database.tables.bids.length, 1);
  assert.equal(events.filter((e) => e.event === 'bid:new').length, 1);
  const update = await invoke(controller.updateBid, { auth: { teamId: 1 }, body: { ...input, bidMinutes: 50 } });
  assert.equal(update.bid.bidMinutes, 50);
  assert.equal(events.filter((e) => e.event === 'bid:updated').length, 1);
});

test('bids crossing the deadline during a database read are rejected', async () => {
  await setup();
  await game.startRound(1);
  const original = database.bid.findUnique;
  database.bid.findUnique = async (args) => {
    timer.endsAt = Date.now() - 1;
    return original.call(database.bid, args);
  };
  try {
    await assert.rejects(submitBid(1, { bidMinutes: 45 }), /expired/);
    assert.equal(database.tables.bids.length, 0);
  } finally { database.bid.findUnique = original; }
});

test('paused, inactive, assigned and mismatched-session bids are rejected on both transports', async () => {
  await setup();
  const started = await game.startRound(1);
  const team = socket({ teamId: 1, role: 'team' }, registerBids);
  await game.pauseRound();
  await assert.rejects(submitBid(1, { bidMinutes: 45 }), /paused/);
  assert.match((await team('bid:place', { bidMinutes: 45 })).error.message, /paused/);
  await game.resumeRound();
  for (const mismatch of [{ promptId: 99 }, { round: 2 }, { timerId: 'old-session' }]) {
    await assert.rejects(submitBid(1, { bidMinutes: 45, ...mismatch }), /changed/);
  }
  await database.team.update({ where: { id: 1 }, data: { isActive: false } });
  await assert.rejects(submitBid(1, { bidMinutes: 45 }), /deactivated/);
  assert.ok(started.timerId);
});

test('manually progressing prompts within round 1 preserves round 1 identity and multiplier curve', async () => {
  await setup(4, 3);
  let state = await game.startRound(1);
  for (let promptIdx = 1; promptIdx <= 3; promptIdx++) {
    assert.equal(state.currentRound, 1);
    assert.equal(state.currentPrompt.id, promptIdx);
    await submitBid(promptIdx, { bidMinutes: 45, promptId: promptIdx, round: 1, timerId: state.timerId });
    assert.equal(database.tables.bids.at(-1).round, 1);
    state = await game.nextPrompt();
    if (promptIdx < 3) {
      assert.equal(state.currentRound, 1);
      assert.equal(state.currentPrompt.id, promptIdx + 1);
      assert.deepEqual(state.bids, []);
    }
  }
  assert.equal(state.status, 'round_ended');
  assert.equal(state.currentPrompt.id, 3);
  assert.equal(database.tables.assignments.length, 3);
  assert.ok(database.tables.assignments.every((assignment) => assignment.round === 1 && Number(assignment.multiplier) === 1.868));
});

test('queued duplicate next-prompt commands cannot skip two prompts', async () => {
  await setup();
  await game.startRound(1);
  const results = await Promise.allSettled([game.nextPrompt(), game.nextPrompt()]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal((await game.getCurrentBiddingState()).currentPrompt.id, 2);
});

test('restart recovery restores a paused extension and resumes the same session', async () => {
  await setup();
  const initial = await game.startRound(1);
  await game.pauseRound();
  const extended = await game.extendRound(20);
  timer.resetTimer(); // Simulates loss of the process timer while the database survives.
  const restored = await game.getCurrentBiddingState();
  assert.equal(restored.timerId, initial.timerId);
  assert.equal(restored.remainingMs, extended.remainingMs);
  assert.equal(restored.status, 'paused');
  assert.equal((await game.resumeRound()).timerId, initial.timerId);
});

test('restart recovery consumes downtime for a running timer', async () => {
  await setup();
  const initial = await game.startRound(1);
  database.tables.config[0].biddingState.timer.savedAt -= 10000;
  timer.resetTimer();
  const restored = await game.getCurrentBiddingState();
  assert.equal(restored.timerId, initial.timerId);
  assert.ok(restored.remainingMs > 49000 && restored.remainingMs <= 50000);
});

test('assignment and score refresh returns numeric values and reset clears all views', async () => {
  await setup(2, 1);
  const config = await game.getOrCreateGameConfig();
  await database.gameConfig.update({ where: { id: config.id }, data: { slotsPerPrompt: 3 } });
  await game.startRound(1);
  await submitBid(1, { bidMinutes: 45 });
  await game.nextPrompt();
  const autoAssignment = events.find((event) => event.room === 'team:2' && event.event === 'assignment:received');
  assert.equal(autoAssignment.data.round, 1);
  await database.score.create({ data: { teamId: 1, judgeScore: 80, multiplier: '1.5', finalScore: '120' } });
  const personal = await invoke(controller.getMyAssignment, { auth: { teamId: 1 } });
  assert.equal(typeof personal.assignment.multiplier, 'number');
  assert.equal(personal.score.finalScore, 120);
  const ended = await game.getCurrentBiddingState();
  assert.equal(ended.currentPrompt.id, 1);
  assert.equal(ended.endsAt, null);
  assert.equal(ended.secondsRemaining, 0);
  await invoke(adminController.resetGame, { auth: { adminId: 1 }, body: {} });
  // Wait for the controller's ordered post-mutation snapshot.
  const reset = await game.getCurrentBiddingState();
  assert.equal(reset.status, 'waiting');
  assert.equal(reset.timerId, null);
  assert.deepEqual(reset.bids, []);
  assert.equal((await invoke(controller.getMyAssignment, { auth: { teamId: 1 } })).assignment, null);
});

test('public arena sockets are spectators and have no mutation handlers', () => {
  const spectator = { handshake: { auth: {}, headers: {} } };
  let error;
  authSocket(spectator, (err) => { error = err; });
  assert.equal(error, undefined);
  assert.equal(spectator.user.role, 'spectator');
  authSocket({ handshake: { auth: { token: 'invalid' }, headers: {} } }, (err) => { error = err; });
  assert.match(error.message, /Invalid authentication/);
});


test('expiry closes the round and retains its prompt and bids until an admin clicks Next', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await setup();
  const initial = await game.startRound(1);
  await submitBid(1, { bidMinutes: 45 });
  timer.endsAt = Date.now() - 1;
  t.mock.timers.tick(100);
  await Promise.resolve();
  const closed = await game.getCurrentBiddingState();
  assert.equal(closed.currentPrompt.id, 1);
  assert.equal(closed.currentRound, 1);
  assert.equal(closed.status, 'round_ended');
  assert.equal(closed.timerId, initial.timerId);
  assert.equal(closed.secondsRemaining, 0);
  assert.equal(closed.bids.length, 1);
  assert.equal(closed.winners[0].teamId, 1);
  assert.equal(database.tables.assignments.length, 1);
  assert.equal(events.filter((event) => event.event === 'prompt:next').length, 0);
  await assert.rejects(submitBid(2, { bidMinutes: 50 }), /closed/);
  t.mock.timers.tick(10000);
  assert.equal((await game.getCurrentBiddingState()).currentPrompt.id, 1);
  timer.resetTimer();
  const restored = await game.getCurrentBiddingState();
  assert.equal(restored.timerId, initial.timerId);
  assert.equal(restored.status, 'round_ended');
  assert.equal(restored.winners[0].teamId, 1);
  const next = await game.nextPrompt(null, initial.timerId);
  assert.equal(next.currentPrompt.id, 2);
  assert.equal(next.currentRound, 1);
  assert.notEqual(next.timerId, initial.timerId);
  assert.equal(next.secondsRemaining, 60);
  assert.equal(database.tables.assignments.length, 1);
});

test('admin bid history restores losing bids across prompts with team and prompt context', async () => {
  await setup();
  await game.startRound(1);
  await submitBid(1, { bidMinutes: 40 });
  await submitBid(2, { bidMinutes: 45 });
  await game.nextPrompt();
  await submitBid(2, { bidMinutes: 50 });
  const history = await invoke(adminController.listBids);
  assert.equal(history.bids.length, 3);
  assert.deepEqual(history.bids.filter((bid) => bid.teamId === 2).map((bid) => bid.promptId), [1, 2]);
  assert.equal(history.bids[0].teamName, 'Team 1');
  assert.equal(history.bids[0].prompt.title, 'Prompt 1');
});


test('a failed timer save keeps status and countdown at the last published state', async () => {
  await setup();
  const initial = await game.startRound(1);
  const original = database.gameConfig.update;
  const eventCount = events.length;
  database.gameConfig.update = async () => { throw new Error('database unavailable'); };
  try {
    await assert.rejects(game.pauseRound(), /database unavailable/);
    assert.equal(timer.isRunning(), true);
    assert.equal(timer.timerId, initial.timerId);
    assert.equal(database.tables.config[0].status, 'bidding');
    assert.equal(events.length, eventCount);
  } finally { database.gameConfig.update = original; }
  await game.pauseRound();
  const before = timer.getRemainingMs();
  database.gameConfig.update = async () => { throw new Error('database unavailable'); };
  try {
    await assert.rejects(game.extendRound(30), /database unavailable/);
    assert.equal(timer.isTimerPaused(), true);
    assert.equal(timer.getRemainingMs(), before);
  } finally { database.gameConfig.update = original; }
});


test('admin bid history filters bids by round (1 or 2)', async () => {
  await setup();
  await database.bid.create({ data: { teamId: 1, promptId: 1, round: 1, bidMinutes: 40 } });
  await database.bid.create({ data: { teamId: 2, promptId: 2, round: 1, bidMinutes: 45 } });
  await database.bid.create({ data: { teamId: 3, promptId: 1, round: 2, bidMinutes: 50 } });
  const allBids = await invoke(adminController.listBids);
  assert.equal(allBids.bids.length, 3);
  const round1 = await invoke(adminController.listBids, { query: { round: '1' } });
  assert.equal(round1.bids.length, 2);
  const round2 = await invoke(adminController.listBids, { query: { round: '2' } });
  assert.equal(round2.bids.length, 1);
  assert.equal(round2.bids[0].promptId, 1);
  assert.equal(round2.bids[0].round, 2);
});

test('round 2 requires round 1 to have been completed and unassigned teams to exist', async () => {
  await setup(2, 3);
  // Starting round 2 before round 1 throws 400
  await assert.rejects(game.startRound(2), /Round 1 must be completed/);

  // Complete round 1 with 1 winner
  const round1 = await game.startRound(1);
  await submitBid(1, { bidMinutes: 45, promptId: 1, round: 1, timerId: round1.timerId });
  await game.endRound();

  // Round 2 can now be started since team 2 is unassigned
  const round2 = await game.startRound(2);
  assert.equal(round2.currentRound, 2);
  assert.equal(round2.status, 'bidding');
});

test('rerunning a round assigns null to all winners of that round, clears their bids/scores, and restarts bidding', async () => {
  await setup(3, 3);
  const round1 = await game.startRound(1);
  assert.equal(round1.currentRound, 1);
  await submitBid(1, { bidMinutes: 40, promptId: 1, round: 1, timerId: round1.timerId });
  await submitBid(2, { bidMinutes: 50, promptId: 1, round: 1, timerId: round1.timerId });

  const ended = await game.endRound();
  assert.equal(ended.status, 'round_ended');
  assert.equal(ended.winners.length, 1);
  assert.equal(ended.winners[0].teamId, 1);

  const team1Before = await invoke(controller.getMyAssignment, { auth: { teamId: 1 } });
  assert.ok(team1Before.assignment);
  assert.equal(team1Before.assignment.promptId, 1);
  const team2Before = await invoke(controller.getMyAssignment, { auth: { teamId: 2 } });
  assert.equal(team2Before.assignment, null);

  await database.score.create({ data: { teamId: 1, judgeScore: 85, multiplier: 1.8, finalScore: 153 } });
  assert.equal(database.tables.scores.length, 1);

  const rerun = await invoke(adminController.rerunRound, { auth: { adminId: 1 }, body: { round: 1 } });
  assert.equal(rerun.status, 'bidding');
  assert.equal(rerun.currentRound, 1);
  assert.equal(rerun.currentPrompt.id, 1);
  assert.deepEqual(rerun.resetWinners, [1]);

  // Key requirement: all winners of that round are assigned null!
  const team1After = await invoke(controller.getMyAssignment, { auth: { teamId: 1 } });
  assert.equal(team1After.assignment, null);
  const team2After = await invoke(controller.getMyAssignment, { auth: { teamId: 2 } });
  assert.equal(team2After.assignment, null);

  assert.equal(database.tables.assignments.length, 0);
  assert.equal(database.tables.scores.length, 0);
  assert.equal(database.tables.bids.length, 0);

  await submitBid(1, { bidMinutes: 45, promptId: 1, round: 1, timerId: rerun.timerId });
  assert.equal(database.tables.bids.length, 1);
  assert.equal(database.tables.bids[0].bidMinutes, 45);

  const nullAssignmentEvent = events.filter((e) => e.room === 'team:1' && e.event === 'assignment:received').at(-1);
  assert.ok(nullAssignmentEvent);
  assert.equal(nullAssignmentEvent.data, null);
});

test('socket admin can rerun round via admin:rerun-round', async () => {
  await setup(2, 2);
  const admin = socket({ adminId: 1, role: 'admin' }, registerAdmin);
  await game.startRound(1);
  await submitBid(1, { bidMinutes: 50 });
  await game.endRound();
  assert.equal(database.tables.assignments.length, 1);

  const res = await admin('admin:rerun-round', { roundNumber: 1 });
  assert.equal(res.success, true);
  assert.equal(res.status, 'bidding');
  assert.equal(database.tables.assignments.length, 0);
});

test('slow display-data reads do not consume the initial countdown on start or rerun', async () => {
  await setup();
  const originalNow = timer.now;
  let elapsed = 0;
  timer.now = () => elapsed;
  database.onQuery = ({ model, action }) => {
    if ((model === 'bids' && action === 'findMany') || (model === 'assignments' && action === 'count')) elapsed += 6000;
  };
  try {
    const started = await game.startRound(1);
    assert.equal(started.secondsRemaining, 60);
    await game.endRound();
    events.length = 0;
    const rerun = await game.rerunRound(1);
    assert.equal(rerun.secondsRemaining, 60);
    assert.equal(rerun.remainingMs, 60000);
    assert.notEqual(rerun.timerId, started.timerId);
    const published = events.filter((event) => event.event === 'game:status');
    assert.equal(published.length, 1);
    assert.equal(published[0].data.remainingMs, 60000);
    assert.deepEqual(published[0].data.bids, []);
    assert.equal(published[0].data.status, 'bidding');
    assert.equal(published[0].data.currentPrompt.id, 1);
    assert.equal(events.filter((event) => event.event === 'round:started').length, 1);
  } finally {
    timer.resetTimer();
    timer.now = originalNow;
    database.onQuery = null;
  }
});

test('a 20-second preparation save does not consume bidding time on start or rerun', async () => {
  await setup();
  const originalNow = timer.now;
  const originalWall = timer.wallNow;
  let elapsed = 0;
  timer.now = () => elapsed;
  timer.wallNow = () => 1700000000000 + elapsed;
  database.onQuery = ({ model, action, args }) => {
    if (model === 'config' && action === 'update' && args.data.biddingState?.timer.pendingStart) {
      assert.equal(timer.isRunning(), false);
      assert.equal(timer.getSecondsRemaining(), 60);
      elapsed += 20000;
    }
  };
  try {
    for (const start of [() => game.startRound(1), () => game.rerunRound(1)]) {
      const state = await start();
      assert.equal(state.secondsRemaining, 60);
      assert.equal(state.remainingMs, 60000);
      assert.equal(state.startTime, timer.wallNow());
      assert.equal(state.endsAt, timer.wallNow() + 60000);
      assert.equal(events.findLast((event) => event.event === 'round:started').data.secondsRemaining, 60);
      assert.equal(timer.isRunning(), true);
      elapsed += 1000;
      assert.equal(timer.getSecondsRemaining(), 59);
    }
  } finally {
    timer.resetTimer();
    timer.now = originalNow;
    timer.wallNow = originalWall;
  }
});

test('start publication and bid acceptance do not wait for audit or activation checkpoint writes', async () => {
  await setup();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  database.onQuery = ({ model, action }) => {
    if ((model === 'logs' && action === 'create') || (model === 'config' && action === 'updateMany')) return held;
  };
  try {
    const state = await game.startRound(1);
    assert.equal(state.secondsRemaining, 60);
    assert.equal((await submitBid(1, { bidMinutes: 45, timerId: state.timerId })).success, true);
    assert.equal(database.tables.logs.length, 0);
  } finally {
    release();
    for (let i = 0; i < 15; i++) await Promise.resolve();
  }
});

test('an activation checkpoint arriving after pause cannot overwrite the paused timer', async () => {
  await setup();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  database.onQuery = ({ model, action }) => model === 'config' && action === 'updateMany' ? held : undefined;
  try {
    const state = await game.startRound(1);
    const paused = await game.pauseRound();
    release();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    const saved = database.tables.config[0];
    assert.equal(saved.status, 'paused');
    assert.equal(saved.biddingState.timer.isPaused, true);
    assert.equal(saved.biddingState.timer.timerId, state.timerId);
    assert.equal(saved.biddingState.timer.remainingMs, paused.remainingMs);
  } finally { release(); }
});

test('resume retains its exact paused time despite a 20-second save', async () => {
  await setup();
  const originalNow = timer.now;
  const originalWall = timer.wallNow;
  let elapsed = 0;
  timer.now = () => elapsed;
  timer.wallNow = () => 1700000000000 + elapsed;
  try {
    const started = await game.startRound(1);
    elapsed = 12345;
    const paused = await game.pauseRound();
    database.onQuery = ({ model, action, args }) => {
      if (model === 'config' && action === 'update' && args.data.biddingState?.timer.pendingStart) elapsed += 20000;
    };
    const resumed = await game.resumeRound();
    assert.equal(resumed.remainingMs, paused.remainingMs);
    assert.equal(resumed.remainingMs, 47655);
    assert.equal(resumed.timerId, started.timerId);
    assert.equal(resumed.startTime, started.startTime);
    assert.equal(resumed.isPaused, false);
    elapsed += 47655;
    assert.equal(timer.hasExpired(), true);
  } finally { timer.resetTimer(); timer.now = originalNow; timer.wallNow = originalWall; }
});

test('a queued old expiry does not close a timer that the admin just extended', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await setup();
  const originalNow = timer.now;
  let elapsed = 0;
  timer.now = () => elapsed;
  try {
    const started = await game.startRound(1);
    elapsed = 60000;
    t.mock.timers.tick(100);
    // Enqueue the extension before the timer's asynchronous expiry callback.
    await game.extendRound(15);
    const state = await game.getCurrentBiddingState();
    assert.equal(state.status, 'bidding');
    assert.equal(state.timerId, started.timerId);
    assert.equal(state.secondsRemaining, 15);
    assert.equal(events.filter((event) => event.event === 'round:ended').length, 0);
    await submitBid(1, { bidMinutes: 45, timerId: state.timerId });
  } finally { timer.resetTimer(); timer.now = originalNow; }
});

test('a restart before the activation checkpoint recovers frozen instead of inventing a deadline', async () => {
  await setup();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  database.onQuery = ({ model, action }) => model === 'config' && action === 'updateMany' ? held : undefined;
  try {
    const started = await game.startRound(1);
    assert.equal(database.tables.config[0].biddingState.timer.pendingStart, true);
    timer.resetTimer();
    const restored = await game.getCurrentBiddingState();
    assert.equal(restored.timerId, started.timerId);
    assert.equal(restored.status, 'paused');
    assert.equal(restored.remainingMs, 60000);
    release();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(database.tables.config[0].status, 'paused');
    assert.equal(database.tables.config[0].biddingState.timer.isPaused, true);
  } finally { release(); }
});

test('server expiry outlives the start request and rejects client-supplied extra time', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await setup();
  const originalNow = timer.now;
  let elapsed = 0;
  timer.now = () => elapsed;
  database.onQuery = () => assertOperationActive();
  try {
    await runOperation(async () => {
      const state = await game.startRound(1);
      // The displayed countdown is never trusted by either bid transport.
      await submitBid(1, { bidMinutes: 45, remainingMs: 0, secondsRemaining: 0 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.throws(assertOperationActive, { code: 'OPERATION_TIMEOUT' });
      elapsed = 60000;
      t.mock.timers.tick(100);
      await Promise.resolve();
      const closed = await outsideOperation(() => game.getCurrentBiddingState());
      assert.equal(closed.status, 'round_ended');
      assert.equal(closed.timerId, state.timerId);
      assert.equal(closed.winners[0].teamId, 1);
      await outsideOperation(() => assert.rejects(submitBid(2, {
        bidMinutes: 50, remainingMs: 60000, secondsRemaining: 60, endsAt: Date.now() + 60000
      }), /closed|expired/));
    }, 50);
  } finally { timer.resetTimer(); timer.now = originalNow; }
});

test('rerunning round 1 resets all round 1 winners and their scores', async () => {
  await setup(3, 3);
  await game.startRound(1);
  await game.endRound();
  for (const id of [1, 2]) {
    await database.bid.create({ data: { teamId: id, promptId: id, round: 1, bidMinutes: 40 + id } });
    await database.assignment.create({ data: { teamId: id, promptId: id, round: 1, bidMinutes: 40 + id, multiplier: 1.5 } });
    await database.score.create({ data: { teamId: id, judgeScore: 80, multiplier: 1.5, finalScore: 120 } });
  }
  const state = await game.rerunRound(1);
  assert.deepEqual(state.resetWinners.sort(), [1, 2]);
  for (const table of ['bids', 'assignments', 'scores']) {
    assert.equal(database.tables[table].length, 0);
  }
  const cleared = events.findLast((event) => event.event === 'assignment:received' && event.room === 'team:1');
  assert.equal(cleared.data, null);
  await submitBid(1, { bidMinutes: 45, timerId: state.timerId });
});

test('a rerun reset failure rolls back deleted data and keeps the current countdown', async () => {
  await setup();
  const started = await game.startRound(1);
  await database.assignment.create({ data: { teamId: 1, promptId: 1, round: 1, bidMinutes: 40, multiplier: 1.5 } });
  await database.score.create({ data: { teamId: 1, judgeScore: 80, multiplier: 1.5, finalScore: 120 } });
  database.onQuery = ({ model, action }) => {
    if (model === 'bids' && action === 'deleteMany') throw new Error('reset failed');
  };
  await assert.rejects(game.rerunRound(1), /reset failed/);
  assert.equal(database.tables.assignments.length, 1);
  assert.equal(database.tables.scores.length, 1);
  assert.equal(timer.timerId, started.timerId);
  assert.equal(timer.isRunning(), true);
});

test('rerunning round 2 resets only round 2 winners and preserves round 1 winners and bids', async () => {
  await setup(3, 3);
  // Round 1
  const round1 = await game.startRound(1);
  await submitBid(1, { bidMinutes: 40, promptId: 1, round: 1, timerId: round1.timerId });
  await submitBid(2, { bidMinutes: 50, promptId: 1, round: 1, timerId: round1.timerId });
  const ended1 = await game.endRound();
  assert.equal(ended1.winners[0].teamId, 1);

  // Round 2
  const round2 = await game.startRound(2);
  await submitBid(2, { bidMinutes: 45, promptId: 2, round: 2, timerId: round2.timerId });
  await submitBid(3, { bidMinutes: 55, promptId: 2, round: 2, timerId: round2.timerId });
  const ended2 = await game.endRound();
  assert.equal(ended2.winners[0].teamId, 2);

  // Create scores for both teams (e.g. from judges)
  await database.tables.scores.push(
    { id: 1, teamId: 1, judgeScore: 80, multiplier: 1.5, finalScore: 120 },
    { id: 2, teamId: 2, judgeScore: 90, multiplier: 1.5, finalScore: 135 }
  );

  // Both team 1 (round 1) and team 2 (round 2) have assignments and scores
  assert.equal(database.tables.assignments.length, 2);
  assert.equal(database.tables.scores.length, 2);
  assert.equal(database.tables.bids.length, 4);

  // Rerun ONLY Round 2
  const rerun = await game.rerunRound(2);
  assert.equal(rerun.status, 'bidding');
  assert.equal(rerun.currentRound, 2);
  assert.deepEqual(rerun.resetWinners, [2]);

  // Team 1 (round 1 winner) is untouched
  const team1After = await invoke(controller.getMyAssignment, { auth: { teamId: 1 } });
  assert.ok(team1After.assignment);
  assert.equal(team1After.assignment.round, 1);
  assert.equal(team1After.assignment.promptId, 1);

  // Team 2 (round 2 winner) is reset to null
  const team2After = await invoke(controller.getMyAssignment, { auth: { teamId: 2 } });
  assert.equal(team2After.assignment, null);

  // Assignments in DB: only team 1 remains
  assert.equal(database.tables.assignments.length, 1);
  assert.equal(database.tables.assignments[0].teamId, 1);

  // Scores in DB: only team 1 score remains (team 2 score deleted)
  assert.equal(database.tables.scores.length, 1);
  assert.equal(database.tables.scores[0].teamId, 1);

  // Bids in DB: only round 1 bids remain (2 bids)
  assert.equal(database.tables.bids.length, 2);
  assert.ok(database.tables.bids.every((b) => b.round === 1));

  // Team 2 can now bid in rerun round 2
  await submitBid(2, { bidMinutes: 42, promptId: 2, round: 2, timerId: rerun.timerId });
  assert.equal(database.tables.bids.length, 3);

  // Team 1 still cannot bid because they won round 1
  await assert.rejects(
    submitBid(1, { bidMinutes: 35, promptId: 2, round: 2, timerId: rerun.timerId }),
    /already has an assigned prompt/
  );
});
