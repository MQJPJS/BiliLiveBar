(function initStorageClient(global) {
  'use strict';
  const BLB = global.BiliLiveBar;

  class StorageClient {
    constructor() {
      this.frame = null;
      this.frameOrigin = new URL(chrome.runtime.getURL('/')).origin;
      this.token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('');
      this.pending = new Map();
      this.sequence = 0;
      this.readyPromise = null;
      this.onMessage = this.onMessage.bind(this);
      global.addEventListener('message', this.onMessage);
    }

    async ready() {
      if (this.destroyed) throw new Error('存储连接已关闭');
      if (this.readyPromise) return this.readyPromise;
      this.readyPromise = new Promise((resolve, reject) => {
        const mount = () => {
          if (this.destroyed) { reject(new Error('存储连接已关闭')); return; }
          if (!document.documentElement) {
            requestAnimationFrame(mount);
            return;
          }
          const frame = document.createElement('iframe');
          frame.id = 'bililivebar-storage-frame';
          frame.src = `${chrome.runtime.getURL('storage.html')}#${this.token}`;
          frame.setAttribute('aria-hidden', 'true');
          frame.style.cssText = 'display:none!important;width:0!important;height:0!important;border:0!important';
          this.frame = frame;
          document.documentElement.appendChild(frame);
          const timeout = setTimeout(() => reject(new Error('存储服务启动超时')), 10000);
          this.readyResolve = () => {
            clearTimeout(timeout);
            resolve();
          };
          this.readyReject = (error) => {
            clearTimeout(timeout);
            reject(error);
          };
        };
        mount();
      });
      return this.readyPromise;
    }

    async onMessage(event) {
      if (this.destroyed || !this.frame || event.source !== this.frame.contentWindow || event.origin !== this.frameOrigin) return;
      const packet = event.data;
      if (!packet || packet.source !== 'bililivebar-storage' || packet.token !== this.token) return;
      if (packet.type === 'challenge') {
        if (this.authorizing) return;
        this.authorizing = Promise.resolve().then(() => chrome.runtime.sendMessage({ source: 'bililivebar', type: 'authorize-storage', nonce: packet.nonce }))
          .then((auth) => {
            if (!auth?.ok) throw new Error(auth?.error || '存储连接未授权');
            this.channel = new BLB.SecureChannel(auth.key, this.token, 'request');
          });
        this.authorizing.catch((error) => this.readyReject?.(error));
        return;
      }
      if (packet.type === 'ready-error') {
        this.readyReject?.(new Error(packet.error || '存储服务启动失败'));
        return;
      }
      let message;
      try {
        await this.authorizing;
        if (!this.channel) return;
        message = await this.channel.receive(packet);
      } catch (_) { return; }
      if (message.type === 'ready') {
        if (this.readyResolve) this.readyResolve();
        return;
      }
      if (message.type === 'ready-error') {
        if (this.readyReject) this.readyReject(new Error(message.error || '存储服务启动失败'));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      pending.cleanup?.();
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error(message.error || '存储操作失败');
        error.name = message.errorName || 'Error';
        pending.reject(error);
      }
    }

    send(message) {
      if (this.destroyed) return Promise.reject(new Error('存储连接已关闭'));
      return this.channel.send(message, (packet) => this.frame.contentWindow.postMessage({
        source: 'bililivebar-client', token: this.token, ...packet
      }, this.frameOrigin, [packet.buffer]));
    }

    async request(op, payload = {}, transfer = [], signal = null) {
      await this.ready();
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const id = `${Date.now().toString(36)}-${++this.sequence}`;
      return new Promise((resolve, reject) => {
        const cancelFetch = () => {
          if (op !== 'fetchResource') return;
          try {
            this.send({ op: 'cancelFetch', payload: { id } }).catch(() => {});
          } catch (_) { /* The frame may already have been removed. */ }
        };
        const cancel = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timeout);
          cleanup();
          cancelFetch();
          reject(new DOMException('请求已取消', 'AbortError'));
        };
        const cleanup = () => signal?.removeEventListener('abort', cancel);
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          cancelFetch();
          reject(new Error(`存储操作超时：${op}`));
        }, 45000);
        this.pending.set(id, { resolve, reject, timeout, cleanup });
        signal?.addEventListener('abort', cancel, { once: true });
        this.send({ id, op, payload }).catch((error) => {
          this.pending.delete(id);
          clearTimeout(timeout);
          cleanup();
          reject(error);
        });
      });
    }

    listSegments(sessionId, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER) {
      return this.request('listSegments', { sessionId, fromMs, toMs });
    }
    getTimeline(sessionId) { return this.request('getTimeline', { sessionId }); }
    getSegment(id) { return this.request('getSegment', { id }); }
    getStats(sessionId) { return this.request('getStats', { sessionId }); }
    getStorageStatus() { return this.request('getStorageStatus'); }
    bindSession(sessionId) { return this.request('bindSession', { sessionId }); }
    getDanmakuRange(sessionId, fromMs, toMs) {
      return this.request('getDanmakuRange', { sessionId, fromMs, toMs });
    }

    putSegment(meta, buffer) {
      const transferable = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
      return this.request('putSegment', { meta, buffer: transferable }, [transferable]);
    }

    putDanmakuBatch(sessionId, items) {
      if (!items.length) return Promise.resolve({ count: 0 });
      return this.request('putDanmakuBatch', { sessionId, items });
    }

    fetchResource(url, responseType = 'text', byteRange = null, timeoutMs = 30000, signal = null) {
      return this.request('fetchResource', { url, responseType, byteRange, timeoutMs }, [], signal);
    }

    destroy() {
      this.destroyed = true;
      this.readyReject?.(new Error('存储连接已关闭'));
      global.removeEventListener('message', this.onMessage);
      if (this.frame) this.frame.remove();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.cleanup?.();
        pending.reject(new Error('存储连接已关闭'));
      }
      this.pending.clear();
    }
  }

  BLB.StorageClient = StorageClient;
})(globalThis);
