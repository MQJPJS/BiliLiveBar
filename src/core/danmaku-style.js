(function initDanmakuStyle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function danmakuStyleFactory() {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function normalizeDanmakuScaleSettings(settings = {}) {
    const next = { ...settings };
    // 旧默认值仅迁移一次，之后保留用户选择。
    if (!(Number(next.danmakuScaleSettingsVersion) >= 1)) {
      next.danmakuScreenSync = false;
      next.danmakuScaleSettingsVersion = 1;
    } else next.danmakuScreenSync = next.danmakuScreenSync === true;
    return next;
  }

  function screenScale(style, layerHeight) {
    const height = Number(layerHeight);
    return style.screenSync === true
      ? clamp(Number.isFinite(height) && height > 0 ? height / 440 : 1, 0.65, 1.8) : 1;
  }

  function danmakuScrollDuration(width, screenWidth, style, layerHeight) {
    const speed = Number(style.speedPlus);
    const factor = Number.isFinite(speed) && speed > 0 ? clamp(speed, 0.4, 1.6) : 1;
    const distance = Math.max(0, Number(width) || 0) + Math.max(0, Number(screenWidth) || 0) + 20;
    // 固定像素速度，避免固定横穿时长导致宽屏加速。
    return distance * 1000 / (120 * factor * screenScale(style, layerHeight));
  }

  function danmakuFontPixels(item, style, layerHeight) {
    const size = Number(item.fontSize);
    const scale = Number(style.fontSizeScale);
    const screen = screenScale(style, layerHeight);
    // 先规范协议字号，再应用用户缩放，避免小表情被最小字号锁死。
    const base = clamp(Number.isFinite(size) && size > 0 ? size : 25, 12, 50);
    return clamp(base * (Number.isFinite(scale) && scale > 0 ? scale : 1) * screen, 4.8, 80);
  }

  function danmakuEmotePixels(fontPixels, large = false) {
    const font = clamp(Number(fontPixels) || 25, 4.8, 80);
    return { size: font * (large ? 2.15 : 1.35), margin: font * 0.08,
      baseline: font * (large ? -0.65 : -0.25) };
  }

  return { normalizeDanmakuScaleSettings, danmakuFontPixels, danmakuEmotePixels, danmakuScrollDuration };
});
