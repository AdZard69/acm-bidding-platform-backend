const GAME_STATUS = Object.freeze({
  WAITING: 'waiting',
  BIDDING: 'bidding',
  PAUSED: 'paused',
  BETWEEN_PROMPTS: 'between_prompts',
  ROUND_ENDED: 'round_ended',
  CODING: 'coding',
  JUDGING: 'judging',
  FINISHED: 'finished'
});

module.exports = GAME_STATUS;
