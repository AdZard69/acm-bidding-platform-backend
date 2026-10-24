/**
 * Timer Manager
 * Handles countdown timer logic, ticks, pause, resume, extend for bidding rounds.
 */

class TimerManager {
  constructor() {
    this.intervalId = null;
    this.promptId = null;
    this.secondsRemaining = 0;
    this.isPaused = false;
    this.onTickCallback = null;
    this.onExpireCallback = null;
  }

  /**
   * Starts a countdown timer
   * @param {object} params
   * @param {number} params.seconds - Duration in seconds
   * @param {number} params.promptId - Associated prompt ID
   * @param {Function} [params.onTick] - Tick callback (secondsRemaining, promptId)
   * @param {Function} [params.onExpire] - Expiration callback (promptId)
   */
  startTimer({ seconds, promptId, onTick, onExpire }) {
    this.stopTimer();

    this.promptId = promptId;
    this.secondsRemaining = Number(seconds) || 0;
    this.isPaused = false;
    this.onTickCallback = onTick || null;
    this.onExpireCallback = onExpire || null;

    if (this.secondsRemaining <= 0) {
      if (this.onExpireCallback) {
        this.onExpireCallback(this.promptId);
      }
      return;
    }

    this.intervalId = setInterval(() => {
      this.secondsRemaining -= 1;

      if (this.onTickCallback) {
        try {
          this.onTickCallback(this.secondsRemaining, this.promptId);
        } catch (err) {
          // ignore callback error
        }
      }

      if (this.secondsRemaining <= 0) {
        const expiredPromptId = this.promptId;
        const expireCb = this.onExpireCallback;
        this.stopTimer();
        if (expireCb) {
          try {
            expireCb(expiredPromptId);
          } catch (err) {
            // ignore callback error
          }
        }
      }
    }, 1000);

    if (this.intervalId && typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  /**
   * Pauses the active countdown
   * @returns {number} Remaining seconds
   */
  pauseTimer() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isPaused = true;
    return this.secondsRemaining;
  }

  /**
   * Resumes the paused countdown
   * @returns {number} Remaining seconds
   */
  resumeTimer() {
    if (!this.isPaused) {
      return this.secondsRemaining;
    }

    this.isPaused = false;

    if (this.secondsRemaining <= 0) {
      const expiredPromptId = this.promptId;
      const expireCb = this.onExpireCallback;
      this.stopTimer();
      if (expireCb) {
        expireCb(expiredPromptId);
      }
      return 0;
    }

    this.intervalId = setInterval(() => {
      this.secondsRemaining -= 1;

      if (this.onTickCallback) {
        try {
          this.onTickCallback(this.secondsRemaining, this.promptId);
        } catch (err) {}
      }

      if (this.secondsRemaining <= 0) {
        const expiredPromptId = this.promptId;
        const expireCb = this.onExpireCallback;
        this.stopTimer();
        if (expireCb) {
          expireCb(expiredPromptId);
        }
      }
    }, 1000);

    if (this.intervalId && typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }

    return this.secondsRemaining;
  }

  /**
   * Extends the countdown by extra seconds
   * @param {number} extraSeconds
   * @returns {number} New total seconds remaining
   */
  extendTimer(extraSeconds) {
    const add = Number(extraSeconds) || 0;
    this.secondsRemaining += add;
    return this.secondsRemaining;
  }

  /**
   * Stops the timer without wiping promptId
   */
  stopTimer() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isPaused = false;
  }

  /**
   * Resets all timer state
   */
  resetTimer() {
    this.stopTimer();
    this.promptId = null;
    this.secondsRemaining = 0;
    this.onTickCallback = null;
    this.onExpireCallback = null;
  }

  getSecondsRemaining() {
    return this.secondsRemaining;
  }

  getPromptId() {
    return this.promptId;
  }

  isRunning() {
    return this.intervalId !== null && !this.isPaused;
  }

  isTimerPaused() {
    return this.isPaused;
  }
}

const timerManager = new TimerManager();

module.exports = timerManager;
