const prisma = require('../config/prisma');
const gameService = require('./gameService');
const timerManager = require('../socket/timerManager');
const { withGameLock } = require('./gameLock');
const { broadcast } = require('../socket/emitter');
const ApiError = require('../utils/apiError');
const { isIntegerInput } = require('../utils/validators');

// HTTP and Socket.IO use the same validation, deadline and write ordering.
const submitBid = (teamId, input = {}) => withGameLock(async () => {
  if (!teamId) throw new ApiError(401, 'Team identity missing');
  const minutes = Number(input.bidMinutes);
  if (!isIntegerInput(input.bidMinutes)) throw new ApiError(400, 'bidMinutes must be an integer');
  const config = await gameService.ensureTimer(await gameService.getActiveGameConfig());
  if (config.status === 'paused') throw new ApiError(400, 'Bidding is currently paused');
  if (config.status !== 'bidding') throw new ApiError(400, 'Bidding is closed');
  if (timerManager.hasExpired()) throw new ApiError(400, 'Bidding time has expired for this prompt');
  if (minutes < config.minBid || minutes > config.baseTime)
    throw new ApiError(400, `Bid must be between ${config.minBid} and ${config.baseTime} minutes`);
  const promptId = timerManager.getPromptId();
  if ((input.promptId != null && Number(input.promptId) !== promptId) ||
      (input.round != null && Number(input.round) !== config.currentRound) ||
      (input.timerId != null && input.timerId !== timerManager.timerId))
    throw new ApiError(409, 'The active prompt or bidding session has changed. Refresh and bid again.');
  const team = await prisma.team.findUnique({ where: { id: teamId }, include: { assignment: true } });
  if (!team || !team.isActive) throw new ApiError(403, 'Team account is deactivated or not found');
  if (team.assignment) throw new ApiError(400, 'Team already has an assigned prompt');
  const key = { teamId, promptId, round: config.currentRound };
  const previous = await prisma.bid.findUnique({ where: { teamId_promptId_round: key } });
  // Re-check immediately before accepting: database reads may have crossed expiry.
  if (timerManager.hasExpired()) throw new ApiError(400, 'Bidding time has expired for this prompt');
  const submittedAt = new Date();
  let bid;
  try {
    bid = await prisma.bid.upsert({
      where: { teamId_promptId_round: key },
      update: { bidMinutes: minutes, submittedAt },
      create: { ...key, bidMinutes: minutes, submittedAt }
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, `Another team has already bid ${minutes} minutes. Pick another value.`);
    throw err;
  }
  const data = { ...bid, round: config.currentRound, teamName: team.teamName, serverTime: Date.now(), timerId: timerManager.timerId };
  broadcast(previous ? 'bid:updated' : 'bid:new', data);
  return { success: true, message: previous ? 'Bid updated successfully' : 'Bid placed successfully', bid: data, serverTime: Date.now() };
});

module.exports = { submitBid };
