const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setIO, getIO, broadcast, sendToTeam } = require('../../src/socket/emitter');

beforeEach(() => {
  setIO(null);
});

test('socket emitter getIO returns null by default', () => {
  assert.equal(getIO(), null);
});

test('socket emitter setIO and getIO store and retrieve the instance', () => {
  const fakeIO = { emit: () => {} };
  setIO(fakeIO);
  assert.equal(getIO(), fakeIO);
});

test('broadcast does not throw when ioInstance is not set', () => {
  assert.doesNotThrow(() => {
    broadcast('test:event', { foo: 'bar' });
  });
});

test('broadcast delegates to ioInstance.emit when set', () => {
  const emitted = [];
  const fakeIO = {
    emit: (event, data) => {
      emitted.push({ event, data });
    }
  };
  setIO(fakeIO);

  broadcast('game:status', { status: 'BIDDING' });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'game:status');
  assert.deepEqual(emitted[0].data, { status: 'BIDDING' });
});

test('sendToTeam does not throw when ioInstance is not set', () => {
  assert.doesNotThrow(() => {
    sendToTeam(42, 'assignment:received', { promptId: 1 });
  });
});

test('sendToTeam emits to team room when ioInstance is set', () => {
  const sent = [];
  const fakeIO = {
    to: (room) => ({
      emit: (event, data) => {
        sent.push({ room, event, data });
      }
    })
  };
  setIO(fakeIO);

  sendToTeam(7, 'score:received', { points: 100 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, 'team:7');
  assert.equal(sent[0].event, 'score:received');
  assert.deepEqual(sent[0].data, { points: 100 });
});

test('re-exported emitter functions on src/socket match src/socket/emitter', () => {
  const socketIndex = require('../../src/socket');
  assert.equal(typeof socketIndex.broadcast, 'function');
  assert.equal(typeof socketIndex.sendToTeam, 'function');
  assert.equal(typeof socketIndex.getIO, 'function');
  assert.equal(typeof socketIndex.setIO, 'function');
  assert.equal(typeof socketIndex.initSocket, 'function');
});

test('no circular dependency warnings or undefined exports when requiring socket before gameService', () => {
  const script = `
    const socket = require('./src/socket');
    const gameService = require('./src/services/gameService');
    if (typeof socket.broadcast !== 'function') throw new Error('socket.broadcast missing');
    if (typeof gameService.startRound !== 'function') throw new Error('gameService.startRound missing');
    console.log('OK');
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--trace-warnings', '-e',
    `process.on('warning', (warning) => { throw warning; }); ${script}`
  ], { stdio: 'inherit' }));
});

test('no circular dependency warnings or undefined exports when requiring gameService before socket', () => {
  const script = `
    const gameService = require('./src/services/gameService');
    const socket = require('./src/socket');
    const adminHandler = require('./src/socket/adminHandler');
    const bidHandler = require('./src/socket/bidHandler');
    if (typeof socket.broadcast !== 'function') throw new Error('socket.broadcast missing');
    if (typeof gameService.startRound !== 'function') throw new Error('gameService.startRound missing');
    if (typeof adminHandler !== 'function') throw new Error('adminHandler missing');
    if (typeof bidHandler !== 'function') throw new Error('bidHandler missing');
    console.log('OK');
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--trace-warnings', '-e',
    `process.on('warning', (warning) => { throw warning; }); ${script}`
  ], { stdio: 'inherit' }));
});
