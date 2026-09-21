(function initTimeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function timeCoreFactory() {
  'use strict';

  function formatDuration(milliseconds) {
    const total = Math.max(0, Math.floor(Math.abs(milliseconds) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = -1;
    do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function formatRate(bytesPerSecond) {
    const value = Number(bytesPerSecond || 0);
    return value > 0 ? `${formatBytes(value)}/s` : '-- MB/s';
  }

  function normalizeSeekSeconds(value, fallback = 30) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 3600
      ? Math.round(parsed * 10) / 10 : fallback;
  }

  return {
    formatDuration,
    formatBytes,
    formatRate,
    normalizeSeekSeconds
  };
});
