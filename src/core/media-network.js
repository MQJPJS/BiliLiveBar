(function initMediaNetwork(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(globalThis, function mediaNetworkFactory() {
  'use strict';
  const PORT = 'bililivebar-media';
  const CHUNK = 256 * 1024;
  const LIMIT = 64 * 1024 * 1024;

  function isAllowedMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && ['bilibili.com', 'bilivideo.com', 'bilivideo.cn'].some((host) => url.hostname.endsWith(`.${host}`))
        && /\.(?:m3u8|m4s|mp4|ts)$/i.test(url.pathname);
    } catch (_) { return false; }
  }

  function installMediaProxy(runtime, readResponse, fetcher = fetch) {
    const active = new Map();
    runtime.onConnect.addListener((port) => {
      if (port.name !== PORT) return;
      const sender = port.sender;
      const owner = sender?.documentId;
      if (!owner || sender.tab?.id == null || sender.url?.split('#')[0] !== runtime.getURL('storage.html')
        || (active.get(owner) || 0) >= 4) { port.disconnect(); return; }
      active.set(owner, (active.get(owner) || 0) + 1);
      const controller = new AbortController();
      let timer, started = false, closed = false, bytes = null, offset = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        controller.abort();
        bytes = null;
        const count = active.get(owner) - 1;
        if (count) active.set(owner, count); else active.delete(owner);
      };
      const fail = (error) => {
        if (closed) return;
        try { port.postMessage({ type: 'error', error: error.message, errorName: error.name }); }
        catch (_) {}
        finally { close(); }
      };
      const sendNext = () => {
        if (offset === bytes.length) { port.postMessage({ type: 'done' }); close(); return; }
        const end = Math.min(bytes.length, offset + CHUNK), parts = [];
        for (let i = offset; i < end; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, end))));
        const message = { type: 'chunk', offset, data: btoa(parts.join('')) };
        offset = end;
        port.postMessage(message);
      };
      port.onDisconnect.addListener(close);
      // Port 使用 JSON；分块确认避免单条消息过大或接收端积压。
      port.onMessage.addListener((message) => {
        if (closed) return;
        if (message.type === 'ack' && bytes && message.offset === offset) {
          try { sendNext(); } catch (error) { fail(error); }
          return;
        }
        if (started || message.type !== 'start') { fail(new Error('无效媒体请求')); return; }
        started = true;
        timer = setTimeout(() => fail(new DOMException('媒体请求超时', 'AbortError')),
          Math.max(1000, Math.min(30000, Number(message.timeoutMs) || 20000)));
        (async () => {
          if (!isAllowedMediaUrl(message.url)) throw new Error('拒绝代理非 Bilibili 媒体');
          const headers = {}, range = message.byteRange;
          if (range) {
            if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length)
              || range.length <= 0 || range.length > LIMIT || !Number.isSafeInteger(range.offset + range.length)) {
              throw new Error('无效媒体范围');
            }
            headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
          }
          const response = await fetcher(message.url, {
            credentials: 'omit', cache: 'no-store', redirect: 'error', headers, signal: controller.signal
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await readResponse(response, message.responseType === 'buffer' ? LIMIT : 2 * 1024 * 1024);
          if (closed) return;
          bytes = new Uint8Array(buffer);
          port.postMessage({ type: 'ready', length: bytes.length });
        })().catch(fail);
      });
    });
  }

  function fetchMediaProxy(runtime, payload, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('请求已取消', 'AbortError')); return; }
      const port = runtime.connect({ name: PORT });
      let bytes = null, offset = 0, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        try { port.disconnect(); } catch (_) {}
        if (error) reject(error);
        else resolve(bytes.buffer);
      };
      const abort = () => finish(new DOMException('请求已取消', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      port.onDisconnect.addListener(() => finish(new Error(runtime.lastError?.message || '媒体代理连接中断')));
      port.onMessage.addListener((message) => {
        if (settled) return;
        try {
          if (message.type === 'error') {
            const error = new Error(message.error);
            error.name = message.errorName || 'Error';
            throw error;
          }
          if (message.type === 'ready' && !bytes) {
            const limit = payload.responseType === 'buffer' ? LIMIT : 2 * 1024 * 1024;
            if (!Number.isSafeInteger(message.length) || message.length < 0 || message.length > limit) throw new Error('无效媒体大小');
            bytes = new Uint8Array(message.length);
          } else if (message.type === 'chunk' && bytes && message.offset === offset) {
            if (typeof message.data !== 'string' || message.data.length > Math.ceil(CHUNK / 3) * 4) throw new Error('无效媒体分块');
            const part = atob(message.data);
            if (!part.length || part.length > CHUNK || offset + part.length > bytes.length) throw new Error('无效媒体分块');
            for (let i = 0; i < part.length; i++) bytes[offset + i] = part.charCodeAt(i);
            offset += part.length;
          } else if (message.type === 'done' && bytes && offset === bytes.length) { finish(); return; }
          else throw new Error('媒体代理响应不完整');
          port.postMessage({ type: 'ack', offset });
        } catch (error) { finish(error); }
      });
      try { port.postMessage({ type: 'start', ...payload }); } catch (error) { finish(error); }
    });
  }

  return { isAllowedMediaUrl, installMediaProxy, fetchMediaProxy };
});
