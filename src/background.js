'use strict';

importScripts('core/danmaku-style.js', 'core/session-lifecycle.js', 'core/runtime.js', 'core/media-network.js', 'storage-backend.js');

globalThis.BiliLiveBar.installMediaProxy(chrome.runtime, globalThis.BiliLiveBar.readBoundedResponse);

const backend = globalThis.BiliLiveBarStorageBackend;
const updateSettings = globalThis.BiliLiveBar.createSettingsUpdater(chrome.storage.local);
const storageChannels = new Map();
const apiRequests = new Map();
const ACTIVE_SESSIONS_KEY = 'activeSessions';
const CLEANUP_ALARM = 'bililivebar-cache-cleanup';
const lifecycle = new globalThis.BiliLiveBar.SessionLifecycle({
  storage: chrome.storage.local, backend, tabs: chrome.tabs,
  probeSession: (tabId) => probeTab(tabId, { frameId: 0 })
});
const browserEpoch = chrome.storage.session.get('cacheBrowserEpoch').then(async (stored) => {
  if (stored.cacheBrowserEpoch) return stored.cacheBrowserEpoch;
  const epoch = crypto.randomUUID();
  await chrome.storage.session.set({ cacheBrowserEpoch: epoch });
  return epoch;
});
const DEFAULT_SETTINGS = {
  quality: 'auto',
  qualityPreferenceVersion: 2,
  danmakuOpacity: 0.9,
  danmakuFontFamily: 'sans',
  danmakuFontScale: 1,
  danmakuEmoteScale: 1,
  danmakuFontWeight: 600,
  danmakuSpeed: 1,
  danmakuArea: 0.75,
  danmakuFontBorder: 1,
  danmakuEnabled: true,
  danmakuScreenSync: false,
  danmakuSpeedSync: true,
  danmakuPreventShade: false,
  danmakuAvoidOverlap: true,
  danmakuBlockScroll: false,
  danmakuBlockTop: false,
  danmakuBlockBottom: false,
  danmakuBlockColor: false,
  danmakuBlockEmoji: false,
  danmakuBlockLottery: false,
  danmakuSettingsVersion: 2,
  keepBackgroundQuality: true,
  rewindSeconds: 30,
  forwardSeconds: 10,
  seekDirection: -1,
  liveBufferSeconds: 5,
  adaptiveBuffer: true,
  stallRecovery: 'resume',
  panelCollapsed: false,
  showPanelInFullscreen: true,
  showPanelInWebFullscreen: true,
  cacheSetupDone: false,
  storageMode: 'opfs',
  directoryId: '',
  directoryName: '',
  maxCacheSizeGB: 0,
  autoClearOnExit: true
};
let sessionMutation = Promise.resolve();

async function ensureDefaults() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const merged = globalThis.BiliLiveBar.normalizeQualitySettings(
    globalThis.BiliLiveBar.normalizeDanmakuScaleSettings(Object.assign({}, DEFAULT_SETTINGS, settings)));
  delete merged.prioritizeLivePlayback;
  delete merged.edgeBufferSeconds;
  delete merged.liveLatencyMode;
  if (Number(settings.qualityPreferenceVersion || 0) < 2) {
    merged.quality = 'auto';
    merged.qualityPreferenceVersion = 2;
  }
  if (Number(settings.danmakuSettingsVersion || 0) < 2) {
    merged.danmakuFontScale = 1;
    merged.danmakuFontBorder = Number.isFinite(Number(settings.danmakuShadow))
      ? Number(settings.danmakuShadow)
      : 1;
    merged.danmakuSettingsVersion = 2;
    delete merged.followNativeDanmakuStyle;
    delete merged.danmakuFontSize;
    delete merged.danmakuShadow;
  }
  await updateSettings(globalThis.BiliLiveBar.settingsPatch(settings, merged));
}

function isAllowedApiUrl(value) {
  try {
    const url = new URL(value);
    const paths = url.hostname === 'api.live.bilibili.com'
      ? ['/room/v1/Room/room_init', '/room/v1/Room/mobileRoomInit',
        '/xlive/web-room/v2/index/getRoomPlayInfo', '/xlive/web-room/v1/index/getDanmuInfo']
      : url.hostname === 'api.bilibili.com' ? ['/x/web-interface/nav'] : [];
    return url.protocol === 'https:' && !url.username && !url.password && paths.includes(url.pathname);
  } catch (_) {
    return false;
  }
}

async function fetchApiText(value, timeoutMs = 30000, controller = new AbortController()) {
  if (!isAllowedApiUrl(value)) throw new Error('拒绝代理非 Bilibili API 请求');
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(60000, Number(timeoutMs) || 30000)));
  try {
    const response = await fetch(value, {
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 超时覆盖响应体读取。
    return new TextDecoder().decode(await globalThis.BiliLiveBar.readBoundedResponse(response, 2 * 1024 * 1024));
  } finally {
    clearTimeout(timeout);
  }
}

function withSessionLock(task) {
  const run = async () => { lifecycle.epoch = await browserEpoch; return task(); };
  const next = sessionMutation.then(run, run);
  sessionMutation = next.catch(() => {});
  return next;
}

async function reconcileSessions() {
  const legacy = (await chrome.storage.session.get(ACTIVE_SESSIONS_KEY))[ACTIVE_SESSIONS_KEY] || {};
  await lifecycle.sweep(legacy);
  await chrome.storage.session.remove(ACTIVE_SESSIONS_KEY);
}

async function initializeCleanup() {
  // worker 重启后补建清理定时器。
  if (!await chrome.alarms.get(CLEANUP_ALARM)) await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 1 });
  await withSessionLock(reconcileSessions);
}

async function probeTab(tabId, options) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { source: 'bililivebar', type: 'session-probe' }, options),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), 2500); })
    ]);
  } finally { clearTimeout(timer); }
}

async function setBadge(tabId, recording, error) {
  const text = recording ? '●' : error ? '!' : '';
  const operations = [
    () => chrome.action.setBadgeText({ tabId, text }),
    () => chrome.action.setBadgeBackgroundColor({ tabId, color: error ? '#ff9f43' : '#fb7299' })
  ];
  await Promise.all(operations.map(async (operation) => {
    try { await operation(); } catch (_) { /* tab may have closed between the message and badge update */ }
  }));
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureDefaults().then(async () => {
    if (details.reason === 'install') await chrome.runtime.openOptionsPage();
  }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => { ensureDefaults().catch(console.error); });
chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage().catch(() => {}); });

chrome.tabs.onRemoved.addListener((tabId) => {
  withSessionLock(() => lifecycle.releaseTab(tabId)).catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || (changeInfo.url && !globalThis.BiliLiveBar.roomKey(changeInfo.url))) {
    withSessionLock(async () => {
      const entries = await lifecycle.entries();
      const owned = Object.values(entries).filter((entry) => entry.tabId === tabId);
      if (!owned.length) return;
      let current;
      try { current = await probeTab(tabId, { frameId: 0 }); }
      catch (_) { /* the old document is no longer receiving messages */ }
      if (current?.timedOut) return; // A frozen document is not proof of exit.
      for (const entry of owned) {
        if (entry.sessionId !== current?.sessionId) await lifecycle.retire(entries, entry);
      }
    }).catch(console.error);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) withSessionLock(reconcileSessions).catch(console.error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue
    && changes.settings.newValue.autoClearOnExit !== changes.settings.oldValue?.autoClearOnExit) {
    withSessionLock(() => lifecycle.configureAll(changes.settings.newValue.autoClearOnExit !== false)).catch(console.error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== 'bililivebar') return undefined;
  const tabId = sender.tab?.id;
  const owner = { tabId, documentId: sender.documentId, url: sender.url || '' };

  if (message.type === 'storage-hello') {
    if (tabId == null || !sender.documentId || sender.url?.split('#')[0] !== chrome.runtime.getURL('storage.html')) return undefined;
    const nonce = crypto.randomUUID();
    const entry = { tabId, frameDocumentId: sender.documentId, key: Array.from(crypto.getRandomValues(new Uint8Array(32))) };
    entry.timer = setTimeout(() => {
      storageChannels.delete(nonce);
      entry.reply?.({ ok: false, error: '存储授权超时' });
    }, 10000);
    storageChannels.set(nonce, entry);
    sendResponse({ ok: true, nonce });
    return undefined;
  }
  if (message.type === 'authorize-storage') {
    const entry = storageChannels.get(message.nonce);
    if (!entry || entry.ownerDocumentId || entry.tabId !== tabId || sender.frameId !== 0
      || !sender.documentId || !sender.url?.startsWith('https://live.bilibili.com/')) {
      sendResponse({ ok: false, error: '存储授权被拒绝' });
      return undefined;
    }
    entry.ownerDocumentId = sender.documentId;
    sendResponse({ ok: true, key: entry.key });
    entry.reply?.({ ok: true, key: entry.key, ownerDocumentId: entry.ownerDocumentId });
    return undefined;
  }
  if (message.type === 'storage-key') {
    const entry = storageChannels.get(message.nonce);
    if (!entry || entry.tabId !== tabId || entry.frameDocumentId !== sender.documentId) {
      sendResponse({ ok: false, error: '存储授权被拒绝' });
      return undefined;
    }
    const reply = (value) => {
      clearTimeout(entry.timer);
      storageChannels.delete(message.nonce);
      sendResponse(value);
    };
    if (entry.ownerDocumentId) reply({ ok: true, key: entry.key, ownerDocumentId: entry.ownerDocumentId });
    else entry.reply = reply;
    return true;
  }
  if (message.type === 'bind-storage-session') {
    if (sender.url?.split('#')[0] !== chrome.runtime.getURL('storage.html')) return undefined;
    withSessionLock(async () => {
      const entry = (await lifecycle.entries())[message.sessionId];
      if (!entry || entry.tabId !== tabId || entry.documentId !== message.ownerDocumentId
        || entry.pending) throw new Error('缓存会话不属于当前页面');
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'update-settings') {
    updateSettings(message.patch).then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'fetch-api') {
    const key = `${sender.documentId}:${message.requestId}`;
    const controller = new AbortController();
    apiRequests.set(key, controller);
    fetchApiText(message.url, message.timeoutMs, controller)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), errorName: error.name }))
      .finally(() => { if (apiRequests.get(key) === controller) apiRequests.delete(key); });
    return true;
  }
  if (message.type === 'cancel-api') {
    apiRequests.get(`${sender.documentId}:${message.requestId}`)?.abort();
    sendResponse({ ok: true });
    return undefined;
  }

  if (message.type === 'state' && tabId != null) {
    setBadge(tabId, message.recording, message.error).catch(() => {});
    return undefined;
  }
  if (message.type === 'open-options') {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'register-session' && tabId != null) {
    withSessionLock(async () => {
      // 创建缓存前核对文档身份；同 URL 刷新仍属于不同文档。
      const probe = await probeTab(tabId, sender.documentId ? { documentId: sender.documentId } : { frameId: 0 });
      if (probe?.sessionId !== message.session?.id) throw new Error('直播页面已离开');
      return lifecycle.register(owner, message.session, message.autoClearOnExit);
    })
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'session-settings' && tabId != null) {
    withSessionLock(() => lifecycle.configure(message.sessionId, owner, message.autoClearOnExit))
      .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'release-session' && tabId != null) {
    withSessionLock(() => lifecycle.release(message.sessionId, owner))
      .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'retry-cleanup') {
    withSessionLock(reconcileSessions).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return undefined;
});

initializeCleanup().catch(console.error);
