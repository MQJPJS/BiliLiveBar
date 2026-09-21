(function installBiliLiveBarWebSocketBridge() {
  'use strict';
  if (window.__bililivebarWebSocketBridge || !window.WebSocket) return;
  window.__bililivebarWebSocketBridge = true;

  const NativeWebSocket = window.WebSocket;
  const decoder = new TextDecoder();
  let lastAuth = null;
  let lastDanmakuSocket = null;
  let lastDanmakuPacketAt = 0;
  let lastDanmakuUrl = '';
  let keepBackgroundQuality = false;
  let protectedVideos = new WeakSet();
  const danmakuSockets = new WeakSet();
  const packetQueues = new WeakMap();
  const ownHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  const ownVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const ownHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
  const hiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get;
  const visibilityGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get;
  const nativeHasFocus = document.hasFocus.bind(document);

  function reallyHidden() {
    try { return Boolean(hiddenGetter?.call(document)); }
    catch (_) { return visibilityGetter?.call(document) === 'hidden'; }
  }

  function protectPlayingVideos() {
    if (document.documentElement?.hasAttribute('data-bililivebar-managed')) return;
    for (const video of document.querySelectorAll('video:not(.bililivebar-replay-video)')) {
      if (!video.paused && !video.ended) protectedVideos.add(video);
    }
    queueMicrotask(() => {
      if (!keepBackgroundQuality || !reallyHidden()) return;
      for (const video of document.querySelectorAll('video:not(.bililivebar-replay-video)')) {
        if (video.dataset.bililivebarParked === 'true') continue;
        if (protectedVideos.has(video) && video.paused && !video.ended) video.play().catch(() => {});
      }
    });
  }

  function restoreOwnProperty(key, descriptor) {
    try {
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else delete document[key];
    } catch (_) { /* another page script may have locked the property */ }
  }

  function applyBackgroundProtection(enabled) {
    keepBackgroundQuality = Boolean(enabled);
    if (!keepBackgroundQuality) {
      restoreOwnProperty('hidden', ownHidden);
      restoreOwnProperty('visibilityState', ownVisibilityState);
      restoreOwnProperty('hasFocus', ownHasFocus);
      return;
    }
    try {
      Object.defineProperties(document, {
        hidden: { configurable: true, get: () => false },
        visibilityState: { configurable: true, get: () => 'visible' },
        hasFocus: { configurable: true, value: () => reallyHidden() ? true : nativeHasFocus() }
      });
    } catch (_) { /* fallback below still prevents the common visibility handler */ }
    if (reallyHidden()) protectPlayingVideos();
  }

  document.addEventListener('visibilitychange', (event) => {
    if (!keepBackgroundQuality) return;
    if (!reallyHidden()) {
      protectedVideos = new WeakSet();
      return;
    }
    protectPlayingVideos();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener('pause', (event) => {
    const video = event.target;
    if (document.documentElement?.hasAttribute('data-bililivebar-managed') || video?.dataset?.bililivebarParked === 'true') return;
    if (!keepBackgroundQuality || !reallyHidden() || !(video instanceof HTMLVideoElement)) return;
    if (!protectedVideos.has(video) || video.classList.contains('bililivebar-replay-video')) return;
    setTimeout(() => {
      if (video.dataset.bililivebarParked === 'true') return;
      if (keepBackgroundQuality && reallyHidden() && video.paused && !video.ended) video.play().catch(() => {});
    }, 0);
  }, true);

  // 子 frame 等待顶层同步设置，避免初始化时误改播放器状态。
  applyBackgroundProtection(window === window.top);

  function publish(type, payload, transfer = []) {
    let target = window;
    try {
      if (window.top?.location?.origin === location.origin) target = window.top;
    } catch (_) { /* cross-origin frame: only the local content script can receive it */ }
    target.postMessage({ source: 'bililivebar-main', type, payload }, location.origin, transfer);
  }

  function publishAuth(payload) {
    lastAuth = payload;
    publish('danmaku-auth', payload);
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const item = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }

  async function publishGlobalAuth(roomId) {
    const raw = await Promise.resolve(window.__danmuInfo);
    const data = raw?.data || raw;
    const hosts = Array.isArray(data?.host_list)
      ? data.host_list.filter((item) => item?.host)
      : [];
    const urls = hosts.map((item) => `wss://${item.host}${item.wss_port ? `:${item.wss_port}` : ''}/sub`);
    const key = data?.token || data?.key;
    if (!roomId || !urls.length || !key) return false;
    publishAuth({
      url: urls[0],
      urls,
      auth: {
        uid: Number(readCookie('DedeUserID') || 0),
        roomid: Number(roomId),
        protover: 2,
        buvid: readCookie('buvid3'),
        platform: 'web',
        type: 2,
        key
      },
      source: 'page-config'
    });
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const message = event.data;
    // 顶层暂存 iframe 鉴权包，避免隔离世界晚初始化时漏包。
    if (message?.source === 'bililivebar-main') {
      if (message.type === 'danmaku-auth' && event.source !== window) lastAuth = message.payload;
      if (message.type === 'danmaku-packet') {
        lastDanmakuPacketAt = Date.now();
        lastDanmakuUrl = message.payload?.url || lastDanmakuUrl;
        if (event.source !== window) lastDanmakuSocket = null;
      }
      return;
    }
    if (message?.source !== 'bililivebar-content') return;
    if (message.type === 'background-quality') {
      applyBackgroundProtection(message.enabled);
    } else if (message.type === 'need-auth') {
      const roomId = message.roomId;
      if (lastAuth && (!roomId || String(lastAuth.auth?.roomid) === String(roomId))) publishAuth(lastAuth);
      else publishGlobalAuth(roomId).catch(() => {});
      const pageSocketFresh = lastDanmakuPacketAt && Date.now() - lastDanmakuPacketAt <= 75000;
      if (pageSocketFresh
        && (!lastDanmakuSocket || lastDanmakuSocket.readyState === NativeWebSocket.OPEN)) {
        publish('danmaku-page-state', {
          url: lastDanmakuSocket?.url || lastDanmakuUrl,
          readyState: NativeWebSocket.OPEN,
          lastPacketAt: lastDanmakuPacketAt
        });
      }
    } else if (message.type === 'danmaku-visible') {
      setNativeDanmakuVisible(message.enabled, message.synchronizeControl !== false);
    }
  });

  const NATIVE_DANMAKU_STYLE_ID = 'bililivebar-native-danmaku-style';
  const NATIVE_DANMAKU_HIDDEN_CLASS = 'bililivebar-native-danmaku-hidden';

  function ensureNativeDanmakuStyle() {
    if (document.getElementById(NATIVE_DANMAKU_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = NATIVE_DANMAKU_STYLE_ID;
    style.textContent = `
      html.${NATIVE_DANMAKU_HIDDEN_CLASS} .web-player-danmaku,
      html.${NATIVE_DANMAKU_HIDDEN_CLASS} .bilibili-live-player-video-danmaku,
      html.${NATIVE_DANMAKU_HIDDEN_CLASS} .bili-danmaku-x-container,
      html.${NATIVE_DANMAKU_HIDDEN_CLASS} [data-e2e="danmaku-container"],
      html.${NATIVE_DANMAKU_HIDDEN_CLASS} canvas.danmaku-screen,
      html.${NATIVE_DANMAKU_HIDDEN_CLASS} [class~="danmaku-screen"] {
        visibility: hidden !important;
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function nativeDanmakuButtonState(button) {
    if (button instanceof HTMLInputElement && button.type === 'checkbox') return button.checked;
    const checked = button.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') return checked === 'true';
    const pressed = button.getAttribute('aria-pressed');
    if (pressed === 'true' || pressed === 'false') return pressed === 'true';
    const text = [button.title, button.getAttribute('aria-label'), button.dataset?.title, button.textContent]
      .filter(Boolean).join(' ');
    if (/(?:关闭|隐藏|屏蔽)弹幕/.test(text)) return true;
    if (/(?:开启|打开|显示)弹幕/.test(text)) return false;
    const state = `${button.className || ''} ${button.dataset?.state || ''}`;
    if (/(?:^|[-_\s])(?:off|closed|disabled)(?:$|[-_\s])/.test(state)) return false;
    if (/(?:^|[-_\s])(?:on|active|checked)(?:$|[-_\s])/.test(state)) return true;
    return null;
  }

  function synchronizeNativeDanmakuControl(enabled) {
    const selectors = [
      '[data-e2e="danmaku-switch"]', '.web-player-danmaku-switch',
      '.bilibili-live-player-video-controller-danmaku-btn',
      '[class*="danmaku-switch"]', '[class*="danmu-switch"]'
    ].join(',');
    for (const button of document.querySelectorAll(selectors)) {
      if (!(button instanceof HTMLElement) || button.closest('.bililivebar-controls')) continue;
      const state = nativeDanmakuButtonState(button);
      if (state == null || state === Boolean(enabled)) continue;
      button.click();
      break;
    }
  }

  function setNativeDanmakuVisible(enabled, synchronizeControl) {
    ensureNativeDanmakuStyle();
    document.documentElement.classList.toggle(NATIVE_DANMAKU_HIDDEN_CLASS, !enabled);
    if (synchronizeControl) synchronizeNativeDanmakuControl(Boolean(enabled));
  }

  function isDanmakuSocketUrl(url) {
    const value = String(url || '');
    return /^wss?:\/\//i.test(value)
      && (/\/sub(?:[?#]|$)/i.test(value) || /broadcast(?:lv)?\.chat\.bilibili\.com/i.test(value));
  }

  function clonePacket(value) {
    if (value instanceof Blob) return value.arrayBuffer();
    if (value instanceof ArrayBuffer) return Promise.resolve(value.slice(0));
    if (ArrayBuffer.isView(value)) {
      return Promise.resolve(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    return Promise.resolve(null);
  }

  function forwardDanmakuPacket(socket, value) {
    if (!danmakuSockets.has(socket) && !isDanmakuSocketUrl(socket.url)) return;
    lastDanmakuSocket = socket;
    lastDanmakuUrl = socket.url;
    lastDanmakuPacketAt = Date.now();
    const previous = packetQueues.get(socket) || Promise.resolve();
    const task = previous.then(async () => {
      const buffer = await clonePacket(value);
      if (!buffer) return;
      // 只转发副本，transfer 原 ArrayBuffer 会破坏 B 站自身解码。
      publish('danmaku-packet', { buffer, url: socket.url }, [buffer]);
    }).catch(() => {});
    packetQueues.set(socket, task);
  }

  function inspectAuth(socket, value) {
    Promise.resolve(value instanceof Blob ? value.arrayBuffer() : value).then((data) => {
      let bytes;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else return;
      if (bytes.byteLength < 16) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const packetLength = view.getUint32(0);
      const headerLength = view.getUint16(4);
      const operation = view.getUint32(8);
      if (operation !== 7 || packetLength > bytes.byteLength || headerLength < 16) return;
      try {
        const auth = JSON.parse(decoder.decode(bytes.subarray(headerLength, packetLength)));
        if (!auth?.roomid || !auth?.key) return;
        danmakuSockets.add(socket);
        lastDanmakuSocket = socket;
        publishAuth({ url: socket.url, auth });
      } catch (_) { /* 不是直播弹幕鉴权包 */ }
    }).catch(() => {});
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args, NewTarget) {
      const socket = Reflect.construct(Target, args, NewTarget === window.WebSocket ? Target : NewTarget);
      if (isDanmakuSocketUrl(socket.url)) {
        danmakuSockets.add(socket);
        lastDanmakuSocket = socket;
      }
      socket.addEventListener('message', (event) => forwardDanmakuPacket(socket, event.data));
      const nativeSend = socket.send;
      socket.send = function bililivebarSend(data) {
        inspectAuth(socket, data);
        return nativeSend.call(socket, data);
      };
      return socket;
    }
  });
})();
