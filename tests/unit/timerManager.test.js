const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const timerManager = require('../../src/socket/timerManager');

beforeEach(() => {
  timerManager.resetTimer();
});

test('timerManager startTimer initializes correctly', () => {
  timerManager.startTimer({ seconds: 60, promptId: 10 });

  assert.equal(timerManager.getPromptId(), 10);
  assert.equal(timerManager.getSecondsRemaining(), 60);
  assert.equal(timerManager.isRunning(), true);
  assert.equal(timerManager.isTimerPaused(), false);
});

test('timerManager pause and resume work correctly', () => {
  timerManager.startTimer({ seconds: 50, promptId: 5 });

  const remainingAfterPause = timerManager.pauseTimer();
  assert.equal(remainingAfterPause, 50);
  assert.equal(timerManager.isRunning(), false);
  assert.equal(timerManager.isTimerPaused(), true);

  const remainingAfterResume = timerManager.resumeTimer();
  assert.equal(remainingAfterResume, 50);
  assert.equal(timerManager.isRunning(), true);
  assert.equal(timerManager.isTimerPaused(), false);
});

test('timerManager extendTimer adds seconds', () => {
  timerManager.startTimer({ seconds: 40, promptId: 1 });

  const newTotal = timerManager.extendTimer(20);
  assert.equal(newTotal, 60);
  assert.equal(timerManager.getSecondsRemaining(), 60);
});

test('timerManager stopTimer halts without wiping promptId', () => {
  timerManager.startTimer({ seconds: 30, promptId: 2 });
  timerManager.stopTimer();

  assert.equal(timerManager.isRunning(), false);
  assert.equal(timerManager.getPromptId(), 2);
});

test('timerManager resetTimer resets everything', () => {
  timerManager.startTimer({ seconds: 30, promptId: 2 });
  timerManager.resetTimer();

  assert.equal(timerManager.isRunning(), false);
  assert.equal(timerManager.getPromptId(), null);
  assert.equal(timerManager.getSecondsRemaining(), 0);
  assert.equal(timerManager.getEndsAt(), null);
  assert.equal(timerManager.getStartTime(), null);
});

test('timerManager records absolute startTime and endsAt', () => {
  const before = Date.now();
  timerManager.startTimer({ seconds: 45, promptId: 7 });
  const after = Date.now();

  assert.ok(timerManager.getStartTime() >= before);
  assert.ok(timerManager.getStartTime() <= after);
  assert.equal(timerManager.getEndsAt(), timerManager.getStartTime() + 45000);
  assert.equal(timerManager.getDurationSeconds(), 45);
  assert.equal(timerManager.hasExpired(), false);
});

test('timerManager extendTimer pushes endsAt forward by exact seconds', () => {
  timerManager.startTimer({ seconds: 30, promptId: 3 });
  const initialEndsAt = timerManager.getEndsAt();

  timerManager.extendTimer(15);
  assert.equal(timerManager.getEndsAt(), initialEndsAt + 15000);
  assert.equal(timerManager.getDurationSeconds(), 45);
});

test('timerManager pause and resume maintains remaining milliseconds and recalculates endsAt', async () => {
  timerManager.startTimer({ seconds: 20, promptId: 4 });
  const initialEndsAt = timerManager.getEndsAt();

  timerManager.pauseTimer();
  assert.equal(timerManager.isTimerPaused(), true);
  const remainingMs = timerManager.getRemainingMs();
  assert.ok(remainingMs > 0 && remainingMs <= 20000);

  // Resume after a tiny delay
  await new Promise((r) => setTimeout(r, 10));
  timerManager.resumeTimer();
  assert.equal(timerManager.isTimerPaused(), false);
  assert.ok(timerManager.getEndsAt() > initialEndsAt);
});

test('timerManager hasExpired detects expired vs non-expired state', () => {
  // Not started
  assert.equal(timerManager.hasExpired(), true);

  // Active future timer
  timerManager.startTimer({ seconds: 60, promptId: 1 });
  assert.equal(timerManager.hasExpired(), false);

  // Manually simulated expired timer
  timerManager.endsAt = Date.now() - 50;
  assert.equal(timerManager.hasExpired(), true);
  // With tolerance > 50ms, it is not expired
  assert.equal(timerManager.hasExpired(200), false);
});

test('timerManager getTimeDetails returns comprehensive snapshot', () => {
  timerManager.startTimer({ seconds: 30, promptId: 9 });
  const details = timerManager.getTimeDetails();

  assert.equal(details.promptId, 9);
  assert.equal(details.durationSeconds, 30);
  assert.equal(details.secondsRemaining, 30);
  assert.equal(details.isRunning, true);
  assert.equal(details.isPaused, false);
  assert.equal(details.hasExpired, false);
  assert.ok(typeof details.serverTime === 'number');
  assert.ok(typeof details.serverTimeIso === 'string');
  assert.ok(details.endsAt > details.serverTime);
  assert.ok(details.remainingMs > 0);
});

test('bidding countdown is unaffected by wall-clock changes', () => {
  let elapsed = 0;
  let wall = 1700000000000;
  const timer = new timerManager.TimerManager({ now: () => elapsed, wallNow: () => wall });
  timer.startTimer({ seconds: 60, promptId: 1 });
  elapsed = 12345;
  wall += 24 * 60 * 60 * 1000;
  assert.equal(timer.getRemainingMs(), 47655);
  assert.equal(timer.hasExpired(), false);
  wall -= 2 * 24 * 60 * 60 * 1000;
  elapsed = 60000;
  assert.equal(timer.getSecondsRemaining(), 0);
  assert.equal(timer.hasExpired(), true);
  timer.resetTimer();
});

test('pause, extension and resume preserve exact fractional remaining time and session identity', () => {
  let elapsed = 0;
  const timer = new timerManager.TimerManager({ now: () => elapsed, wallNow: () => 1700000000000 + elapsed });
  timer.startTimer({ seconds: 60, promptId: 1 });
  const id = timer.timerId;
  elapsed = 12345;
  timer.pauseTimer();
  elapsed += 100000;
  assert.equal(timer.getRemainingMs(), 47655);
  assert.equal(timer.getEndsAt(), null);
  timer.extendTimer(15);
  assert.equal(timer.getRemainingMs(), 62655);
  timer.resumeTimer();
  elapsed += 500;
  assert.equal(timer.getRemainingMs(), 62155);
  assert.equal(timer.timerId, id);
  timer.resetTimer();
});

test('timer expires once even when interval callbacks were delayed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let elapsed = 0;
  let expirations = 0;
  const timer = new timerManager.TimerManager({ now: () => elapsed });
  timer.startTimer({ seconds: 1, promptId: 1, onExpire: () => { expirations++; } });
  elapsed = 5000;
  t.mock.timers.tick(100);
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(expirations, 1);
  assert.equal(timer.isRunning(), false);
  assert.equal(timer.getSecondsRemaining(), 0);
  timer.resetTimer();
});
