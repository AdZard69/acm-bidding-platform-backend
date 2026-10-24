const prisma = require('../config/prisma');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');
const timerManager = require('../socket/timerManager');
const bidEngine = require('./bidEngine');
const { broadcast, sendToTeam } = require('../socket');

/**
 * Retrieves the singleton game config row or creates it with defaults.
 * @returns {Promise<import('@prisma/client').GameConfig>}
 */
const getOrCreateGameConfig = async () => {
  let config = await prisma.gameConfig.findFirst();
  if (!config) {
    config = await prisma.gameConfig.create({
      data: {
        baseTime: 120,
        minBid: 30,
        maxTeams: 10,
        slotsPerPrompt: 3,
        bidDurationSeconds: 60,
        currentRound: 0,
        currentPromptIndex: -1,
        status: GAME_STATUS.WAITING
      }
    });
  }
  return config;
};

/**
 * Returns eligible prompts for a given round.
 * Round 1: All prompts in display order.
 * Round 2: Only prompts with remaining open slots (< slotsPerPrompt).
 *
 * @param {number} roundNumber
 * @param {number} [slotsPerPrompt=3]
 * @returns {Promise<Array<import('@prisma/client').Prompt>>}
 */
const getEligiblePromptsForRound = async (roundNumber, slotsPerPrompt = 3) => {
  if (roundNumber === 1) {
    return prisma.prompt.findMany({
      orderBy: { displayOrder: 'asc' }
    });
  }

  const prompts = await prisma.prompt.findMany({
    orderBy: { displayOrder: 'asc' },
    include: { assignments: true }
  });

  return prompts.filter((p) => p.assignments.length < slotsPerPrompt);
};

/**
 * Starts round 1 or round 2
 *
 * @param {number} [roundInput] - Optional round number (1 or 2)
 * @param {number|null} [adminId] - Admin id initiating the action
 */
const startRound = async (roundInput, adminId = null) => {
  const config = await getOrCreateGameConfig();

  if (config.status === GAME_STATUS.BIDDING || config.status === GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'Round is already in progress');
  }

  let targetRound;
  if (roundInput !== undefined && roundInput !== null) {
    targetRound = Number(roundInput);
    if (![1, 2].includes(targetRound)) {
      throw new ApiError(400, 'Round number must be 1 or 2');
    }
  } else {
    if (config.currentRound === 1 && config.status === GAME_STATUS.ROUND_ENDED) {
      targetRound = 2;
    } else {
      targetRound = 1;
    }
  }

  const activeTeamsCount = await prisma.team.count({
    where: { isActive: true }
  });
  if (activeTeamsCount === 0) {
    throw new ApiError(400, 'No active teams found. Please create teams before starting a round');
  }

  if (targetRound === 2) {
    if (config.currentRound < 1) {
      throw new ApiError(400, 'Round 1 must be completed before starting Round 2');
    }

    const unassignedTeamsCount = await prisma.team.count({
      where: { isActive: true, assignment: null }
    });
    if (unassignedTeamsCount === 0) {
      throw new ApiError(400, 'All teams have already been assigned prompts. Round 2 is not needed');
    }
  }

  const eligiblePrompts = await getEligiblePromptsForRound(targetRound, config.slotsPerPrompt);
  if (eligiblePrompts.length === 0) {
    if (targetRound === 1) {
      throw new ApiError(400, 'No prompts found. Please create prompts before starting a round');
    } else {
      throw new ApiError(400, 'No prompts have open slots remaining for Round 2');
    }
  }

  const firstPrompt = eligiblePrompts[0];

  const updatedConfig = await prisma.gameConfig.update({
    where: { id: config.id },
    data: {
      currentRound: targetRound,
      currentPromptIndex: 0,
      status: GAME_STATUS.BIDDING
    }
  });

  timerManager.startTimer({
    seconds: updatedConfig.bidDurationSeconds,
    promptId: firstPrompt.id,
    onTick: (secondsLeft, promptId) => {
      broadcast(SOCKET_EVENTS.SERVER.TIMER_TICK, { secondsLeft, promptId });
    },
    onExpire: async () => {
      try {
        await advanceToNextPromptOrEnd(adminId, 'timer_expired');
      } catch (err) {
        logger.error('Error handling prompt timer expiration', err);
      }
    }
  });

  broadcast(SOCKET_EVENTS.SERVER.ROUND_STARTED, { roundNumber: targetRound });
  broadcast(SOCKET_EVENTS.SERVER.PROMPT_REVEAL, {
    promptId: firstPrompt.id,
    title: firstPrompt.title,
    description: firstPrompt.description,
    displayOrder: firstPrompt.displayOrder
  });
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
    status: GAME_STATUS.BIDDING,
    currentRound: targetRound,
    currentPrompt: {
      id: firstPrompt.id,
      title: firstPrompt.title,
      description: firstPrompt.description,
      displayOrder: firstPrompt.displayOrder
    }
  });

  await prisma.adminLog.create({
    data: {
      adminId,
      action: 'ROUND_START',
      details: `Started round ${targetRound} with prompt "${firstPrompt.title}" (id: ${firstPrompt.id})`
    }
  });

  return {
    success: true,
    message: `Round ${targetRound} started`,
    round: targetRound,
    currentPrompt: {
      id: firstPrompt.id,
      title: firstPrompt.title,
      description: firstPrompt.description,
      displayOrder: firstPrompt.displayOrder
    },
    secondsRemaining: updatedConfig.bidDurationSeconds,
    status: GAME_STATUS.BIDDING
  };
};

/**
 * Pauses current timer
 *
 * @param {number|null} [adminId]
 */
const pauseRound = async (adminId = null) => {
  const config = await getOrCreateGameConfig();

  if (config.status === GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'Round is already paused');
  }

  if (config.status !== GAME_STATUS.BIDDING) {
    throw new ApiError(400, 'Cannot pause: round is not actively bidding');
  }

  const secondsRemaining = timerManager.pauseTimer();

  await prisma.gameConfig.update({
    where: { id: config.id },
    data: { status: GAME_STATUS.PAUSED }
  });

  broadcast(SOCKET_EVENTS.SERVER.ROUND_PAUSED, { secondsRemaining });
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
    status: GAME_STATUS.PAUSED,
    currentRound: config.currentRound,
    secondsRemaining
  });

  await prisma.adminLog.create({
    data: {
      adminId,
      action: 'ROUND_PAUSE',
      details: `Paused round ${config.currentRound} at ${secondsRemaining}s remaining`
    }
  });

  return {
    success: true,
    message: 'Round paused',
    round: config.currentRound,
    secondsRemaining,
    status: GAME_STATUS.PAUSED
  };
};

/**
 * Resumes paused timer
 *
 * @param {number|null} [adminId]
 */
const resumeRound = async (adminId = null) => {
  const config = await getOrCreateGameConfig();

  if (config.status !== GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'Cannot resume: round is not paused');
  }

  const secondsRemaining = timerManager.resumeTimer();

  await prisma.gameConfig.update({
    where: { id: config.id },
    data: { status: GAME_STATUS.BIDDING }
  });

  broadcast(SOCKET_EVENTS.SERVER.ROUND_RESUMED, { secondsRemaining });
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
    status: GAME_STATUS.BIDDING,
    currentRound: config.currentRound,
    secondsRemaining
  });

  await prisma.adminLog.create({
    data: {
      adminId,
      action: 'ROUND_RESUME',
      details: `Resumed round ${config.currentRound} with ${secondsRemaining}s remaining`
    }
  });

  return {
    success: true,
    message: 'Round resumed',
    round: config.currentRound,
    secondsRemaining,
    status: GAME_STATUS.BIDDING
  };
};

/**
 * Adds extra seconds to current timer
 *
 * @param {number} extraSeconds
 * @param {number|null} [adminId]
 */
const extendRound = async (extraSeconds, adminId = null) => {
  const config = await getOrCreateGameConfig();

  if (config.status !== GAME_STATUS.BIDDING && config.status !== GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'Cannot extend timer: no prompt is currently active');
  }

  const extra = Number(extraSeconds);
  if (!Number.isInteger(extra) || extra <= 0) {
    throw new ApiError(400, 'extraSeconds must be a positive integer');
  }

  const newSecondsLeft = timerManager.extendTimer(extra);

  broadcast(SOCKET_EVENTS.SERVER.TIMER_EXTENDED, { newSecondsLeft });

  await prisma.adminLog.create({
    data: {
      adminId,
      action: 'ROUND_EXTEND',
      details: `Extended timer by ${extra}s to ${newSecondsLeft}s in round ${config.currentRound}`
    }
  });

  return {
    success: true,
    message: `Timer extended by ${extra} seconds`,
    extraSeconds: extra,
    secondsRemaining: newSecondsLeft
  };
};

/**
 * Force skips to next prompt
 *
 * @param {number|null} [adminId]
 */
const nextPrompt = async (adminId = null) => {
  const config = await getOrCreateGameConfig();

  if (config.status !== GAME_STATUS.BIDDING && config.status !== GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'Cannot advance prompt: no round in progress');
  }

  return advanceToNextPromptOrEnd(adminId, 'force_skip');
};

/**
 * Evaluates current prompt, awards winners, and either moves to next prompt
 * or finishes the round.
 *
 * @param {number|null} adminId
 * @param {string} reason - 'force_skip' | 'timer_expired'
 */
const advanceToNextPromptOrEnd = async (adminId = null, reason = 'force_skip') => {
  timerManager.stopTimer();

  const config = await getOrCreateGameConfig();
  const eligiblePrompts = await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
  const currentPrompt = eligiblePrompts[config.currentPromptIndex];

  let winners = [];
  if (currentPrompt) {
    const existingCount = await prisma.assignment.count({
      where: { promptId: currentPrompt.id }
    });
    const availableSlots = Math.max(0, config.slotsPerPrompt - existingCount);

    winners = await bidEngine.evaluatePromptBids(
      currentPrompt.id,
      config.currentRound,
      availableSlots,
      config
    );

    broadcast(SOCKET_EVENTS.SERVER.PROMPT_RESULTS, {
      promptId: currentPrompt.id,
      winners
    });

    for (const winner of winners) {
      sendToTeam(winner.teamId, SOCKET_EVENTS.SERVER.ASSIGNMENT_RECEIVED, {
        promptId: currentPrompt.id,
        title: currentPrompt.title,
        description: currentPrompt.description,
        bidMinutes: winner.bidMinutes,
        multiplier: winner.multiplier,
        codingTimeMinutes: winner.bidMinutes
      });
    }
  }

  const unassignedTeams = await prisma.team.findMany({
    where: { isActive: true, assignment: null }
  });

  const nextIndex = config.currentPromptIndex + 1;

  if (unassignedTeams.length > 0 && nextIndex < eligiblePrompts.length) {
    const nextPromptObj = eligiblePrompts[nextIndex];

    await prisma.gameConfig.update({
      where: { id: config.id },
      data: {
        currentPromptIndex: nextIndex,
        status: GAME_STATUS.BIDDING
      }
    });

    timerManager.startTimer({
      seconds: config.bidDurationSeconds,
      promptId: nextPromptObj.id,
      onTick: (secondsLeft, promptId) => {
        broadcast(SOCKET_EVENTS.SERVER.TIMER_TICK, { secondsLeft, promptId });
      },
      onExpire: async () => {
        try {
          await advanceToNextPromptOrEnd(adminId, 'timer_expired');
        } catch (err) {
          logger.error('Error in prompt timer expiration', err);
        }
      }
    });

    broadcast(SOCKET_EVENTS.SERVER.PROMPT_NEXT, {
      nextPromptIndex: nextIndex,
      totalPrompts: eligiblePrompts.length
    });

    broadcast(SOCKET_EVENTS.SERVER.PROMPT_REVEAL, {
      promptId: nextPromptObj.id,
      title: nextPromptObj.title,
      description: nextPromptObj.description,
      displayOrder: nextPromptObj.displayOrder
    });

    broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
      status: GAME_STATUS.BIDDING,
      currentRound: config.currentRound,
      currentPrompt: {
        id: nextPromptObj.id,
        title: nextPromptObj.title,
        description: nextPromptObj.description,
        displayOrder: nextPromptObj.displayOrder
      }
    });

    await prisma.adminLog.create({
      data: {
        adminId,
        action: 'NEXT_PROMPT',
        details: `Advanced to prompt "${nextPromptObj.title}" (index ${nextIndex}) in round ${config.currentRound} [${reason}]`
      }
    });

    return {
      success: true,
      message: 'Advanced to next prompt',
      round: config.currentRound,
      prompt: {
        id: nextPromptObj.id,
        title: nextPromptObj.title,
        description: nextPromptObj.description,
        displayOrder: nextPromptObj.displayOrder
      },
      promptIndex: nextIndex,
      totalPrompts: eligiblePrompts.length,
      winners
    };
  } else {
    // Round ends!
    let autoAssigned = null;
    if (unassignedTeams.length === 1) {
      autoAssigned = await bidEngine.autoAssignRemainingTeam(unassignedTeams[0].id, config);
    }

    await prisma.gameConfig.update({
      where: { id: config.id },
      data: { status: GAME_STATUS.ROUND_ENDED }
    });

    const assignedCount = await prisma.assignment.count();
    const remainingUnassigned = await prisma.team.count({
      where: { isActive: true, assignment: null }
    });

    const summary = {
      round: config.currentRound,
      assignedTeams: assignedCount,
      unassignedTeams: remainingUnassigned,
      ...(autoAssigned ? { autoAssigned } : {})
    };

    broadcast(SOCKET_EVENTS.SERVER.ROUND_ENDED, {
      roundNumber: config.currentRound,
      summary
    });

    broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
      status: GAME_STATUS.ROUND_ENDED,
      currentRound: config.currentRound
    });

    await prisma.adminLog.create({
      data: {
        adminId,
        action: 'ROUND_END',
        details: `Round ${config.currentRound} ended (${reason}) — ${assignedCount} assigned, ${remainingUnassigned} unassigned`
      }
    });

    return {
      success: true,
      message: 'Round ended - no more prompts',
      round: config.currentRound,
      status: GAME_STATUS.ROUND_ENDED,
      winners,
      summary
    };
  }
};

/**
 * Force ends the current round immediately
 *
 * @param {number|null} [adminId]
 */
const endRound = async (adminId = null) => {
  const config = await getOrCreateGameConfig();

  if (config.status !== GAME_STATUS.BIDDING && config.status !== GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'No round is currently in progress');
  }

  timerManager.stopTimer();

  const eligiblePrompts = await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
  const currentPrompt = eligiblePrompts[config.currentPromptIndex];

  let winners = [];
  if (currentPrompt) {
    const existingCount = await prisma.assignment.count({
      where: { promptId: currentPrompt.id }
    });
    const availableSlots = Math.max(0, config.slotsPerPrompt - existingCount);

    winners = await bidEngine.evaluatePromptBids(
      currentPrompt.id,
      config.currentRound,
      availableSlots,
      config
    );

    if (winners.length > 0) {
      broadcast(SOCKET_EVENTS.SERVER.PROMPT_RESULTS, {
        promptId: currentPrompt.id,
        winners
      });

      for (const winner of winners) {
        sendToTeam(winner.teamId, SOCKET_EVENTS.SERVER.ASSIGNMENT_RECEIVED, {
          promptId: currentPrompt.id,
          title: currentPrompt.title,
          description: currentPrompt.description,
          bidMinutes: winner.bidMinutes,
          multiplier: winner.multiplier,
          codingTimeMinutes: winner.bidMinutes
        });
      }
    }
  }

  await prisma.gameConfig.update({
    where: { id: config.id },
    data: { status: GAME_STATUS.ROUND_ENDED }
  });

  const assignedCount = await prisma.assignment.count();
  const unassignedCount = await prisma.team.count({
    where: { isActive: true, assignment: null }
  });

  const summary = {
    round: config.currentRound,
    assignedTeams: assignedCount,
    unassignedTeams: unassignedCount
  };

  broadcast(SOCKET_EVENTS.SERVER.ROUND_ENDED, {
    roundNumber: config.currentRound,
    summary
  });

  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
    status: GAME_STATUS.ROUND_ENDED,
    currentRound: config.currentRound
  });

  await prisma.adminLog.create({
    data: {
      adminId,
      action: 'ROUND_END',
      details: `Force ended round ${config.currentRound}`
    }
  });

  return {
    success: true,
    message: `Round ${config.currentRound} ended`,
    round: config.currentRound,
    status: GAME_STATUS.ROUND_ENDED,
    winners,
    summary
  };
};

module.exports = {
  getOrCreateGameConfig,
  getEligiblePromptsForRound,
  startRound,
  pauseRound,
  resumeRound,
  extendRound,
  nextPrompt,
  endRound,
  advanceToNextPromptOrEnd
};
