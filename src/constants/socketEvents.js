const SOCKET_EVENTS = Object.freeze({
  // Server -> Clients (Broadcast or Rooms)
  SERVER: {
    TIMER_TICK: 'timer:tick',
    BID_NEW: 'bid:new',
    BID_UPDATED: 'bid:updated',
    PROMPT_REVEAL: 'prompt:reveal',
    PROMPT_RESULTS: 'prompt:results',
    PROMPT_NEXT: 'prompt:next',
    ROUND_STARTED: 'round:started',
    ROUND_PAUSED: 'round:paused',
    ROUND_RESUMED: 'round:resumed',
    ROUND_ENDED: 'round:ended',
    TIMER_EXTENDED: 'timer:extended',
    GAME_STATUS: 'game:status',
    ASSIGNMENT_RECEIVED: 'assignment:received',
    SCORE_RECEIVED: 'score:received',
    TIME_SYNC: 'time:sync',
    ERROR: 'game:error',
    CODING_STARTED: 'coding:started',
    CODING_PAUSED: 'coding:paused',
    CODING_RESUMED: 'coding:resumed',
    CODING_RESET: 'coding:reset',
    SUBMISSION_UPDATED: 'submission:updated'
  },

  // Team Client -> Server
  CLIENT: {
    BID_PLACE: 'bid:place',
    BID_UPDATE: 'bid:update',
    TIME_SYNC: 'time:sync'
  },

  // Admin Client -> Server
  ADMIN: {
    START_ROUND: 'admin:start-round',
    PAUSE: 'admin:pause',
    RESUME: 'admin:resume',
    EXTEND: 'admin:extend',
    NEXT_PROMPT: 'admin:next-prompt',
    END_ROUND: 'admin:end-round',
    RERUN_ROUND: 'admin:rerun-round'
  }
});

module.exports = SOCKET_EVENTS;
