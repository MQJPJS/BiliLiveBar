(function initTimeline(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function timelineFactory() {
  'use strict';

  // 每次 MSE 加载的时间原点固定；追加或 seekRange 变化不得重设。
  function mapTimeline(records, previous = []) {
    const result = previous.slice();
    const ids = new Set(result.map((record) => record.id));
    let cursor = result.length
      ? result[result.length - 1].playStartSeconds + result[result.length - 1].playDurationSeconds
      : 0;
    const ordered = records.slice().sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
    for (const record of ordered) {
      if (ids.has(record.id)) continue;
      if (result.length && record.startMs < result[result.length - 1].startMs) continue;
      const duration = Number(record.mediaDurationMs || record.durationMs) / 1000;
      if (!Number.isFinite(duration) || duration <= 0) continue;
      result.push(Object.assign({}, record, { playStartSeconds: cursor, playDurationSeconds: duration }));
      ids.add(record.id);
      cursor += duration;
    }
    return result;
  }

  function recordAtWall(records, wallMs) {
    let low = 0;
    let high = records.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (records[middle].startMs <= wallMs) low = middle + 1;
      else high = middle;
    }
    const record = records[low - 1];
    return record && wallMs < record.startMs + record.durationMs ? record : null;
  }

  function wallToMedia(records, wallMs) {
    const record = recordAtWall(records, wallMs);
    if (!record) return null; // A real cache gap is not a request for LIVE.
    return record.playStartSeconds + (wallMs - record.startMs) / record.durationMs * record.playDurationSeconds;
  }

  function mediaToWall(records, mediaSeconds) {
    if (!records.length || !Number.isFinite(mediaSeconds)) return null;
    let low = 0;
    let high = records.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (records[middle].playStartSeconds <= mediaSeconds) low = middle + 1;
      else high = middle;
    }
    const record = records[Math.max(0, low - 1)];
    const within = Math.max(0, Math.min(record.playDurationSeconds, mediaSeconds - record.playStartSeconds));
    return record.startMs + within / record.playDurationSeconds * record.durationMs;
  }

  function contiguousTailStart(records) {
    if (!records.length) return null;
    let index = records.length - 1;
    while (index > 0) {
      const previous = records[index - 1];
      if (records[index].startMs - (previous.startMs + previous.durationMs) > 50) break;
      index--;
    }
    return records[index].startMs;
  }

  // 只在实际 MSE/seek 交集中修正小型前向缺口，不回退或大幅跳转。
  function nearestBufferedLanding(records, targetMs, ranges, seekRange, maxAdvanceMs = 2000) {
    const desired = wallToMedia(records, targetMs);
    if (desired == null) return null;
    const available = ranges.map(([start, end]) => [Math.max(start, seekRange.start), Math.min(end, seekRange.end)])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
      .sort((a, b) => a[0] - b[0]);
    if (available.some(([start, end]) => desired >= start && desired < end)) return null;
    for (const [start, end] of available) {
      if (start <= desired || end - start < 0.065) continue;
      const mediaTime = start + 0.015; // Inside the interval, not its rounding boundary.
      const wallMs = mediaToWall(records, mediaTime);
      const roundTrip = wallMs == null ? null : wallToMedia(records, wallMs);
      if (wallMs > targetMs && wallMs - targetMs <= maxAdvanceMs
        && roundTrip != null && Math.abs(roundTrip - mediaTime) < 0.002) return { mediaTime, wallMs };
    }
    return null;
  }

  return { mapTimeline, recordAtWall, wallToMedia, mediaToWall, nearestBufferedLanding, contiguousTailStart };
});
