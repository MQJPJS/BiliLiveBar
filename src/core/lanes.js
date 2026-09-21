(function initDanmakuLanes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function lanesFactory() {
  'use strict';
  // 使用动画时间，防止暂停或变速时过早释放弹幕轨道。
  function findDanmakuLane({ width, height, screenWidth, areaHeight, duration, mode }, active) {
    const gap = 6;
    const bottom = areaHeight - height - 8;
    if (!(width > 0 && height > 0 && screenWidth > 0 && duration > 0) || bottom < 8) return null;
    const scrolling = mode !== 4 && mode !== 5;
    const speed = (screenWidth + width + 20) / duration;
    const positions = [];
    for (let y = 8; y <= bottom; y += height + gap) positions.push(y);
    if (mode === 4) positions.reverse();
    for (const y of positions) {
      const fits = active.every((other) => {
        if (other.elapsed >= other.duration) return true;
        if (y + height + gap <= other.y || other.y + other.height + gap <= y) return true;
        if (!scrolling || other.mode === 4 || other.mode === 5) return false;
        const oldSpeed = (other.screenWidth + other.width + 20) / other.duration;
        const right = other.screenWidth - oldSpeed * Math.max(0, other.elapsed) + other.width;
        if (right <= -gap) return true;
        const clearance = screenWidth - right - gap;
        if (clearance < 0) return false;
        // 前一弹幕完全离屏前，后一弹幕不能追上它。
        return speed <= oldSpeed || clearance >= (speed - oldSpeed) * (right + gap) / oldSpeed;
      });
      if (fits) return y;
    }
    return null; // 无空位只跳过显示，不删除缓存。
  }
  return { findDanmakuLane };
});
