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
});
