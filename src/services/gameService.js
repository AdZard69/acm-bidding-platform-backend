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
const {
  getRoundDefinitions, getBidRound, normalizeLegacyConfig, withOpenedRound, getNextRound
} = require('./roundService');

const isActive = (config) => [GAME_STATUS.BIDDING, GAME_STATUS.PAUSED].includes(config.status);

let configRead = null;
const getOrCreateGameConfig = () => {
  if (configRead) return configRead;
  configRead = (async () => {
    const config = await prisma.gameConfig.findUnique({ where: { id: 1 } });
    if (config) return normalizeLegacyConfig(config);
    try { return await prisma.gameConfig.create({ data: { id: 1 } }); }
    catch (error) {
      if (error.code === 'P2002') return prisma.gameConfig.findUnique({ where: { id: 1 } });
      throw error;
    }
  })().finally(() => { configRead = null; });
  return configRead;
};

// Each prompt is one round; filled earlier prompts never shift later rounds.
const getEligiblePromptsForRound = () => prisma.prompt.findMany({ orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });

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
    if (!timerManager.hasExpired()) return; // An extension can beat the queued expiry callback.
    // Expiry closes this round. Only an explicit admin action starts another.
    try { return await closeCurrentRound(config, adminId, 'timer_expired'); }
    catch (error) {
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
      status: config.status, currentRound: config.currentRound,
      currentPromptIndex: config.currentPromptIndex,
      biddingState: { ...config.biddingState, flowVersion: 2, bidRound: getBidRound(config), promptIds, timer: timerManager.serialize() }
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

// Called under the game lock. Running countdowns consume downtime; paused ones
// retain their exact remaining milliseconds. The process then uses monotonic time.
const ensureTimer = async (config) => {
  if (config.status === GAME_STATUS.ROUND_ENDED && timerManager.getPromptId() === null && config.biddingState?.timer) {
    const saved = config.biddingState.timer;
    timerManager.startTimer({ promptId: saved.promptId, restored: { ...saved, isPaused: true, remainingMs: 0 } });
    timerManager.stopTimer();
  }
  if (!isActive(config) || timerManager.getPromptId() !== null) return config;
  let saved = config.biddingState?.timer;
  if (saved?.pendingStart) {
    // A crash before activation was checkpointed has no reliable deadline.
    // Recover frozen, requiring an explicit admin resume instead of inventing time.
    saved = { ...saved, pendingStart: false, isPaused: true };
    config = { ...config, status: GAME_STATUS.PAUSED };
  }
  const prompts = !saved || !config.biddingState?.promptIds
    ? await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt) : [];
  if (!saved) {
    // Older deployments did not save their deadline. Recover safely as paused.
    const prompt = prompts[config.currentPromptIndex];
    if (!prompt) throw new ApiError(409, 'Active bidding state has no prompt. Reset the game to continue.');
    saved = {
      promptId: prompt.id, durationSeconds: config.bidDurationSeconds,
      remainingMs: config.bidDurationSeconds * 1000, isPaused: true,
      savedAt: Date.now(), startTime: Date.now()
    };
    config = { ...config, status: GAME_STATUS.PAUSED };
  }
  timerManager.startTimer({
    promptId: saved.promptId, restored: saved,
    ...timerCallbacks(config.currentRound)
  });
  return persistTimer(config, config.biddingState?.promptIds || prompts.map((p) => p.id));
};

const getCurrentPrompt = async (config) => {
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED) return null;
  const id = config.biddingState?.timer?.promptId ?? timerManager.getPromptId();
  if (id != null) return prisma.prompt.findUnique({ where: { id } });
  const prompts = await getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
  return prompts[config.currentPromptIndex] || null;
};

const buildState = async (config, preparedPrompt) => {
  const currentPrompt = preparedPrompt === undefined ? await getCurrentPrompt(config) : preparedPrompt;
  const bids = currentPrompt ? await prisma.bid.findMany({
    where: { promptId: currentPrompt.id, round: getBidRound(config), team: { isActive: true } },
    include: { team: { select: { teamName: true } } },
    orderBy: [{ bidMinutes: 'asc' }, { submittedAt: 'asc' }]
  }) : [];
  const assignedSlots = currentPrompt ? await prisma.assignment.count({ where: { promptId: currentPrompt.id } }) : 0;
  const rounds = await getRoundDefinitions(config);
  const timer = timerManager.getTimeDetails();
  const closed = config.status === GAME_STATUS.ROUND_ENDED;
  return {
    success: true,
    ...timer,
    secondsLeft: timer.secondsRemaining,
    status: config.status,
    currentRound: config.currentRound,
    roundNumber: config.currentRound,
    round: config.currentRound,
    currentPrompt,
    prompt: currentPrompt,
    rounds,
    totalRounds: rounds.length,
    hasNextRound: config.currentRound > 0 && getNextRound(config, rounds.length) !== null,
    nextRoundNumber: getNextRound(config, rounds.length),
    winners: closed ? config.biddingState?.winners || [] : [],
    summary: closed ? config.biddingState?.summary || null : null,
    availableSlots: currentPrompt ? Math.max(0, config.slotsPerPrompt - assignedSlots) : 0,
    // Do not leak old deadlines or paused flags after ending/resetting.
    ...(!isActive(config) ? {
      timerId: closed ? config.biddingState?.timer?.timerId ?? null : null,
      promptId: closed ? currentPrompt?.id ?? null : null,
      startTime: closed ? config.biddingState?.timer?.startTime ?? null : null, endsAt: null,
      remainingMs: 0, secondsRemaining: 0, secondsLeft: 0, elapsedMs: 0,
      isPaused: false, isRunning: false, hasExpired: true
    } : {}),
    config: {
      baseTime: config.baseTime, minBid: config.minBid,
      bidDurationSeconds: config.bidDurationSeconds, slotsPerPrompt: config.slotsPerPrompt
    },
    bids: bids.map(({ team, ...bid }) => ({ ...bid, round: config.currentRound, teamName: team.teamName }))
  };
};

let stateRead = null;
const getCurrentBiddingState = () => {
  // One database snapshot serves simultaneous admin/team/spectator refreshes.
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
    // The game mutation has committed; do not report it as failed just because
    // its audit write encountered an outage or the request budget elapsed.
    logger.warn(`Audit log for ${action} could not be saved (${error.code || error.name})`);
    return null;
  }
};

const checkpointActivation = (prepared) => {
  const biddingState = { ...prepared.biddingState, timer: timerManager.serialize() };
  activeConfig = { ...prepared, biddingState };
  // Save the actual start/deadline without holding up publication or bids. The
  // JSON compare prevents a late checkpoint overwriting pause/end/reset/rerun.
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
    seconds: config.bidDurationSeconds, promptId: prompt.id,
    ...timerCallbacks(config.currentRound), prepare: true
  });
  try {
    const prepared = await persistTimer(config, promptIds);
    // The duration starts AFTER the durable preparation write completes. No
    // database request or audit write is allowed between activation and broadcast.
    timerManager.activateTimer();
    return checkpointActivation(prepared);
  } catch (err) {
    timerManager.resetTimer();
    throw err;
  }
};

// Prepare all database-backed display data before starting the countdown. Once
// its timer has been saved, publishing the start must not wait on more reads.
const openPrompt = async (config, prompt, { fromNext = false, resetWinners } = {}) => {
  const preparedState = await buildState(config, prompt);
  await startPrompt(config, prompt, config.biddingState.promptIds);
  const timer = timerManager.getTimeDetails();
  const payload = {
    ...preparedState, ...timer, secondsLeft: timer.secondsRemaining,
    ...(resetWinners ? { resetWinners } : {})
  };
  for (const teamId of resetWinners || []) {
    sendToTeam(teamId, SOCKET_EVENTS.SERVER.ASSIGNMENT_RECEIVED, null);
    sendToTeam(teamId, 'assignment:cleared', { round: config.currentRound });
  }
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, payload);
  broadcast(SOCKET_EVENTS.SERVER.ROUND_STARTED, payload);
  if (fromNext) broadcast(SOCKET_EVENTS.SERVER.PROMPT_NEXT, {
    ...payload, nextPromptIndex: config.currentPromptIndex, totalPrompts: payload.totalRounds
  });
  broadcast(SOCKET_EVENTS.SERVER.PROMPT_REVEAL, payload);
  broadcast(SOCKET_EVENTS.SERVER.TIMER_TICK, payload);
  return payload;
};

const startAtRound = async (config, round, adminId = null, fromNext = false) => {
  const rounds = await getRoundDefinitions(config);
  if (round > rounds.length) throw new ApiError(400, `Round number cannot extend beyond the total number of prompts (${rounds.length})`);
  const entry = rounds[round - 1];
  const prompt = entry && await prisma.prompt.findUnique({ where: { id: entry.promptId } });
  if (!prompt) throw new ApiError(409, `The prompt for Round ${round} is missing. Reset bidding before changing the prompt list.`);
  const updated = { ...config, currentRound: round, currentPromptIndex: round - 1, status: GAME_STATUS.BIDDING,
    biddingState: { flowVersion: 2, bidRound: round, promptIds: rounds.map((item) => item.promptId),
      openedRounds: withOpenedRound(config, round) }
  };
  const state = await openPrompt(updated, prompt, { fromNext });
  void outsideOperation(() => logAction(adminId, 'ROUND_START', `Started Round ${round}: prompt ${prompt.id}`));
  if (fromNext) void outsideOperation(() => logAction(adminId, 'NEXT_PROMPT', `Admin opened Round ${round}: prompt ${prompt.id}`));
  return { ...state, message: `Round ${round} started`, round, prompt, promptIndex: round - 1, totalPrompts: rounds.length };
};

const startRound = async (roundInput, adminId = null) => {
  const config = await getOrCreateGameConfig();
  if (isActive(config)) throw new ApiError(400, 'Round is already in progress');
  if (await prisma.team.count({ where: { isActive: true } }) === 0)
    throw new ApiError(400, 'No active teams found. Please create teams before starting a round');
  if (!await prisma.prompt.count()) throw new ApiError(400, 'No prompts found. Please create prompts before starting a round');
  const rounds = await getRoundDefinitions(config);
  const round = roundInput != null ? Number(roundInput) : (getNextRound(config, rounds.length) ?? rounds.length + 1);
  if (!isIntegerInput(roundInput ?? round) || round < 1) throw new ApiError(400, 'Round number must be a positive integer');
  if (round > rounds.length) throw new ApiError(400, `Round number cannot extend beyond the total number of prompts (${rounds.length})`);
  return startAtRound(config, round, adminId);
};

const requireActiveTimer = async (status, expectedTimerId, allowExpired = false) => {
  const config = await ensureTimer(await getOrCreateGameConfig());
  if (status && config.status !== status) {
    const message = status === GAME_STATUS.PAUSED ? 'Cannot resume: round is not paused'
      : config.status === GAME_STATUS.PAUSED ? 'Round is already paused' : 'Cannot pause: round is not actively bidding';
    throw new ApiError(400, message);
  }
  // A closed round has been awarded. Extending it would reopen bidding and award
  // again, and after a restart its timer has no expiry handler. Rerun reopens it.
  if (config.status === GAME_STATUS.ROUND_ENDED)
    throw new ApiError(400, `Round ${config.currentRound} is complete and cannot be extended. Use Rerun to reopen it.`);
  if (!isActive(config)) throw new ApiError(400, 'Cannot extend timer: no prompt is currently active');
  if (expectedTimerId && expectedTimerId !== timerManager.timerId)
    throw new ApiError(409, 'The bidding session has changed. Refresh before using timer controls.');
  if (!allowExpired && timerManager.hasExpired() && config.status !== GAME_STATUS.PAUSED)
    throw new ApiError(400, 'Bidding time has expired for this prompt');
  return config;
};

// Persist timer and game status together. If saving fails, continue from the
// previous countdown so all clients still agree with the last published state.
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

const closeCurrentRound = async (config, adminId = null, reason = 'manual_end') => {
  if (config.status === GAME_STATUS.ROUND_ENDED) {
    return { ...await buildState(config), message: `Round ${config.currentRound} is complete`, round: config.currentRound };
  }
  timerManager.stopTimer();
  await awardCurrentPrompt(config);
  const prompt = await getCurrentPrompt(config);
  const assigned = prompt ? await prisma.assignment.findMany({
    where: { promptId: prompt.id }, include: { team: { select: { teamName: true } } }, orderBy: { bidMinutes: 'asc' }
  }) : [];
  const winners = assigned.map((assignment) => ({ teamId: assignment.teamId, teamName: assignment.team.teamName,
    bidMinutes: assignment.bidMinutes, multiplier: Number(assignment.multiplier) }));
  const rounds = await getRoundDefinitions(config);
  let autoAssigned = null;
  if (config.currentRound === rounds.length && reason !== 'manual_end') {
    const remaining = await prisma.team.findMany({ where: { isActive: true, assignment: null } });
    if (remaining.length === 1) autoAssigned = await bidEngine.autoAssignRemainingTeam(remaining[0].id, config);
  }
  const summary = {
    round: config.currentRound, assignedTeams: await prisma.assignment.count(),
    unassignedTeams: await prisma.team.count({ where: { isActive: true, assignment: null } }),
    ...(autoAssigned ? { autoAssigned } : {})
  };
  const updated = await persistTimer({ ...config, status: GAME_STATUS.ROUND_ENDED,
    biddingState: { ...config.biddingState, winners, summary }
  });
  broadcast(SOCKET_EVENTS.SERVER.ROUND_ENDED, { roundNumber: config.currentRound, timerId: timerManager.timerId, summary });
  const state = await publishState(updated);
  broadcast('leaderboard:update', {});
  await logAction(adminId, 'ROUND_END', `Round ${config.currentRound} closed [${reason}]; waiting for admin`);
  return { ...state, message: `Round ${config.currentRound} complete. Waiting for the admin.`, round: config.currentRound, winners, summary };
};

const advance = async (adminId = null, expectedTimerId) => {
  let config = await ensureTimer(await getOrCreateGameConfig());
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED)
    throw new ApiError(400, 'Cannot advance prompt: no round in progress');
  const session = config.biddingState?.timer?.timerId;
  if (expectedTimerId && expectedTimerId !== session)
    throw new ApiError(409, 'The active prompt has already changed. Refresh before advancing.');
  const completed = isActive(config) ? await closeCurrentRound(config, adminId, 'manual_next') : await buildState(config);
  if (isActive(config)) config = await getOrCreateGameConfig();
  const rounds = await getRoundDefinitions(config);
  const nextRound = getNextRound(config, rounds.length);
  if (nextRound === null) return {
    ...await buildState(config), message: 'All prompt rounds are complete', round: config.currentRound
  };
  const next = await startAtRound(config, nextRound, adminId, true);
  return { ...next, completedRound: { round: config.currentRound, promptId: completed.currentPrompt?.id,
    winners: completed.winners, summary: completed.summary } };
};

const advanceToNextPromptOrEnd = (adminId, reason, timerId = timerManager.timerId) =>
  withGameLock(async () => {
    if (reason === 'timer_expired') {
      const config = await getOrCreateGameConfig();
      if (config.status === GAME_STATUS.BIDDING && (!timerId || config.biddingState?.timer?.timerId === timerId))
        return closeCurrentRound(config, adminId, reason);
      return;
    }
    return advance(adminId, timerId);
  });

const endRound = async (adminId = null, timerId) => {
  const config = await ensureTimer(await getOrCreateGameConfig());
  if (!isActive(config) && config.status !== GAME_STATUS.ROUND_ENDED) throw new ApiError(400, 'No round is currently in progress');
  if (timerId && timerId !== config.biddingState?.timer?.timerId) throw new ApiError(409, 'The active prompt has changed. Refresh before ending.');
  return closeCurrentRound(config, adminId);
};

const rerunRound = async (roundInput, adminId = null) => {
  const config = await getOrCreateGameConfig();
  if (await prisma.team.count({ where: { isActive: true } }) === 0) {
    throw new ApiError(400, 'No active teams found. Please create teams before starting a round');
  }
  if (!await prisma.prompt.count()) {
    throw new ApiError(400, 'No prompts found. Please create prompts before starting a round');
  }

  const rounds = await getRoundDefinitions(config);
  const targetRound = roundInput != null ? Number(roundInput) : (config.currentRound || 1);

  if (!isIntegerInput(roundInput ?? targetRound) || targetRound < 1) {
    throw new ApiError(400, 'Round number must be a positive integer');
  }
  if (targetRound > rounds.length) {
    throw new ApiError(400, `Round number cannot extend beyond the total number of prompts (${rounds.length})`);
  }
  // Rerunning another round would replace the live timer and abandon the
  // current round without awarding it. Rerunning the live round restarts it.
  if (isActive(config) && targetRound !== config.currentRound) {
    throw new ApiError(400, `Round ${config.currentRound} is still in progress. End it before rerunning Round ${targetRound}.`);
  }

  const entry = rounds[targetRound - 1];
  const prompt = entry && await prisma.prompt.findUnique({ where: { id: entry.promptId } });
  if (!prompt) {
    throw new ApiError(409, `The prompt for Round ${targetRound} is missing. Reset bidding before changing the prompt list.`);
  }

  // Prompt identity scopes legacy bids too: older auctions stored several
  // different prompts under the same round number.
  const roundAssignments = await prisma.assignment.findMany({
    where: { promptId: prompt.id }, select: { id: true, teamId: true }
  });
  const winnerTeamIds = roundAssignments.map((assignment) => assignment.teamId);
  await prisma.$transaction([
    prisma.score.deleteMany({ where: { teamId: { in: winnerTeamIds } } }),
    prisma.assignment.deleteMany({ where: { promptId: prompt.id } }),
    prisma.bid.deleteMany({ where: { promptId: prompt.id } })
  ]);

  const updated = {
    ...config,
    currentRound: targetRound,
    currentPromptIndex: targetRound - 1,
    status: GAME_STATUS.BIDDING,
    biddingState: {
      flowVersion: 2,
      bidRound: targetRound,
      promptIds: rounds.map((item) => item.promptId),
      openedRounds: withOpenedRound(config, targetRound),
      winners: [],
      summary: null
    }
  };

  const syncPayload = await openPrompt(updated, prompt, { resetWinners: winnerTeamIds });
  broadcast('leaderboard:update', {});
  broadcast('config:updated', {});

  void outsideOperation(() => logAction(adminId, 'ROUND_RERUN', `Reran Round ${targetRound}: prompt ${prompt.id}. Reset ${winnerTeamIds.length} winner assignment(s).`));

  return {
    ...syncPayload,
    message: `Round ${targetRound} rerun started`,
    resetWinners: winnerTeamIds
  };
};

module.exports = {
  getOrCreateGameConfig, getActiveGameConfig, getEligiblePromptsForRound, getCurrentPrompt,
  getCurrentBiddingState, ensureTimer, publishState,
  startRound: (...args) => withGameLock(() => startRound(...args)),
  pauseRound: (...args) => withGameLock(() => pauseRound(...args)),
  resumeRound: (...args) => withGameLock(() => resumeRound(...args)),
  extendRound: (...args) => withGameLock(() => extendRound(...args)),
  nextPrompt: (adminId, timerId = timerManager.timerId) => advanceToNextPromptOrEnd(adminId, 'force_skip', timerId),
  endRound: (adminId, timerId = timerManager.timerId) => withGameLock(() => endRound(adminId, timerId)),
  rerunRound: (...args) => withGameLock(() => rerunRound(...args)),
  advanceToNextPromptOrEnd
};
