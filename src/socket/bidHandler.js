const prisma = require('../config/prisma');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const logger = require('../utils/logger');
const gameService = require('../services/gameService');

/**
 * Registers team client socket event handlers for live bidding
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
const registerBidHandlers = (io, socket) => {
  const teamId = socket.user?.teamId;

  socket.on(SOCKET_EVENTS.CLIENT.BID_PLACE, async (data, ack) => {
    try {
      if (!teamId) {
        if (typeof ack === 'function') ack({ success: false, error: { message: 'Unauthorized' } });
        return;
      }

      const minutes = Number(data?.bidMinutes);
      if (!Number.isInteger(minutes) || isNaN(minutes)) {
        if (typeof ack === 'function') ack({ success: false, error: { message: 'bidMinutes must be an integer' } });
        return;
      }

      const config = await gameService.getOrCreateGameConfig();
      if (config.status !== GAME_STATUS.BIDDING) {
        if (typeof ack === 'function') ack({ success: false, error: { message: 'Bidding is closed' } });
        return;
      }

      if (minutes < config.minBid || minutes > config.baseTime) {
        if (typeof ack === 'function') ack({ success: false, error: { message: `Bid must be between ${config.minBid} and ${config.baseTime}` } });
        return;
      }

      const team = await prisma.team.findUnique({
        where: { id: teamId },
        include: { assignment: true }
      });

      if (!team || !team.isActive || team.assignment) {
        if (typeof ack === 'function') ack({ success: false, error: { message: 'Team cannot bid' } });
        return;
      }

      const eligiblePrompts = await gameService.getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
      const currentPrompt = eligiblePrompts[config.currentPromptIndex];
      if (!currentPrompt) {
        if (typeof ack === 'function') ack({ success: false, error: { message: 'No active prompt' } });
        return;
      }

      // Check collision
      const collision = await prisma.bid.findFirst({
        where: {
          promptId: currentPrompt.id,
          round: config.currentRound,
          bidMinutes: minutes,
          teamId: { not: teamId }
        }
      });

      if (collision) {
        if (typeof ack === 'function') ack({ success: false, error: { message: `Duplicate bid: ${minutes}m is already taken` } });
        return;
      }

      await prisma.bid.upsert({
        where: {
          teamId_promptId_round: {
            teamId,
            promptId: currentPrompt.id,
            round: config.currentRound
          }
        },
        update: {
          bidMinutes: minutes,
          submittedAt: new Date()
        },
        create: {
          teamId,
          promptId: currentPrompt.id,
          round: config.currentRound,
          bidMinutes: minutes
        }
      });

      const bidData = {
        teamId: team.id,
        teamName: team.teamName,
        bidMinutes: minutes,
        promptId: currentPrompt.id,
        round: config.currentRound
      };

      io.emit(SOCKET_EVENTS.SERVER.BID_NEW, bidData);
      if (typeof ack === 'function') ack({ success: true, bid: bidData });
    } catch (err) {
      logger.warn(`Bid socket error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.CLIENT.BID_UPDATE, async (data, ack) => {
    // Alias to BID_PLACE
    socket.listeners(SOCKET_EVENTS.CLIENT.BID_PLACE)[0](data, ack);
  });
};

module.exports = registerBidHandlers;
