const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { outsideOperation } = require('../utils/operation');

/** A bidding session countdown. Elapsed time uses a monotonic clock, so changes
 * to the machine's date/time cannot lengthen or shorten an active auction. */
class TimerManager {
  constructor({ now = () => performance.now(), wallNow = () => Date.now() } = {}) {
    this.now = now;
    this.wallNow = wallNow;
    this.timerStreamId = randomUUID();
    this.timerSequence = 0;
    this.resetTimer();
  }

  // Absolute timestamps are compatibility metadata; the countdown owns time.
  get endsAt() { return this._endsAt; }
  set endsAt(value) {
    this._endsAt = value;
    this.deadline = value == null ? null : this.now() + value - this.wallNow();
  }

  startTimer({ seconds, promptId, onTick, onExpire, restored, prepare = false }) {
    this.resetTimer();
    this.promptId = promptId;
    this.timerId = restored?.timerId || randomUUID();
    this.durationSeconds = restored?.durationSeconds ?? Math.max(0, Number(seconds) || 0);
    this.startTime = restored?.startTime ?? this.wallNow();
    this.onTickCallback = onTick;
    this.onExpireCallback = onExpire;
    const remaining = restored
      ? Math.max(0, restored.remainingMs - (restored.isPaused ? 0 : Math.max(0, this.wallNow() - restored.savedAt)))
      : this.durationSeconds * 1000;
    this.remainingMsOnPause = remaining;
    this.secondsRemaining = Math.ceil(remaining / 1000);
    this.pendingStart = prepare;
    this.isPaused = prepare || (restored?.isPaused ?? false);
    this._endsAt = this.isPaused ? null : this.wallNow() + remaining;
    this.deadline = this.isPaused ? null : this.now() + remaining;
    if (!this.isPaused) this.schedule();
  }

  prepareResume() {
    if (this.isPaused) this.pendingStart = true;
  }

  activateTimer({ resetStartTime = true } = {}) {
    if (!this.pendingStart) return;
    this.pendingStart = false;
    if (resetStartTime) this.startTime = this.wallNow();
    this.resumeTimer();
  }

  schedule() {
    const tick = () => {
      const details = this.getTimeDetails();
      this.secondsRemaining = details.secondsRemaining;
      this.onTickCallback?.(details.secondsRemaining, this.promptId, details);
      if (details.remainingMs <= 0) {
        const promptId = this.promptId;
        const timerId = this.timerId;
        const expire = this.onExpireCallback;
        this.stopTimer();
        Promise.resolve().then(() => outsideOperation(() => expire?.(promptId, timerId))).catch((err) => {
          require('../utils/logger').error('Bidding timer expiration failed', err);
        });
      }
    };
    this.intervalId = setInterval(tick, 100);
    this.intervalId.unref?.();
  }

  pauseTimer() {
    if (this.isPaused) return this.getSecondsRemaining();
    this.remainingMsOnPause = this.getRemainingMs();
    clearInterval(this.intervalId);
    this.intervalId = null;
    this.isPaused = true;
    this._endsAt = null;
    this.deadline = null;
    this.pendingStart = false;
    this.secondsRemaining = Math.ceil(this.remainingMsOnPause / 1000);
    return this.secondsRemaining;
  }

  resumeTimer() {
    if (!this.isPaused) return this.getSecondsRemaining();
    this.isPaused = false;
    this.deadline = this.now() + this.remainingMsOnPause;
    this._endsAt = this.wallNow() + this.remainingMsOnPause;
    this.schedule();
    return this.getSecondsRemaining();
  }

  extendTimer(extraSeconds) {
    const extra = Number(extraSeconds);
    if (!Number.isFinite(extra) || extra <= 0) return this.getSecondsRemaining();
    this.durationSeconds += extra;
    if (this.isPaused) {
      this.remainingMsOnPause += extra * 1000;
    } else if (this.isRunning() && this.getRemainingMs() > 0) {
      this.deadline += extra * 1000;
      this._endsAt += extra * 1000;
    } else {
      // The deadline may have passed before a delayed interval got to stop.
      clearInterval(this.intervalId);
      this.intervalId = null;
      const remaining = extra * 1000;
      this.remainingMsOnPause = remaining;
      this.deadline = this.now() + remaining;
      this._endsAt = this.wallNow() + remaining;
      this.schedule();
    }
    this.secondsRemaining = this.getSecondsRemaining();
    return this.secondsRemaining;
  }

  stopTimer() {
    clearInterval(this.intervalId);
    this.intervalId = null;
    this.isPaused = false;
    this.secondsRemaining = 0;
    this.remainingMsOnPause = 0;
  }

  resetTimer() {
    this.stopTimer();
    this.promptId = null;
    this.timerId = null;
    this.durationSeconds = 0;
    this.startTime = null;
    this._endsAt = null;
    this.deadline = null;
    this.pendingStart = false;
    this.onTickCallback = null;
    this.onExpireCallback = null;
  }

  getSecondsRemaining() { return Math.ceil(this.getRemainingMs() / 1000); }
  getPromptId() { return this.promptId; }
  getStartTime() { return this.startTime; }
  getEndsAt() { return this._endsAt; }
  getDurationSeconds() { return this.durationSeconds; }
  getRemainingMs() {
    if (this.isPaused) return this.remainingMsOnPause;
    return this.isRunning() ? Math.max(0, this.deadline - this.now()) : 0;
  }
  hasExpired(toleranceMs = 0) {
    if (this.isPaused) return this.remainingMsOnPause <= 0;
    return !this.isRunning() || this.now() >= this.deadline + toleranceMs;
  }
  isExpired(toleranceMs = 0) { return this.hasExpired(toleranceMs); }
  isRunning() { return this.intervalId != null && !this.isPaused; }
  isTimerPaused() { return this.isPaused; }

  getTimeDetails() {
    const serverTime = this.wallNow();
    const remainingMs = this.getRemainingMs();
    return {
      timerStreamId: this.timerStreamId,
      timerSequence: ++this.timerSequence,
      serverMonotonicTime: this.now(),
      timerId: this.timerId,
      pendingStart: this.pendingStart,
      serverTime,
      serverTimeIso: new Date(serverTime).toISOString(),
      promptId: this.promptId,
      startTime: this.startTime,
      endsAt: this._endsAt,
      durationSeconds: this.durationSeconds,
      remainingMs,
      elapsedMs: Math.max(0, this.durationSeconds * 1000 - remainingMs),
      secondsRemaining: Math.ceil(remainingMs / 1000),
      isRunning: this.isRunning(),
      isPaused: this.isPaused,
      hasExpired: this.hasExpired()
    };
  }

  serialize() {
    return { ...this.getTimeDetails(), savedAt: this.wallNow() };
  }
}

module.exports = new TimerManager();
module.exports.TimerManager = TimerManager;
