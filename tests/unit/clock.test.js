const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getServerTime,
  getServerIsoTime,
  calculateClockSync,
  isPastDeadline
} = require('../../src/utils/clock');

test('getServerTime returns current timestamp in ms', () => {
  const before = Date.now();
  const time = getServerTime();
  const after = Date.now();

  assert.equal(typeof time, 'number');
  assert.ok(time >= before);
  assert.ok(time <= after);
});

test('getServerIsoTime returns a valid ISO 8601 string', () => {
  const iso = getServerIsoTime();
  assert.equal(typeof iso, 'string');
  const parsed = new Date(iso);
  assert.ok(!isNaN(parsed.getTime()));
});

test('calculateClockSync calculates NTP / Cristian metrics accurately', () => {
  const t0 = 1700000000000;
  const receiveTime = 1700000000050;
  const result = calculateClockSync({ clientTime: t0, receiveTime });

  assert.equal(result.clientTime, t0);
  assert.equal(result.serverReceiveTime, receiveTime);
  assert.ok(result.serverTransmitTime >= receiveTime);
  assert.equal(result.serverTime, result.serverTransmitTime);
  assert.equal(result.precision, 'millisecond');
  assert.ok(new Date(result.serverTimeIso).getTime() > 0);
});

test('calculateClockSync handles null or undefined clientTime gracefully', () => {
  const result = calculateClockSync();
  assert.equal(result.clientTime, null);
  assert.ok(typeof result.serverReceiveTime === 'number');
  assert.ok(typeof result.serverTransmitTime === 'number');
});

test('isPastDeadline evaluates correctly with and without tolerance', () => {
  const now = Date.now();

  // Future deadline
  assert.equal(isPastDeadline(now + 5000), false);

  // Past deadline
  assert.equal(isPastDeadline(now - 100), true);

  // Null or undefined deadline is considered passed
  assert.equal(isPastDeadline(null), true);
  assert.equal(isPastDeadline(undefined), true);

  // Deadline past by 50ms, but with 200ms tolerance: not yet past
  assert.equal(isPastDeadline(now - 50, 200), false);

  // Deadline past by 300ms, with 200ms tolerance: past
  assert.equal(isPastDeadline(now - 300, 200), true);
});
