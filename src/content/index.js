(async function startBiliLiveBar(global) {
  'use strict';
  if (global.__bililivebarStarted) return;
  global.__bililivebarStarted = true;
  const BLB = global.BiliLiveBar;
  const entryAt = Date.now();
  let pageExited = false;
  let registeredSessionId = '';
  let dispose = () => {};
  const settingsEvents = chrome.storage?.onChanged;
  // 先注册退出处理，覆盖异步启动阶段。
  global.addEventListener('pagehide', () => {
    pageExited = true;
    dispose();
    releaseSession();
  }, { once: true });
  global.addEventListener('pageshow', (event) => { if (event.persisted && pageExited) location.reload(); });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.source === 'bililivebar' && message.type === 'session-probe') {
      respond({ sessionId: pageExited || !global.chrome?.runtime?.id ? '' : registeredSessionId });
    }
  });

  async function releaseSession() {
    const sessionId = registeredSessionId;
    registeredSessionId = '';
    if (!sessionId) return;
    try { await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'release-session', sessionId }); }
    catch (_) { /* 持久清理任务负责补偿重试。 */ }
  }

  function reportState(recording, error = false) {
    try { chrome.runtime.sendMessage({ source: 'bililivebar', type: 'state', recording, error }).catch(() => {}); }
    catch (_) { /* extension reload */ }
  }

  function getRoomHint() {
    const params = new URL(location.href).searchParams;
    return location.pathname.match(/^\/(?:(?:blanc|h5)\/)?(\d+)/)?.[1]
      || params.get('room_id')
      || params.get('roomid')
      || params.get('cid')
      || '';
  }

  async function resolveRoomId(hint, storage) {
    if (!hint) throw new Error('当前页面不是数字直播间地址');
    const request = async (pathname) => {
      const url = new URL(`https://api.live.bilibili.com${pathname}`);
      url.searchParams.set('id', hint);
      return JSON.parse((await storage.fetchResource(url.href, 'text')).text);
    };
    let result;
    try { result = await request('/room/v1/Room/room_init'); }
    catch (_) { result = null; }
    if (result?.code !== 0 || !result?.data?.room_id) {
      const fallback = await request('/room/v1/Room/mobileRoomInit');
      if (fallback.code === 0 && fallback.data?.room_id) result = fallback;
      else throw new Error(fallback.message || result?.message || '直播间不存在或房间信息接口不可用');
    }
    if (result.data.encrypted && !result.data.pwd_verified) {
      throw new Error('该直播间需要先在 B 站播放器中完成密码验证');
    }
    return result.data;
  }

  function createSession(roomId) {
    // 缓存属于文档；sessionStorage 会随复制标签页共享，不能用于归属判定。
    return {
      id: `${roomId}-${entryAt}-${crypto.randomUUID().slice(0, 8)}`,
      roomId: String(roomId),
      startedAt: entryAt,
      timelineVersion: 3
    };
  }

  const PLAYER_ROOT_SELECTOR = [
    '#live-player', '.live-player-mounter', '.web-player-container',
    '.web-player-module-area', '.player-container', '[data-e2e="live-player"]',
    '[class*="player-wrap"]', '[class*="player-container"]'
  ].join(',');
  const NATIVE_DANMAKU_HIDDEN_CLASS = 'bililivebar-native-danmaku-hidden';
  let nativeDanmakuVisible = true;
  let managedPlaybackActive = false;
  const controlDocuments = new WeakSet();
  let backgroundQualityProtectionEnabled = true;
  let configuredBridgeDocuments = new WeakSet();

  function applyNativeDanmakuClass(root) {
    if (root?.nodeType === Node.DOCUMENT_NODE) {
      root.documentElement?.classList.toggle(NATIVE_DANMAKU_HIDDEN_CLASS, !(nativeDanmakuVisible && !managedPlaybackActive));
    } else if (root?.host) {
      root.host.classList.toggle(NATIVE_DANMAKU_HIDDEN_CLASS, !(nativeDanmakuVisible && !managedPlaybackActive));
    }
  }

  function configureDocumentBridge(root) {
    if (root?.nodeType !== Node.DOCUMENT_NODE || configuredBridgeDocuments.has(root)) return;
    configuredBridgeDocuments.add(root);
    root.documentElement?.toggleAttribute('data-bililivebar-managed', managedPlaybackActive);
    if (!controlDocuments.has(root)) {
      controlDocuments.add(root);
      root.addEventListener('click', onNativeControl, true);
    }
    try {
      root.defaultView?.postMessage({
        source: 'bililivebar-content',
        type: 'background-quality',
        enabled: backgroundQualityProtectionEnabled
      }, root.location?.origin || location.origin);
    } catch (_) { /* detached same-origin player frame */ }
  }

  function renderedArea(element) {
    if (!element?.getBoundingClientRect) return 0;
    const view = element.ownerDocument?.defaultView || global;
    const rect = element.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 90) return 0;
    for (let node = element, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.02) return 0;
    }
    const width = Math.max(0, Math.min(rect.right, view.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, view.innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function videoScore(video, fullscreen) {
    if (fullscreen && !composedContains(fullscreen, video)) return -Infinity;
    const area = renderedArea(video);
    const mediaArea = Number(video.videoWidth || 0) * Number(video.videoHeight || 0);
    return area
      + Math.min(mediaArea, 3840 * 2160) * 2
      + Number(video.readyState || 0) * 20_000_000
      + (!video.paused && !video.ended ? 50_000_000 : 0)
      + (video.currentSrc || video.srcObject ? 30_000_000 : 0)
      + (!video.muted && Number(video.volume) > 0 ? 10_000_000 : 0);
  }

  function rootPriority(root) {
    if (root.id === 'live-player') return 5;
    if (root.matches('[data-e2e="live-player"]')) return 4;
    if (root.matches('.live-player-mounter')) return 3;
    if (root.matches('.web-player-container,.web-player-module-area')) return 2;
    return 1;
  }

  function composedContains(container, node) {
    for (let current = node; current;) {
      if (current === container) return true;
      if (current.parentNode) current = current.parentNode;
      else if (current.host) current = current.host;
      else {
        try { current = (current.defaultView || current.ownerDocument?.defaultView)?.frameElement || null; }
        catch (_) { current = null; }
      }
    }
    return false;
  }

  function deepRoots() {
    const roots = [document];
    const seen = new Set(roots);
    for (let index = 0; index < roots.length; index += 1) {
      const scope = roots[index];
      applyNativeDanmakuClass(scope);
      configureDocumentBridge(scope);
      let elements = [];
      try { elements = scope.querySelectorAll('*'); } catch (_) { /* detached frame/root */ }
      for (const element of elements) {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          roots.push(element.shadowRoot);
        }
        if (element.tagName === 'IFRAME') {
          try {
            const frameDocument = element.contentDocument;
            if (frameDocument?.documentElement && !seen.has(frameDocument)) {
              seen.add(frameDocument);
              roots.push(frameDocument);
            }
          } catch (_) { /* cross-origin player frames cannot be traversed */ }
        }
      }
    }
    return roots;
  }

  function deepQueryAll(selector) {
    const matches = [];
    for (const root of deepRoots()) {
      try { matches.push(...root.querySelectorAll(selector)); } catch (_) { /* stale root */ }
    }
    return matches;
  }

  function videoFullscreenHost(video) {
    const ownerDocument = video?.ownerDocument || document;
    const localFullscreen = ownerDocument.fullscreenElement || ownerDocument.webkitFullscreenElement || null;
    if (localFullscreen && composedContains(localFullscreen, video)) return localFullscreen;
    const topFullscreen = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (!topFullscreen) return null;
    if (ownerDocument === document && composedContains(topFullscreen, video)) return topFullscreen;
    try {
      const frame = ownerDocument.defaultView?.frameElement;
      if (frame && composedContains(topFullscreen, frame)) {
        return localFullscreen || ownerDocument.body || ownerDocument.documentElement;
      }
    } catch (_) { /* detached/cross-origin frame */ }
    return null;
  }

  function findPlayer() {
    const videos = deepQueryAll('video:not(.bililivebar-replay-video)');
    const fullscreenVideos = videos.filter((video) => Boolean(videoFullscreenHost(video)));
    const pool = fullscreenVideos.length ? fullscreenVideos : videos;
    const video = pool.sort((a, b) => videoScore(b, videoFullscreenHost(b)) - videoScore(a, videoFullscreenHost(a)))[0];
    if (!video || videoScore(video, videoFullscreenHost(video)) === -Infinity) return null;

    const localScope = video.getRootNode?.() || video.ownerDocument || document;
    // fullscreenElement 可能包含菜单和礼物；历史层必须挂到真实播放器根。
    const roots = Array.from(localScope.querySelectorAll(PLAYER_ROOT_SELECTOR))
      .filter((candidate) => candidate.contains(video) && renderedArea(candidate));
    roots.sort((a, b) => rootPriority(b) - rootPriority(a) || renderedArea(b) - renderedArea(a));
    let root = roots[0] || video.closest(PLAYER_ROOT_SELECTOR) || videoFullscreenHost(video);
    if (!root) {
      root = video.parentElement;
      for (let depth = 0; depth < 6 && root?.parentElement; depth += 1) {
        const rect = root.getBoundingClientRect();
        if (rect.width >= video.clientWidth && rect.height >= video.clientHeight) break;
        root = root.parentElement;
      }
    }
    return root ? { root, video } : null;
  }

  function getWebFullscreenHost(root, video) {
    const ownerDocument = video?.ownerDocument || document;
    const view = ownerDocument.defaultView || global;
    if (!root || videoFullscreenHost(video)) return null;
    const localScope = video?.getRootNode?.() || ownerDocument;
    const candidates = new Set([root, ownerDocument.body, ownerDocument.documentElement]);
    for (let node = root, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) candidates.add(node);
    try {
      const centerStack = ownerDocument.elementsFromPoint(view.innerWidth / 2, view.innerHeight / 2);
      for (const element of centerStack) {
        for (let node = element, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
          candidates.add(node);
        }
      }
    } catch (_) { /* document may be changing during fullscreen transition */ }
    const selectors = [
      '[class*="web-full"]', '[class*="web_full"]', '[class*="page-full"]',
      '[class*="page_full"]', '[class*="fullscreen"]', '[class*="full-screen"]',
      '[class*="fullpage"]', '[class*="full_page"]', '[class*="player-full"]',
      '[class*="full-win"]', '[class*="full_win"]', 'dialog[open]'
    ].join(',');
    for (const node of localScope.querySelectorAll(selectors)) candidates.add(node);
    try {
      for (const node of localScope.querySelectorAll('[popover]:popover-open')) candidates.add(node);
    } catch (_) { /* older Chromium without the popover selector */ }

    const matches = Array.from(candidates).filter((node) => {
      if (!node?.getBoundingClientRect || !node.matches) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const tokens = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`;
      const containsVideo = !video || composedContains(node, video);
      const topLayer = node.matches('dialog[open]') || node.matches('[popover]');
      const explicitlyFullscreen = /(?:web|page)[-_ ]?full(?:screen)?|full[-_ ]?(?:web|page|win)|fullpage|player[-_ ]?full/i.test(tokens);
      const fillsViewport = rect.left <= 3 && rect.top <= 3
        && rect.width >= view.innerWidth * 0.94
        && rect.height >= view.innerHeight * 0.88;
      return fillsViewport && (topLayer || explicitlyFullscreen || (containsVideo && style.position === 'fixed'));
    });
    matches.sort((a, b) => {
      const aTopLayer = a.matches('dialog[open]') || a.matches('[popover]') ? 1 : 0;
      const bTopLayer = b.matches('dialog[open]') || b.matches('[popover]') ? 1 : 0;
      const aExplicit = /(?:web|page)[-_ ]?full|full[-_ ]?(?:web|page|win)|fullpage|player[-_ ]?full/i
        .test(`${a.id || ''} ${typeof a.className === 'string' ? a.className : ''}`) ? 1 : 0;
      const bExplicit = /(?:web|page)[-_ ]?full|full[-_ ]?(?:web|page|win)|fullpage|player[-_ ]?full/i
        .test(`${b.id || ''} ${typeof b.className === 'string' ? b.className : ''}`) ? 1 : 0;
      return bTopLayer - aTopLayer || bExplicit - aExplicit || renderedArea(a) - renderedArea(b);
    });
    return matches[0] || null;
  }

  function isViewportHost(node) {
    if (!node?.isConnected || !node.getBoundingClientRect) return false;
    const view = node.ownerDocument?.defaultView || global;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const tokens = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`;
    const explicitlyFullscreen = /(?:web|page)[-_ ]?full(?:screen)?|full[-_ ]?(?:web|page|win)|fullpage|player[-_ ]?full/i.test(tokens);
    let topLayer = Boolean(node.matches?.('dialog[open]'));
    try { topLayer ||= Boolean(node.matches?.('[popover]:popover-open')); } catch (_) { /* older Chromium */ }
    return (explicitlyFullscreen || topLayer || style.position === 'fixed')
      && style.display !== 'none' && style.visibility !== 'hidden'
      && rect.left <= 4 && rect.top <= 4
      && rect.width >= view.innerWidth * 0.93
      && rect.height >= view.innerHeight * 0.86;
  }

  function setBackgroundQualityProtection(enabled) {
    backgroundQualityProtectionEnabled = Boolean(enabled);
    configuredBridgeDocuments = new WeakSet();
    for (const root of deepRoots()) configureDocumentBridge(root);
  }

  function setNativeDanmakuVisibility(enabled, synchronizeControl = false) {
    nativeDanmakuVisible = Boolean(enabled);
    for (const root of deepRoots()) {
      applyNativeDanmakuClass(root);
      if (root?.nodeType !== Node.DOCUMENT_NODE) continue;
      try {
        root.defaultView?.postMessage({
          source: 'bililivebar-content',
          type: 'danmaku-visible',
          enabled: nativeDanmakuVisible && !managedPlaybackActive,
          synchronizeControl: Boolean(synchronizeControl && !managedPlaybackActive)
        }, root.location?.origin || location.origin);
      } catch (_) { /* detached same-origin player frame */ }
    }
  }

  function onNativeControl(event) {
    if (pageExited || !event.isTrusted) return;
    const nodes = event.composedPath?.() || [event.target];
    const target = nodes.find((node) => node?.nodeType === 1);
    if (!target || target.closest('.bililivebar-controls,.bililivebar-popover')) return;
    const normalize = (text) => String(text || '').replace(/\s|画质|清晰度|VIP|会员|推荐/gi, '');
    const qualityHost = nodes.find((node) => node?.matches?.(
      '[class*="quality"],[class*="definition"],[data-qn]'
    ));
    if (qualityHost) {
      const label = normalize(target.getAttribute('data-title') || target.textContent);
      const explicit = Number(target.closest('[data-qn]')?.getAttribute('data-qn') || 0);
      const match = (recorder?.qualityOptions || []).find((item) =>
        (explicit && item.qn === explicit) || normalize(item.label) === label
      );
      const preference = /^(自动|自动最高)$/.test(label) ? 'auto'
        : match?.qn ?? BLB.nativeQualityValue(target, recorder?.qualityOptions || [])?.qn;
      if (preference != null) {
        ui?.selectQuality(preference);
        // 保留原生画质菜单行为，但不允许其重载改写统一播放位置。
      }
      return;
    }
    if (!managedPlaybackActive) {
      if (target.closest('.web-player-icon-volume,[class*="volume-icon"],[class*="mute-icon"]')) {
        // 等待原生控件处理后保存用户意图；合成事件不算用户操作。
        const native = replay?.nativeVideo;
        if (native) global.setTimeout(() => {
          if (!pageExited && !replay.active && replay.nativeVideo === native) {
            replay.applyAudio({ volume: native.volume, muted: native.muted });
          }
        }, 0);
      }
      return;
    }
    if (target.closest('.web-player-icon-play,.web-player-icon-pause,[class*="play-btn"],[class*="pause-btn"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      replay.togglePause();
    } else if (target.closest('.web-player-icon-volume,[class*="volume-icon"],[class*="mute-icon"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      replay.setMuted(!replay.audioState().muted);
    }
  }

  let storage;
  let recorder;
  let danmaku;
  let replay;
  let renderer;
  let ui;
  let refreshTimer = 0;
  let mountTimer = 0;
  let statsTimer = 0;
  let mountTimers = [];
  let settingsChangedHandler = null;
  let settingsSnapshot = null;
  let lastWebFullscreenHost = null;
  let lastRecorderStatus = { state: 'waiting', text: '正在启动缓存…' };
  let danmakuWarningVisible = false;
  let onlineHandler = null;
  let healthTimer = 0;
  let disposed = false;
  dispose = () => {
    if (disposed) return;
    disposed = true;
    pageExited = true;
    clearInterval(healthTimer);
    clearInterval(refreshTimer);
    clearInterval(mountTimer);
    clearInterval(statsTimer);
    for (const timer of mountTimers) clearTimeout(timer);
    if (onlineHandler) global.removeEventListener('online', onlineHandler);
    // 单个组件或失效 API 不得阻断其余清理及原生播放器恢复。
    for (const cleanup of [
      () => { managedPlaybackActive = false; setNativeDanmakuVisibility(true, false); },
      () => setBackgroundQualityProtection(false),
      () => recorder?.stop(), () => danmaku?.stop(), () => renderer?.destroy(),
      () => replay?.destroy(), () => ui?.destroy(), () => storage?.destroy(),
      () => { if (settingsChangedHandler) settingsEvents?.removeListener(settingsChangedHandler); }
    ]) { try { cleanup(); } catch (_) { /* disabled/reloaded extension */ } }
    reportState(false);
  };

  const roomHint = getRoomHint();
  if (!roomHint) {
    setBackgroundQualityProtection(false);
    global.__bililivebarStarted = false;
    reportState(false);
    return;
  }

  healthTimer = global.setInterval(() => {
    try { if (!global.chrome?.runtime?.id) dispose(); }
    catch (_) { dispose(); }
  }, 3000);

  try {
    storage = new BLB.StorageClient();
    await storage.ready();
    const [{ settings = {} }, room] = await Promise.all([
      chrome.storage.local.get('settings'),
      resolveRoomId(roomHint, storage)
    ]);
    const mergedSettings = Object.assign({
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
      storageMode: 'opfs',
      directoryId: '',
      directoryName: '',
      maxCacheSizeGB: 0,
      autoClearOnExit: true
    }, settings);
    Object.assign(mergedSettings, BLB.normalizeDanmakuScaleSettings(mergedSettings));
    Object.assign(mergedSettings, BLB.normalizeQualitySettings(mergedSettings));
    if (Number(settings.qualityPreferenceVersion || 0) < 2) {
      mergedSettings.quality = 'auto';
      mergedSettings.qualityPreferenceVersion = 2;
    }
    if (Number(settings.danmakuSettingsVersion || 0) < 2) {
      mergedSettings.danmakuFontScale = 1;
      mergedSettings.danmakuFontBorder = Number.isFinite(Number(settings.danmakuShadow))
        ? Number(settings.danmakuShadow)
        : 1;
      mergedSettings.danmakuSettingsVersion = 2;
      delete mergedSettings.followNativeDanmakuStyle;
      delete mergedSettings.danmakuFontSize;
      delete mergedSettings.danmakuShadow;
    }
    delete mergedSettings.prioritizeLivePlayback;
    delete mergedSettings.edgeBufferSeconds;
    delete mergedSettings.liveLatencyMode;
    settingsSnapshot = Object.assign({}, mergedSettings);
    const session = createSession(room.room_id);
    session.title = document.title;

    if (pageExited) return;
    registeredSessionId = session.id;
    const registration = await chrome.runtime.sendMessage({
      source: 'bililivebar',
      type: 'register-session',
      session,
      autoClearOnExit: mergedSettings.autoClearOnExit !== false
    });
    if (pageExited) return;
    if (!registration?.ok) throw new Error(registration?.error || '缓存会话注册失败');
    Object.assign(session, registration.session);
    await storage.bindSession(session.id);
    if (pageExited) return;

    recorder = new BLB.HlsRecorder({
      storage, session, quality: mergedSettings.quality
    });
    danmaku = new BLB.DanmakuClient({ storage, session });
    replay = new BLB.ReplayPlayer({ storage, session, settings: mergedSettings });
    renderer = new BLB.DanmakuRenderer({ storage, session, replay, settings: mergedSettings });
    ui = new BLB.BiliLiveBarUi({
      replay,
      recorder,
      renderer,
      danmaku,
      storage,
      settings: mergedSettings,
      onDanmakuToggle: setNativeDanmakuVisibility,
      onExit: async () => { dispose(); await releaseSession(); }
    });
    replay.addEventListener('managed', () => {
      managedPlaybackActive = true;
      configuredBridgeDocuments = new WeakSet();
      setNativeDanmakuVisibility(mergedSettings.danmakuEnabled !== false, false);
    });
    storage.getStorageStatus().then((state) => ui.setStorageStatus(state)).catch(() => {});
    storage.getStats(session.id).then((stats) => ui.setStats(stats)).catch(() => {});
    setBackgroundQualityProtection(mergedSettings.keepBackgroundQuality !== false);
    setNativeDanmakuVisibility(mergedSettings.danmakuEnabled !== false, false);

    const mount = () => {
      if (pageExited) return;
      const player = findPlayer();
      const topFullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || null;
      if (!player) {
        const retainedWebHost = !topFullscreenElement && isViewportHost(lastWebFullscreenHost)
          ? lastWebFullscreenHost
          : null;
        ui.mount(
          topFullscreenElement
            || document.body
            || document.documentElement,
          {
            fullscreen: Boolean(topFullscreenElement),
            webFullscreen: Boolean(retainedWebHost)
          }
        );
        return;
      }
      const fullscreenElement = videoFullscreenHost(player.video);
      let webFullscreenElement = getWebFullscreenHost(player.root, player.video);
      if (webFullscreenElement) lastWebFullscreenHost = webFullscreenElement;
      else if (!fullscreenElement && isViewportHost(lastWebFullscreenHost)) webFullscreenElement = lastWebFullscreenHost;
      else if (!fullscreenElement) lastWebFullscreenHost = null;
      // 历史层只覆盖播放器，避免遮住活动页菜单和弹幕输入。
      replay.mount(player.root, player.video);
      ui.mount(
        fullscreenElement
          || document.body
          || document.documentElement,
        {
          fullscreen: Boolean(fullscreenElement),
          webFullscreen: Boolean(webFullscreenElement)
        }
      );
    };
    const remountAfterLayout = () => {
      if (pageExited) return;
      for (const timer of mountTimers) clearTimeout(timer);
      mountTimers = [0, 120, 500, 1200].map((delay) => global.setTimeout(mount, delay));
    };
    mount();
    mountTimer = global.setInterval(mount, 1500);
    document.addEventListener('fullscreenchange', remountAfterLayout);
    document.addEventListener('webkitfullscreenchange', remountAfterLayout);

    const updateTimeline = () => replay.refreshSegments().then((value) => {
      replay.maybeStart();
      return value;
    }).catch((error) => ui.setStatus('warning', error.message));
    const timeline = await updateTimeline();
    if (pageExited) return;
    recorder.resume(timeline);
    refreshTimer = global.setInterval(updateTimeline, 2000);
    statsTimer = global.setInterval(async () => {
      try { ui.setStats(await storage.getStats(session.id)); } catch (_) { /* keep recording */ }
    }, 5000);

    recorder.addEventListener('status', (event) => {
      lastRecorderStatus = {
        state: event.detail.state,
        text: event.detail.text
      };
      danmakuWarningVisible = false;
      if (event.detail.state === 'error' || (!replay.loading && !replay.pendingSeekWallMs && !replay.failedWallMs && !replay.recoveryPending && !replay.engineBuffering && !replay.bufferingSince && !replay.pauseExpired && !recorder.cacheLimitBlocked)) {
        const preparing = !replay.active && event.detail.state === 'recording';
        ui.setStatus(preparing ? 'starting' : event.detail.state,
          preparing ? '正在准备统一播放缓冲…' : event.detail.text);
      }
      reportState(event.detail.state === 'recording', event.detail.state === 'error');
    });
    recorder.addEventListener('segment', (event) => {
      replay.notifyCacheCommit(event.detail);
      replay.observeBufferSample(event.detail);
      updateTimeline();
      if (Number(event.detail.gapMs) > 250) {
        replay.recordEvent('cache-gap', { durationMs: event.detail.gapMs, startMs: event.detail.startMs - session.startedAt });
      }
    });
    recorder.addEventListener('qualitychange', (event) => replay.requestQualitySwitch(event.detail));
    recorder.addEventListener('gap', (event) => {
      replay.recordEvent('download-gap', { sequence: event.detail.sequence, durationMs: event.detail.durationMs });
    });
    onlineHandler = () => {
      recorder.reconnect();
      replay.recordEvent('network-online');
    };
    global.addEventListener('online', onlineHandler);
    danmaku.addEventListener('status', (event) => {
      ui.root.dataset.danmakuSource = event.detail.source || ui.root.dataset.danmakuSource || 'waiting';
      if (event.detail.state === 'warning') {
        danmakuWarningVisible = true;
        ui.setStatus('warning', event.detail.text);
      } else if (event.detail.state === 'connected' && danmakuWarningVisible) {
        // 鉴权恢复后清除旧警告，并恢复录制状态。
        danmakuWarningVisible = false;
        ui.setStatus(lastRecorderStatus.state, lastRecorderStatus.text);
      }
    });
    danmaku.addEventListener('danmaku', (event) => renderer.ingest(event.detail));
    danmaku.addEventListener('capture', (event) => {
      ui.root.dataset.danmakuSource = event.detail.source || 'unknown';
      ui.root.dataset.danmakuCaptured = String(Number(event.detail.count || 0));
      ui.root.dataset.danmakuQueued = String(Number(event.detail.queued || 0));
    });

    settingsChangedHandler = (changes, area) => {
      if (area !== 'local' || !changes.settings?.newValue) return;
      const previous = settingsSnapshot || {};
      if (pageExited) return;
      if (!global.chrome?.runtime?.id) { dispose(); return; }
      ui.acceptStoredSettings(BLB.normalizeQualitySettings(BLB.normalizeDanmakuScaleSettings(changes.settings.newValue)));
      settingsSnapshot = Object.assign({}, mergedSettings);
      const danmakuKeys = [
        'danmakuEnabled', 'danmakuOpacity', 'danmakuFontFamily', 'danmakuFontScale', 'danmakuEmoteScale', 'danmakuFontWeight', 'danmakuSpeed',
        'danmakuArea', 'danmakuFontBorder', 'danmakuScreenSync', 'danmakuSpeedSync',
        'danmakuPreventShade', 'danmakuAvoidOverlap', 'danmakuBlockScroll', 'danmakuBlockTop',
        'danmakuBlockBottom', 'danmakuBlockColor', 'danmakuBlockEmoji', 'danmakuBlockLottery'
      ];
      if (danmakuKeys.some((key) => previous[key] !== mergedSettings[key])) renderer.applySettings?.(mergedSettings);
      if (previous.danmakuEnabled !== mergedSettings.danmakuEnabled) {
        ui.syncDanmakuButton?.();
        if (ui.danmakuEnabledToggle) ui.danmakuEnabledToggle.checked = mergedSettings.danmakuEnabled !== false;
        // 跨页设置仅同步 CSS 状态，避免重复触发原生按钮。
        setNativeDanmakuVisibility(mergedSettings.danmakuEnabled !== false, false);
      }
      if (previous.liveBufferSeconds !== mergedSettings.liveBufferSeconds) {
        replay.setLiveBuffer(mergedSettings.liveBufferSeconds);
      }
      if (previous.adaptiveBuffer !== mergedSettings.adaptiveBuffer) replay.setAdaptiveBuffer(mergedSettings.adaptiveBuffer !== false);
      if (previous.stallRecovery !== mergedSettings.stallRecovery) replay.setStallRecovery(mergedSettings.stallRecovery);
      if (previous.liveBufferSeconds !== mergedSettings.liveBufferSeconds || previous.adaptiveBuffer !== mergedSettings.adaptiveBuffer
        || previous.stallRecovery !== mergedSettings.stallRecovery) {
        ui.syncBufferSettings();
      }
      if (['rewindSeconds', 'forwardSeconds', 'seekDirection'].some((key) => previous[key] !== mergedSettings[key])) {
        mergedSettings.rewindSeconds = BLB.normalizeSeekSeconds(mergedSettings.rewindSeconds);
        mergedSettings.forwardSeconds = BLB.normalizeSeekSeconds(mergedSettings.forwardSeconds, 10);
        ui.updateRewindButton();
      }
      if (previous.quality !== mergedSettings.quality) recorder.setQuality(mergedSettings.quality).catch(() => {});
      if (previous.maxCacheSizeGB !== mergedSettings.maxCacheSizeGB && recorder.cacheLimitBlocked
        && (Number(mergedSettings.maxCacheSizeGB) === 0 || Number(mergedSettings.maxCacheSizeGB) > Number(previous.maxCacheSizeGB))) {
        recorder.cacheLimitBlocked = false;
        recorder.mediaUrl = '';
        recorder.pendingBoundary = true;
        recorder.boundaryReason = 'cache-limit-resume';
        recorder.start().catch((error) => ui.setStatus('error', error.message));
      }
      if (previous.keepBackgroundQuality !== mergedSettings.keepBackgroundQuality) {
        setBackgroundQualityProtection(mergedSettings.keepBackgroundQuality !== false);
      }
      storage.getStorageStatus().then((state) => ui.setStorageStatus(state)).catch(() => {});
      chrome.runtime.sendMessage({
        source: 'bililivebar',
        type: 'session-settings',
        sessionId: session.id,
        autoClearOnExit: mergedSettings.autoClearOnExit !== false
      }).catch(() => {});
    };
    settingsEvents?.addListener(settingsChangedHandler);

    global.addEventListener('keydown', (event) => {
      if (pageExited) return;
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        ui.safeSeek(event.shiftKey ? -60 : -Number(mergedSettings.rewindSeconds || 30));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        replay.goLive().catch((error) => ui.setStatus('warning', error.message));
      }
    });

    danmaku.start();
    recorder.start();
    reportState(true);
  } catch (error) {
    if (pageExited) return;
    console.error('[BiliLiveBar] 启动失败', error);
    dispose();
    releaseSession();
    reportState(false, true);
  }
})(globalThis);
