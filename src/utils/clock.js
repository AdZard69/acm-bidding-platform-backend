/**
 * Server Clock Utility
 * Provides authoritative server time, NTP-style clock synchronization calculations,
 * and deadline / expiration validations for bidding.
 */

/**
 * Returns current server timestamp in milliseconds
 * @returns {number}
 */
const getServerTime = () => Date.now();

/**
 * Returns current server time formatted as ISO 8601 string
 * @returns {string}
 */
const getServerIsoTime = () => new Date().toISOString();

/**
 * Calculates Cristian's algorithm / NTP clock synchronization metrics.
 * 
 * t0: Client send time
 * t1: Server receive time
 * t2: Server transmit time
 * 
 * When client receives this response at t3:
 *   RTT = (t3 - t0) - (t2 - t1)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *   estimatedServerTimeNow = t3 + offset
 * 
 * @param {object} params
 * @param {number|null} [params.clientTime] - t0 from client
 * @param {number} [params.receiveTime] - t1 recorded on server
 * @returns {object}
 */
const calculateClockSync = ({ clientTime = null, receiveTime = Date.now() } = {}) => {
  const transmitTime = Date.now();
  const t0 = clientTime !== null && clientTime !== undefined ? Number(clientTime) : null;
  const t1 = Number(receiveTime) || transmitTime;
  const t2 = transmitTime;

  return {
    clientTime: t0,
    serverReceiveTime: t1,
    serverTransmitTime: t2,
    serverTime: t2,
    serverTimeIso: new Date(t2).toISOString(),
    precision: 'millisecond'
  };
};

/**
 * Checks whether a given deadline has passed according to server clock
 * @param {number|null|undefined} deadlineMs - Deadline in epoch milliseconds
 * @param {number} [toleranceMs=0] - Optional grace period in ms
 * @returns {boolean}
 */
const isPastDeadline = (deadlineMs, toleranceMs = 0) => {
  if (deadlineMs === null || deadlineMs === undefined) {
    return true;
  }
  const now = Date.now();
  const tolerance = Number(toleranceMs) || 0;
  return now >= (Number(deadlineMs) + tolerance);
};

module.exports = {
  getServerTime,
  getServerIsoTime,
  calculateClockSync,
  isPastDeadline
};
