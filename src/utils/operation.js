const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const ApiError = require('./apiError');
const env = require('../config/env');

const operations = new AsyncLocalStorage();
const timeoutError = () => {
  const error = new ApiError(503, 'The operation exceeded its time limit. Check the current state before retrying.');
  error.code = 'OPERATION_TIMEOUT';
  return error;
};
const assertOperationActive = () => {
  if (operations.getStore()?.deadline <= performance.now()) throw timeoutError();
};
const runOperation = (operation, timeoutMs = env.OPERATION_TIMEOUT_MS) => {
  if (operations.getStore()) return operation();
  return operations.run({ deadline: performance.now() + timeoutMs }, operation);
};
const bindOperation = (operation) => {
  const context = operations.getStore();
  return () => operations.run(context, () => { assertOperationActive(); return operation(); });
};
const operationContext = (req, res, next) => runOperation(next);
// Timers and durable background checkpoints outlive the request that created them.
const outsideOperation = (operation) => operations.exit(operation);

module.exports = { assertOperationActive, runOperation, bindOperation, operationContext, outsideOperation };
