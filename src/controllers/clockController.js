const { calculateClockSync } = require('../utils/clock');
const gameService = require('../services/gameService');

/**
 * Returns current authoritative server clock and active bidding round timer status.
 * Public endpoint for UI synchronization and initial load.
 */
const getClockStatus = async (req, res, next) => {
  try {
    const state = await gameService.getCurrentBiddingState();
    res.setHeader('Cache-Control', 'no-store');

    res.status(200).json({
      success: true,
      serverTime: state.serverTime,
      serverTimeIso: state.serverTimeIso,
      uptime: process.uptime(),
      timezone: 'UTC',
      bidding: { ...state, activePromptId: state.promptId }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Cristian's / NTP clock synchronization endpoint.
 * Echoes back clientSendTime and server timestamps for RTT and clock offset calculation.
 */
const syncClock = (req, res, next) => {
  try {
    const receiveTime = req._receiveTime || Date.now();
    const clientTime = req.query.clientTime ?? req.query.t0 ?? req.body?.clientTime ?? req.body?.t0 ?? null;
    const syncData = calculateClockSync({ clientTime, receiveTime });
    res.setHeader('Cache-Control', 'no-store');

    res.status(200).json({
      success: true,
      ...syncData
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getClockStatus,
  syncClock
};
