const { test } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl } = require('../../src/config/databaseUrl');
const { createGameQueue } = require('../../src/services/gameLock');
const { runOperation, assertOperationActive } = require('../../src/utils/operation');
const { describeError } = require('../../src/middleware/errorHandler');
const profile = { DB_CONNECTION_LIMIT: 5, DB_CONNECT_TIMEOUT_SECONDS: 5, DB_POOL_TIMEOUT_SECONDS: 3, DB_QUERY_TIMEOUT_SECONDS: 3 };

test('PostgreSQL driver bounds connections, pool acquisition and SQL waits while retaining credentials and PgBouncer settings', () => {
  const original = new URL('postgresql://test:p%40ss@example.invalid:6543/test?pgbouncer=true&schema=public');
  const result = new URL(databaseUrl(original.toString(), profile));
  assert.equal(result.username, original.username);
  assert.equal(result.password, original.password);
  assert.equal(result.searchParams.get('pgbouncer'), 'true');
  assert.equal(result.searchParams.get('schema'), 'public');
  assert.equal(result.searchParams.get('connection_limit'), '5');
  assert.equal(result.searchParams.get('connect_timeout'), '5');
  assert.equal(result.searchParams.get('pool_timeout'), '3');
  assert.equal(result.searchParams.get('socket_timeout'), '3');
});

test('explicit connection settings are preserved and non-PostgreSQL URLs are unchanged', () => {
  const result = new URL(databaseUrl('postgresql://test:test@example.invalid/test?socket_timeout=7&connection_limit=2', profile));
  assert.equal(result.searchParams.get('socket_timeout'), '7');
  assert.equal(result.searchParams.get('connection_limit'), '2');
  assert.equal(databaseUrl('file:dev.db', profile), 'file:dev.db');
});

test('queued mutations expire without running later or releasing a still executing write', async () => {
  const queue = createGameQueue({ waitTimeoutMs: 15 });
  let release;
  let ran = false;
  const held = queue(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(queue(() => { ran = true; }), { code: 'GAME_BUSY', statusCode: 503 });
  assert.equal(ran, false);
  release();
  await held;
  assert.equal(await queue(() => 'healthy'), 'healthy');
  assert.equal(ran, false);
});

test('request deadline prevents a queued write from starting after its caller budget expires', async () => {
  const queue = createGameQueue({ waitTimeoutMs: 200 });
  let release;
  let ran = false;
  const held = queue(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const expired = runOperation(() => queue(() => { ran = true; }), 1);
  const check = assert.rejects(expired, { code: 'OPERATION_TIMEOUT', statusCode: 503 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await held;
  await check;
  assert.equal(ran, false);
});

test('one rejected operation does not poison the queue', async () => {
  const queue = createGameQueue();
  await assert.rejects(queue(() => { throw new Error('failed query'); }), /failed query/);
  assert.equal(await queue(() => 42), 42);
});

test('database middleware refuses further work after an operation deadline', async () => {
  await runOperation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.throws(assertOperationActive, { code: 'OPERATION_TIMEOUT' });
  }, 1);
});

test('Prisma timeout, connection, pool and missing-schema errors are actionable service errors', () => {
  for (const code of ['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2021', 'P2022']) {
    const result = describeError({ code, message: 'private database error' });
    assert.equal(result.statusCode, 503);
    assert.ok(!result.message.includes('private'));
    assert.equal(result.code, code);
  }
  assert.equal(describeError({ errorCode: 'P1001', message: 'initialization error' }).statusCode, 503);
});
