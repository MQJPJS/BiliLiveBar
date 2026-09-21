(function initBufferCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function bufferFactory() {
  'use strict';

  const bounded = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
  const percentile = (values, fraction) => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  };

  class LiveBufferPolicy {
    constructor({ seconds = 5, adaptive = true } = {}) {
      this.seconds = bounded(seconds, 0, 10);
      this.adaptive = adaptive;
      this.samples = [];
      this.extra = 0;
      this.lastStallAt = -Infinity;
      this.healthySince = null;
    }
    configure(seconds, adaptive) {
      this.seconds = bounded(seconds, 0, 10);
      this.adaptive = adaptive !== false;
      if (!this.adaptive) this.extra = 0;
    }
    observe({ durationMs, downloadMs, commitMs, intervalMs = 0 }) {
      if (!(durationMs > 0) || durationMs > 60000) return;
      this.samples.push({
        // 交付间隔不是端到端直播延迟。
        delivery: Math.max(bounded(durationMs / 1000, 0, 10),
          bounded(downloadMs / 1000, 0, 10) + bounded(commitMs / 1000, 0, 10)) + 0.5,
        interval: bounded(intervalMs / 1000, 0, 10)
      });
      if (this.samples.length > 24) this.samples.shift();
    }
    target() {
      if (!this.adaptive) return this.seconds;
      const estimate = Math.max(percentile(this.samples.map((s) => s.delivery), 0.9),
        percentile(this.samples.map((s) => s.interval), 0.9) + (this.samples.length ? 0.5 : 0));
      return bounded(Math.max(this.seconds, estimate) + this.extra, 0, 10);
    }
    stalled(now, lowBuffer) {
      this.healthySince = null;
      if (!this.adaptive || !lowBuffer || now - this.lastStallAt < 10000) return false;
      this.lastStallAt = now;
      this.extra = Math.min(3, this.extra + 0.5);
      return true;
    }
    healthy(now, enoughData) {
      if (!enoughData) { this.healthySince = null; return false; }
      if (this.healthySince == null) this.healthySince = now;
      if (this.extra > 0 && now - this.healthySince >= 60000) {
        this.extra = Math.max(0, this.extra - 0.5);
        this.healthySince = now;
        return true;
      }
      return false;
    }
  }

  // 结合媒体时钟与连续 MSE 判断停滞，后台缺帧回调不代表故障。
  class PlaybackHealth {
    reset(now, mediaTime) {
      this.sampleAt = this.progressAt = this.startedAt = now;
      this.mediaTime = mediaTime;
      this.stallAt = null;
    }
    sample({ now, mediaTime, aheadSeconds, frame, revision, visible = true,
      playing = true, seeking = false, engineBuffering = false, rebufferGoal = 0.5 }) {
      if (this.sampleAt == null || now < this.sampleAt || now - this.sampleAt > 2500
        || mediaTime < this.mediaTime - 0.05 || !playing || seeking) this.reset(now, mediaTime);
      if (mediaTime > this.mediaTime + 0.005) this.progressAt = now;
      this.sampleAt = now;
      this.mediaTime = mediaTime;
      const mediaAgeMs = Math.max(0, now - this.progressAt);
      const frameAgeMs = frame?.revision === revision ? Math.max(0, now - frame.observedAt) : null;
      const frameStalled = visible && frameAgeMs != null && frameAgeMs >= 1800 && now - this.startedAt >= 1800;
      let kind = !playing || seeking ? 'idle' : 'playing';
      if (playing && !seeking && (mediaAgeMs >= 1200 || frameStalled)) {
        kind = aheadSeconds >= 0.5 && (!engineBuffering || aheadSeconds >= rebufferGoal + 0.1)
          ? 'buffered-stall' : engineBuffering && aheadSeconds >= 0.25 ? 'rebuffering' : 'waiting-data';
      }
      if (kind === 'playing' || kind === 'idle') this.stallAt = null;
      else this.stallAt ??= now;
      return { kind, mediaAgeMs, frameAgeMs, visible, aheadSeconds,
        stalledForMs: this.stallAt == null ? 0 : now - this.stallAt };
    }
  }

  // 最多预取两个片段，按源顺序提交。
  async function orderedPrefetch(items, load, consume, signal) {
    const pending = [];
    let next = 0;
    const aborted = () => {
      if (signal?.aborted) { const error = new Error('分片预取已取消'); error.name = 'AbortError'; throw error; }
    };
    const fill = () => {
      aborted();
      while (pending.length < 2 && next < items.length) {
        const item = items[next++];
        const promise = Promise.resolve().then(() => { aborted(); return load(item); })
          .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
        pending.push({ item, promise });
      }
    };
    fill();
    while (pending.length) {
      const { item, promise } = pending[0];
      const result = await promise;
      aborted();
      if (!result.ok) throw result.error;
      await consume(item, result.value);
      pending.shift();
      fill();
    }
  }

  function withDeadline(operation, milliseconds, onTimeout = () => {}) {
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        try { Promise.resolve(onTimeout()).catch(() => {}); } catch (_) { /* best effort abort */ }
        const error = new Error('播放器加载超时，等待重试');
        error.name = 'TimeoutError';
        reject(error);
      }, milliseconds);
      Promise.resolve(operation).then(resolve, reject);
    }).finally(() => clearTimeout(timer));
  }

  return { LiveBufferPolicy, PlaybackHealth, orderedPrefetch, withDeadline };
});
