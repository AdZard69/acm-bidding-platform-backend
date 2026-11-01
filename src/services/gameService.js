const prisma = require('../config/prisma');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const ApiError = require('../utils/apiError');
const timerManager = require('../socket/timerManager');
const bidEngine = require('./bidEngine');
const { broadcast, sendToTeam } = require('../socket/emitter');
const { withGameLock } = require('./gameLock');
const { isIntegerInput } = require('../utils/validators');
const logger = require('../utils/logger');
const { outsideOperation, runOperation } = require('../utils/operation');

const isActive = (config) => [GAME_STATUS.BIDDING, GAME_STATUS.PAUSED].includes(config.status);

let configRead = null;
const getOrCreateGameConfig = () => {
  if (configRead) return configRead;
  configRead = (async () => {
    let config = await prisma.gameConfig.findUnique({ where: { id: 1 } });
    if (!config) config = await prisma.gameConfig.findFirst();
    if (config) return config;
    try {
      return await prisma.gameConfig.create({ data: { id: 1 } });
    } catch (error) {
      if (error.code === 'P2002') return prisma.gameConfig.findFirst();
      throw error;
    }
  })().finally(() => { configRead = null; });
  return configRead;
};

/**
 * Eligible prompts:
 * Round 1: all prompts in display order
 * Round 2: prompts with assignments < slotsPerPrompt
 */
const getEligiblePromptsForRound = async (roundNumber = 1, slotsPerPrompt = 3) => {
  if (Number(roundNumber) === 1) {
    return prisma.prompt.findMany({
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }]
    });
  }

  const prompts = await prisma.prompt.findMany({
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    include: { assignments: true }
  });

  return prompts.filter((p) => p.assignments.length < slotsPerPrompt);
};

const timerCallbacks = (round, adminId = null) => ({
  onTick: (secondsLeft, promptId, timer) => {
    const payload = {
      ...timer,
      secondsLeft,
      promptId,
      currentRound: round,
      roundNumber: round,
      round,
      status: GAME_STATUS.BIDDING,
      hasExpired: timer.hasExpired,
      isRunning: timer.isRunning
    };
    broadcast(SOCKET_EVENTS.SERVER.TIMER_TICK, payload);
  },
  onExpire: (promptId, timerId) => withGameLock(async () => {
    const config = await getOrCreateGameConfig();
    if (config.status !== GAME_STATUS.BIDDING || config.biddingState?.timer?.timerId !== timerId) return;
    if (!timerManager.hasExpired()) return;
    try {
      return await closeCurrentPrompt(config, adminId, 'timer_expired');
    } catch (error) {
      if (timerManager.timerId === timerId && !timerManager.isRunning()) timerManager.resetTimer();
      throw error;
    }
  }, { mustRun: true })
});

let activeConfig = null;
const persistTimer = async (config, promptIds = config.biddingState?.promptIds || []) => {
  const saved = await prisma.gameConfig.update({
    where: { id: config.id },
    data: {
      status: config.status,
      currentRound: config.currentRound,
      currentPromptIndex: config.currentPromptIndex,
      biddingState: {
        ...config.biddingState,
        flowVersion: 2,
        promptIds,
        timer: timerManager.serialize()
      }
    }
  });
  activeConfig = saved;
  return saved;
};

const getActiveGameConfig = () => {
  if (activeConfig?.biddingState?.timer?.timerId && activeConfig.biddingState.timer.timerId === timerManager.timerId)
    return Promise.resolve(activeConfig);
  return getOrCreateGameConfig();
};

const ensureTimer = async (config) => {
  if (config.status === GAME_STATUS.ROUND_ENDED && timerManager.getPromptId() === null && config.biddingState?.timer) {
    const saved = config.biddingState.timer;
    timerManager.startTimer({ promptId: saved.promptId, restored: { ...saved, isPaused: true, remainingMs: 0 } });
    timerManager.stopTimer();
  }
  if (!isActive(config) || timerManager.getPromptId() !== null) return config;
  let saved = config.biddingState?.timer;
  if (saved?.pendingStart) {
    saved = { ...saved, pendingStart: false, isPaused: true };
    config = { ...config, status: GAME_STATUS.PAUSED };
  }
  const prompts = !saved || !config.biddingState?.promptIds
    ? await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt) : [];
  if (!saved) {
    const prompt = prompts[config.currentPromptIndex];
    if (!prompt) throw new ApiError(409, 'Active bidding state has no prompt. Reset the game to continue.');
    saved = {
      promptId: prompt.id,
      durationSeconds: config.bidDurationSeconds,
      remainingMs: config.bidDurationSeconds * 1000,
      isPaused: true,
      savedAt: Date.now(),
      startTime: Date.now()
    };
    config = { ...config, status: GAME_STATUS.PAUSED };
  }
  timerManager.startTimer({
    promptId: saved.promptId,
    restored: saved,
    ...timerCallbacks(config.currentRound)
  });
  return persistTimer(config, config.biddingState?.promptIds || prompts.map((p) => p.id));
};

const getCurrentPrompt = async (config) => {
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED) return null;
  const id = config.biddingState?.timer?.promptId ?? timerManager.getPromptId();
  if (id != null) return prisma.prompt.findUnique({ where: { id } });
  if (config.currentPromptIndex < 0) return null;
  const prompts = await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
  return prompts[config.currentPromptIndex] || null;
};

const buildState = async (config, preparedPrompt) => {
  const currentPrompt = preparedPrompt === undefined ? await getCurrentPrompt(config) : preparedPrompt;
  const bids = currentPrompt ? await prisma.bid.findMany({
    where: { promptId: currentPrompt.id, round: config.currentRound, team: { isActive: true } },
    include: { team: { select: { teamName: true } } },
    orderBy: [{ bidMinutes: 'asc' }, { submittedAt: 'asc' }]
  }) : [];
  const assignedSlots = currentPrompt ? await prisma.assignment.count({ where: { promptId: currentPrompt.id } }) : 0;
  const eligiblePrompts = config.currentRound > 0 ? await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt) : [];
  const timer = timerManager.getTimeDetails();
  const closed = config.status === GAME_STATUS.ROUND_ENDED;
  const unassignedTeamsCount = await prisma.team.count({ where: { isActive: true, assignment: null } });
  const openPromptsForRound2 = await getEligiblePromptsForRound(2, config.slotsPerPrompt);
  const canStartRound2 = config.currentRound >= 1 && (closed || config.status === GAME_STATUS.WAITING) && unassignedTeamsCount > 0 && openPromptsForRound2.length > 0;

  return {
    success: true,
    ...timer,
    secondsLeft: timer.secondsRemaining,
    status: config.status,
    currentRound: config.currentRound,
    roundNumber: config.currentRound,
    round: config.currentRound,
    currentPromptIndex: config.currentPromptIndex,
    promptIndex: config.currentPromptIndex,
    currentPrompt,
    prompt: currentPrompt,
    totalPrompts: eligiblePrompts.length,
    totalPromptsInRound: eligiblePrompts.length,
    hasNextPrompt: config.currentPromptIndex >= 0 && config.currentPromptIndex < eligiblePrompts.length - 1 && unassignedTeamsCount > 0,
    canStartRound2,
    unassignedTeamsCount,
    winners: closed ? config.biddingState?.winners || [] : [],
    summary: closed ? config.biddingState?.summary || null : null,
    availableSlots: currentPrompt ? Math.max(0, config.slotsPerPrompt - assignedSlots) : 0,
    ...(!isActive(config) ? {
      timerId: closed ? config.biddingState?.timer?.timerId ?? null : null,
      promptId: closed ? currentPrompt?.id ?? null : null,
      startTime: closed ? config.biddingState?.timer?.startTime ?? null : null,
      endsAt: null,
      remainingMs: 0,
      secondsRemaining: 0,
      secondsLeft: 0,
      elapsedMs: 0,
      isPaused: false,
      isRunning: false,
      hasExpired: true
    } : {}),
    config: {
      baseTime: config.baseTime,
      minBid: config.minBid,
      bidDurationSeconds: config.bidDurationSeconds,
      slotsPerPrompt: config.slotsPerPrompt
    },
    bids: bids.map(({ team, ...bid }) => ({ ...bid, round: config.currentRound, teamName: team.teamName }))
  };
};

let stateRead = null;
const getCurrentBiddingState = () => {
  if (!stateRead) stateRead = withGameLock(async () =>
    buildState(await ensureTimer(await getOrCreateGameConfig())))
    .finally(() => { stateRead = null; });
  return stateRead;
};

const publishState = async (config) => {
  const state = await buildState(config);
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, state);
  return state;
};

const logAction = async (adminId, action, details) => {
  try { return await prisma.adminLog.create({ data: { adminId, action, details } }); }
  catch (error) {
    logger.warn(`Audit log for ${action} could not be saved (${error.code || error.name})`);
    return null;
  }
};

const checkpointActivation = (prepared) => {
  const biddingState = { ...prepared.biddingState, timer: timerManager.serialize() };
  activeConfig = { ...prepared, biddingState };
  void outsideOperation(() => runOperation(async () => {
    await prisma.gameConfig.updateMany({
      where: { id: prepared.id, biddingState: { equals: prepared.biddingState } },
      data: { biddingState }
    });
  })).catch((error) => logger.warn(`Timer activation checkpoint failed; restart will recover paused (${error.code || error.name})`));
  return activeConfig;
};

const startPrompt = async (config, prompt, promptIds) => {
  timerManager.startTimer({
    seconds: config.bidDurationSeconds,
    promptId: prompt.id,
    ...timerCallbacks(config.currentRound),
    prepare: true
  });
  try {
    const prepared = await persistTimer(config, promptIds);
    timerManager.activateTimer();
    return checkpointActivation(prepared);
  } catch (err) {
    timerManager.resetTimer();
    throw err;
  }
};

const openPrompt = async (config, prompt, { fromNext = false, resetWinners, totalPrompts = 0 } = {}) => {
  const preparedState = await buildState(config, prompt);
  await startPrompt(config, prompt, config.biddingState?.promptIds || []);
  const timer = timerManager.getTimeDetails();
  const payload = {
    ...preparedState,
    ...timer,
    secondsLeft: timer.secondsRemaining,
    ...(resetWinners ? { resetWinners } : {})
  };
  for (const teamId of resetWinners || []) {
    sendToTeam(teamId, SOCKET_EVENTS.SERVER.ASSIGNMENT_RECEIVED, null);
    sendToTeam(teamId, 'assignment:cleared', { round: config.currentRound });
  }
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, payload);
  broadcast(SOCKET_EVENTS.SERVER.ROUND_STARTED, payload);
  if (fromNext) broadcast(SOCKET_EVENTS.SERVER.PROMPT_NEXT, {
    ...payload,
    nextPromptIndex: config.currentPromptIndex,
    totalPrompts: totalPrompts || payload.totalPromptsInRound
  });
  broadcast(SOCKET_EVENTS.SERVER.PROMPT_REVEAL, payload);
  broadcast(SOCKET_EVENTS.SERVER.TIMER_TICK, payload);
  return payload;
};

const startRound = async (roundInput, adminId = null) => {
  const config = await getOrCreateGameConfig();
  if (isActive(config)) throw new ApiError(400, 'Round is already in progress');
  if (await prisma.team.count({ where: { isActive: true } }) === 0)
    throw new ApiError(400, 'No active teams found. Please create teams before starting a round');
  if (!await prisma.prompt.count())
    throw new ApiError(400, 'No prompts found. Please create prompts before starting a round');

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

  if (targetRound === 2) {
    if (config.currentRound < 1) {
      throw new ApiError(400, 'Round 1 must be completed before starting Round 2');
    }
    const unassignedCount = await prisma.team.count({ where: { isActive: true, assignment: null } });
    if (unassignedCount === 0) {
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
  const updated = {
    ...config,
    currentRound: targetRound,
    currentPromptIndex: 0,
    status: GAME_STATUS.BIDDING,
    biddingState: {
      flowVersion: 2,
      promptIds: eligiblePrompts.map((p) => p.id)
    }
  };

  const state = await openPrompt(updated, firstPrompt, { totalPrompts: eligiblePrompts.length });
  void outsideOperation(() => logAction(adminId, 'ROUND_START', `Started round ${targetRound} with prompt "${firstPrompt.title}" (id: ${firstPrompt.id})`));
  return {
    ...state,
    message: `Round ${targetRound} started`,
    round: targetRound,
    prompt: firstPrompt,
    promptIndex: 0,
    totalPrompts: eligiblePrompts.length
  };
};

const requireActiveTimer = async (status, expectedTimerId, allowExpired = false) => {
  const config = await ensureTimer(await getOrCreateGameConfig());
  if (status && config.status !== status) {
    const message = status === GAME_STATUS.PAUSED ? 'Cannot resume: round is not paused'
      : config.status === GAME_STATUS.PAUSED ? 'Round is already paused' : 'Cannot pause: round is not actively bidding';
    throw new ApiError(400, message);
  }
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED) throw new ApiError(400, 'Cannot extend timer: no prompt is currently active');
  if (expectedTimerId && expectedTimerId !== timerManager.timerId)
    throw new ApiError(409, 'The bidding session has changed. Refresh before using timer controls.');
  if (!allowExpired && timerManager.hasExpired() && config.status !== GAME_STATUS.PAUSED)
    throw new ApiError(400, 'Bidding time has expired for this prompt');
  return config;
};

const changeTimer = async (config, mutate, status = config.status, activateAfterSave = false) => {
  const saved = timerManager.serialize();
  const savedAt = timerManager.now();
  mutate();
  try {
    const updated = await persistTimer({ ...config, status });
    if (!activateAfterSave) return updated;
    timerManager.activateTimer({ resetStartTime: false });
    return checkpointActivation(updated);
  } catch (error) {
    timerManager.startTimer({ promptId: saved.promptId, restored: {
      ...saved,
      remainingMs: Math.max(0, saved.remainingMs - (saved.isPaused ? 0 : timerManager.now() - savedAt)),
      savedAt: timerManager.wallNow()
    }, ...timerCallbacks(config.currentRound) });
    throw error;
  }
};

const pauseRound = async (adminId = null, timerId) => {
  let config = await requireActiveTimer(GAME_STATUS.BIDDING, timerId);
  config = await changeTimer(config, () => timerManager.pauseTimer(), GAME_STATUS.PAUSED);
  broadcast(SOCKET_EVENTS.SERVER.ROUND_PAUSED, timerManager.getTimeDetails());
  const state = await publishState(config);
  await logAction(adminId, 'ROUND_PAUSE', `Paused round ${config.currentRound}`);
  return { ...state, round: config.currentRound, message: 'Round paused' };
};

const resumeRound = async (adminId = null, timerId) => {
  let config = await requireActiveTimer(GAME_STATUS.PAUSED, timerId);
  const preparedState = await buildState(config);
  config = await changeTimer(config, () => timerManager.prepareResume(), GAME_STATUS.BIDDING, true);
  const timer = timerManager.getTimeDetails();
  const state = { ...preparedState, ...timer, status: GAME_STATUS.BIDDING, secondsLeft: timer.secondsRemaining };
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, state);
  broadcast(SOCKET_EVENTS.SERVER.ROUND_RESUMED, state);
  void outsideOperation(() => logAction(adminId, 'ROUND_RESUME', `Resumed round ${config.currentRound}`));
  return { ...state, round: config.currentRound, message: 'Round resumed' };
};

const extendRound = async (extraSeconds, adminId = null, timerId) => {
  let config = await requireActiveTimer(undefined, timerId, true);
  const extra = Number(extraSeconds);
  if (!isIntegerInput(extraSeconds) || extra <= 0) throw new ApiError(400, 'extraSeconds must be a positive integer');
  const targetStatus = config.status === GAME_STATUS.PAUSED ? GAME_STATUS.PAUSED : GAME_STATUS.BIDDING;
  config = await changeTimer(config, () => timerManager.extendTimer(extra), targetStatus);
  const newSecondsLeft = timerManager.getSecondsRemaining();
  const payload = {
    ...timerManager.getTimeDetails(),
    status: targetStatus,
    newSecondsLeft,
    secondsLeft: newSecondsLeft,
    secondsRemaining: newSecondsLeft,
    extraSeconds: extra,
    hasExpired: false,
    isRunning: timerManager.isRunning(),
    currentRound: config.currentRound,
    roundNumber: config.currentRound,
    round: config.currentRound
  };
  broadcast(SOCKET_EVENTS.SERVER.TIMER_EXTENDED, payload);
  if (targetStatus === GAME_STATUS.BIDDING) {
    broadcast(SOCKET_EVENTS.SERVER.ROUND_RESUMED, payload);
  }
  const state = await publishState(config);
  broadcast('timer:tick', { ...payload, ...state, secondsLeft: newSecondsLeft });
  await logAction(adminId, 'ROUND_EXTEND', `Extended timer by ${extra}s in round ${config.currentRound}`);
  return { ...state, message: `Timer extended by ${extra} seconds`, extraSeconds: extra };
};

const awardCurrentPrompt = async (config) => {
  const prompt = await getCurrentPrompt(config);
  if (!prompt) return [];
  const count = await prisma.assignment.count({ where: { promptId: prompt.id } });
  const winners = await bidEngine.evaluatePromptBids(prompt.id, config.currentRound, Math.max(0, config.slotsPerPrompt - count), config);
  broadcast(SOCKET_EVENTS.SERVER.PROMPT_RESULTS, { promptId: prompt.id, winners });
  for (const winner of winners) sendToTeam(winner.teamId, SOCKET_EVENTS.SERVER.ASSIGNMENT_RECEIVED, {
    ...winner, promptId: prompt.id, title: prompt.title, description: prompt.description,
    codingTimeMinutes: winner.bidMinutes, round: config.currentRound
  });
  broadcast('leaderboard:update', {});
  return winners;
};

const closeCurrentPrompt = async (config, adminId = null, reason = 'manual_end') => {
  if (config.status === GAME_STATUS.ROUND_ENDED) {
    return { ...await buildState(config), message: `Round ${config.currentRound} is complete`, round: config.currentRound };
  }
  timerManager.stopTimer();
  await awardCurrentPrompt(config);
  const prompt = await getCurrentPrompt(config);
  const assigned = prompt ? await prisma.assignment.findMany({
    where: { promptId: prompt.id }, include: { team: { select: { teamName: true } } }, orderBy: { bidMinutes: 'asc' }
  }) : [];
  const winners = assigned.map((assignment) => ({
    teamId: assignment.teamId,
    teamName: assignment.team.teamName,
    bidMinutes: assignment.bidMinutes,
    multiplier: Number(assignment.multiplier)
  }));

  const eligiblePrompts = await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
  const unassignedTeams = await prisma.team.findMany({ where: { isActive: true, assignment: null } });
  const isLastPromptInRound = config.currentPromptIndex >= eligiblePrompts.length - 1 || unassignedTeams.length === 0;

  let autoAssigned = null;
  if (reason !== 'manual_end' && isLastPromptInRound && unassignedTeams.length === 1) {
    autoAssigned = await bidEngine.autoAssignRemainingTeam(unassignedTeams[0].id, config);
  }

  const summary = {
    round: config.currentRound,
    assignedTeams: await prisma.assignment.count(),
    unassignedTeams: await prisma.team.count({ where: { isActive: true, assignment: null } }),
    ...(autoAssigned ? { autoAssigned } : {})
  };

  const updated = await persistTimer({
    ...config,
    status: GAME_STATUS.ROUND_ENDED,
    biddingState: { ...config.biddingState, winners, summary }
  });

  broadcast(SOCKET_EVENTS.SERVER.ROUND_ENDED, { roundNumber: config.currentRound, timerId: timerManager.timerId, summary });
  const state = await publishState(updated);
  broadcast('leaderboard:update', {});
  await logAction(adminId, 'ROUND_END', `Round ${config.currentRound} prompt ${prompt?.id || ''} closed [${reason}]; waiting for admin`);
  return { ...state, message: `Round ${config.currentRound} prompt closed.`, round: config.currentRound, winners, summary };
};

const advanceToNextPromptOrEnd = async (adminId = null, reason = 'force_skip', timerId = timerManager.timerId) => {
  let config = await ensureTimer(await getOrCreateGameConfig());
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED)
    throw new ApiError(400, 'Cannot advance prompt: no round in progress');
  const session = config.biddingState?.timer?.timerId;
  if (timerId && session && timerId !== session)
    throw new ApiError(409, 'The active prompt has already changed. Refresh before advancing.');

  // If currently active, close/award current prompt first
  let winners = [];
  if (isActive(config)) {
    const closed = await closeCurrentPrompt(config, adminId, reason);
    winners = closed.winners || [];
    config = await getOrCreateGameConfig();
  }

  const eligiblePrompts = await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
  const unassignedTeams = await prisma.team.findMany({ where: { isActive: true, assignment: null } });
  const nextIndex = config.currentPromptIndex + 1;

  if (unassignedTeams.length > 0 && nextIndex < eligiblePrompts.length) {
    const nextPromptObj = eligiblePrompts[nextIndex];
    const updated = {
      ...config,
      currentPromptIndex: nextIndex,
      status: GAME_STATUS.BIDDING,
      biddingState: {
        ...config.biddingState,
        promptIds: eligiblePrompts.map((p) => p.id)
      }
    };

    const state = await openPrompt(updated, nextPromptObj, { fromNext: true, totalPrompts: eligiblePrompts.length });
    void outsideOperation(() => logAction(adminId, 'NEXT_PROMPT', `Advanced to prompt "${nextPromptObj.title}" (index ${nextIndex}) in round ${config.currentRound} [${reason}]`));
    return {
      ...state,
      message: 'Advanced to next prompt',
      round: config.currentRound,
      prompt: nextPromptObj,
      promptIndex: nextIndex,
      totalPrompts: eligiblePrompts.length,
      winners
    };
  } else {
    // Round ends - no more prompts in this round!
    return {
      ...await buildState(config),
      message: 'Round ended - no more prompts',
      round: config.currentRound,
      status: GAME_STATUS.ROUND_ENDED,
      winners,
      summary: config.biddingState?.summary || null
    };
  }
};

const endRound = async (adminId = null, timerId) => {
  const config = await ensureTimer(await getOrCreateGameConfig());
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED)
    throw new ApiError(400, 'No round is currently in progress');
  if (timerId && timerId !== config.biddingState?.timer?.timerId)
    throw new ApiError(409, 'The active prompt has changed. Refresh before ending.');
  return closeCurrentPrompt(config, adminId, 'manual_end');
};

const rerunRound = async (roundInput, adminId = null) => {
  const config = await getOrCreateGameConfig();
  if (await prisma.team.count({ where: { isActive: true } }) === 0) {
    throw new ApiError(400, 'No active teams found. Please create teams before starting a round');
  }
  if (!await prisma.prompt.count()) {
    throw new ApiError(400, 'No prompts found. Please create prompts before starting a round');
  }

  const targetRound = roundInput != null ? Number(roundInput) : (config.currentRound || 1);
  if (![1, 2].includes(targetRound)) {
    throw new ApiError(400, 'Round number must be 1 or 2');
  }

  if (isActive(config) && targetRound !== config.currentRound) {
    throw new ApiError(400, `Round ${config.currentRound} is still in progress. End it before rerunning Round ${targetRound}.`);
  }

  const roundAssignments = await prisma.assignment.findMany({
    where: { round: targetRound },
    select: { id: true, teamId: true }
  });
  const winnerTeamIds = roundAssignments.map((assignment) => assignment.teamId);

  await prisma.$transaction([
    prisma.score.deleteMany({ where: { teamId: { in: winnerTeamIds } } }),
    prisma.assignment.deleteMany({ where: { round: targetRound } }),
    prisma.bid.deleteMany({ where: { round: targetRound } })
  ]);

  const eligiblePrompts = await getEligiblePromptsForRound(targetRound, config.slotsPerPrompt);
  if (eligiblePrompts.length === 0) {
    throw new ApiError(400, `No eligible prompts found for Round ${targetRound}`);
  }

  const firstPrompt = eligiblePrompts[0];
  const updated = {
    ...config,
    currentRound: targetRound,
    currentPromptIndex: 0,
    status: GAME_STATUS.BIDDING,
    biddingState: {
      flowVersion: 2,
      promptIds: eligiblePrompts.map((p) => p.id),
      winners: [],
      summary: null
    }
  };

  const syncPayload = await openPrompt(updated, firstPrompt, { resetWinners: winnerTeamIds, totalPrompts: eligiblePrompts.length });
  broadcast('leaderboard:update', {});
  broadcast('config:updated', {});

  void outsideOperation(() => logAction(adminId, 'ROUND_RERUN', `Reran Round ${targetRound}: prompt ${firstPrompt.id}. Reset ${winnerTeamIds.length} winner assignment(s).`));

  return {
    ...syncPayload,
    message: `Round ${targetRound} rerun started`,
    resetWinners: winnerTeamIds
  };
};

module.exports = {
  getOrCreateGameConfig,
  getActiveGameConfig,
  getEligiblePromptsForRound,
  getCurrentPrompt,
  getCurrentBiddingState,
  ensureTimer,
  publishState,
  startRound: (...args) => withGameLock(() => startRound(...args)),
  pauseRound: (...args) => withGameLock(() => pauseRound(...args)),
  resumeRound: (...args) => withGameLock(() => resumeRound(...args)),
  extendRound: (...args) => withGameLock(() => extendRound(...args)),
  nextPrompt: (adminId, timerId = timerManager.timerId) => withGameLock(() => advanceToNextPromptOrEnd(adminId, 'force_skip', timerId)),
  endRound: (adminId, timerId = timerManager.timerId) => withGameLock(() => endRound(adminId, timerId)),
  rerunRound: (...args) => withGameLock(() => rerunRound(...args)),
  advanceToNextPromptOrEnd: (...args) => withGameLock(() => advanceToNextPromptOrEnd(...args))
};
