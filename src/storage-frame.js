(function initStorageFrame() {
  'use strict';
  const backend = globalThis.BiliLiveBarStorageBackend;
  const token = location.hash.slice(1);
  const parentOrigin = 'https://live.bilibili.com';
  const activeFetches = new Map();
  const proxyOrigins = new Set();
  let channel = null;
  let ownerDocumentId = '';
  let sessionId = '';

  async function readBoundedResponse(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('响应超过单次下载上限');
    }
    const reader = response.body?.getReader();
    if (!reader) return new ArrayBuffer(0);
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('响应超过单次下载上限');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  }

  function isAllowedNetworkUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return ['bilibili.com', 'bilivideo.com', 'bilivideo.cn'].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
    );
  }

  async function fetchResource({ url, responseType, byteRange, timeoutMs = 30000 }, requestId) {
    if (!isAllowedNetworkUrl(url)) throw new Error('拒绝访问非 Bilibili 资源');
    const parsed = new URL(url);
    if (responseType !== 'buffer' && ['api.live.bilibili.com', 'api.bilibili.com'].includes(parsed.hostname)) {
      activeFetches.set(requestId, { abort: () => chrome.runtime.sendMessage({
        source: 'bililivebar', type: 'cancel-api', requestId
      }).catch(() => {}) });
      try {
        const result = await chrome.runtime.sendMessage({
          source: 'bililivebar', type: 'fetch-api', requestId, url: parsed.href, timeoutMs
        });
        if (!result?.ok) {
          const error = new Error(result?.error || 'Bilibili API 代理请求失败');
          error.name = result?.errorName || 'Error';
          throw error;
        }
        return { text: result.text };
      } finally { activeFetches.delete(requestId); }
    }
    const controller = new AbortController();
    activeFetches.set(requestId, controller);
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(60000, Number(timeoutMs) || 30000)));
    const headers = {};
    if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
    try {
      const viaProxy = () => globalThis.BiliLiveBar.fetchMediaProxy(chrome.runtime,
        { url, responseType, byteRange, timeoutMs: Math.max(1000, timeoutMs - (Date.now() - startedAt)) }, controller.signal);
      let buffer;
      if (proxyOrigins.has(parsed.origin)) buffer = await viaProxy();
      else {
        try {
          const response = await fetch(url, {
            cache: 'no-store', credentials: 'omit', headers, signal: controller.signal
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          buffer = await readBoundedResponse(response, responseType === 'buffer' ? 64 * 1024 * 1024 : 2 * 1024 * 1024);
        } catch (error) {
          if (error.name !== 'TypeError' || controller.signal.aborted || !globalThis.BiliLiveBar.isAllowedMediaUrl(url)) throw error;
          buffer = await viaProxy();
          if (proxyOrigins.size >= 16) proxyOrigins.delete(proxyOrigins.values().next().value);
          proxyOrigins.add(parsed.origin);
        }
      }
      if (responseType === 'buffer') return { buffer };
      return { text: new TextDecoder().decode(buffer) };
    } finally {
      clearTimeout(timeout);
      activeFetches.delete(requestId);
    }
  }

  const handlers = {
    putSegment: (payload) => backend.putSegment(payload),
    listSegments: (payload) => backend.listSegments(payload),
    getTimeline: (payload) => backend.getTimeline(payload),
    getSegment: (payload) => backend.getSegment(payload),
    putDanmakuBatch: (payload) => backend.putDanmakuBatch(payload),
    getDanmakuRange: (payload) => backend.getDanmakuRange(payload),
    getStats: (payload) => backend.getStats(payload),
    getStorageStatus: () => backend.getStorageStatus(),
    bindSession: async (payload) => {
      if (sessionId && sessionId !== payload.sessionId) throw new Error('存储会话不可替换');
      const result = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'bind-storage-session',
        sessionId: payload.sessionId, ownerDocumentId });
      if (!result?.ok) throw new Error(result?.error || '缓存会话授权失败');
      sessionId = payload.sessionId;
      return { ok: true };
    },
    fetchResource
  };

  function send(message) {
    return channel.send(message, (packet) => parent.postMessage({
      source: 'bililivebar-storage', token, ...packet
    }, parentOrigin, [packet.buffer]));
  }

  addEventListener('message', async (event) => {
    if (event.source !== parent || event.origin !== parentOrigin) return;
    const packet = event.data;
    if (!channel || !packet || packet.source !== 'bililivebar-client' || packet.token !== token) return;
    let message;
    try { message = await channel.receive(packet); } catch (_) { return; }
    if (message.op === 'cancelFetch') { activeFetches.get(message.payload?.id)?.abort(); return; }
    const response = { source: 'bililivebar-storage', token, id: message.id };
    try {
      const handler = Object.hasOwn(handlers, message.op) && handlers[message.op];
      if (!handler) throw new Error(`未知存储操作：${message.op}`);
      if (!['fetchResource', 'getStorageStatus', 'bindSession'].includes(message.op)) {
        const target = message.payload?.sessionId || message.payload?.meta?.sessionId;
        const matches = message.op === 'getSegment'
          ? String(message.payload?.id || '').startsWith(`${sessionId}-`) : target === sessionId;
        if (!sessionId || !matches) throw new Error('禁止访问其他页面的缓存');
      }
      response.result = await handler(message.payload || {}, message.id);
      if (message.op === 'getSegment' && response.result?.meta?.sessionId !== sessionId) throw new Error('禁止访问其他页面的缓存');
      response.ok = true;
      await send(response);
    } catch (error) {
      response.ok = false;
      response.error = error?.message || String(error);
      response.errorName = error?.name || 'Error';
      delete response.result;
      await send(response).catch(() => {});
    }
  });

  (async () => {
    const hello = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'storage-hello' });
    if (!hello?.ok) throw new Error('存储连接未授权');
    parent.postMessage({ source: 'bililivebar-storage', token, type: 'challenge', nonce: hello.nonce }, parentOrigin);
    const auth = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'storage-key', nonce: hello.nonce });
    if (!auth?.ok) throw new Error(auth?.error || '存储连接未授权');
    channel = new globalThis.BiliLiveBar.SecureChannel(auth.key, token, 'response');
    ownerDocumentId = auth.ownerDocumentId;
    await backend.openDb();
    await send({ type: 'ready' });
  })().catch((error) => {
    // Startup errors do not grant access or contain credentials.
    parent.postMessage({ source: 'bililivebar-storage', token, type: 'ready-error', error: error.message }, parentOrigin);
  });
})();
