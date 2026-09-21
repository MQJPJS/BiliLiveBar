(function initNativeControls(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function nativeControlsFactory() {
  'use strict';
  const normalize = (value) => String(value || '').replace(/\s|画质|清晰度|VIP|会员|推荐/gi, '');
  function nativeQualityValue(node, options = []) {
    const label = normalize(node.getAttribute?.('data-title') || node.textContent);
    if (!label || label.length > 32 || /自动|后台|开通|解锁|试看/.test(label)
      || node.disabled || node.closest?.('[aria-disabled="true"],[disabled],[class*="disabled"],[class*="locked"]')) return null;
    const explicit = Number(node.getAttribute?.('data-qn') || node.getAttribute?.('data-quality'));
    const matched = options.find((item) => normalize(item.label) === label);
    const fallback = { '杜比': 40000, '杜比视界': 40000, 'HDR': 30000, '原画真彩': 25000,
      '8K': 50000, '4K': 20000, '2K': 15000, '原画': 10000, '蓝光': 10000,
      '超清': 400, '高清': 250, '流畅': 80 }[label.toUpperCase()];
    const qn = explicit > 0 ? explicit : Number(matched?.qn || fallback);
    return qn > 0 && Number.isFinite(qn) ? { qn, label } : null;
  }
  return { nativeQualityValue };
});
