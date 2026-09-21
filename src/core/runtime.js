(function initRuntimeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(globalThis, function runtimeCoreFactory() {
  'use strict';
  // 历史索引可能很大，不套用远端 API 的 2 MiB 限额。
  const MAX_METADATA_BYTES = 64 * 1024 * 1024;

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

  async function resourceDigest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function settingsPatch(previous, current) {
    return Object.fromEntries(Object.entries(current).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(previous[key])));
  }

  function createSettingsUpdater(storage) {
    let pending = Promise.resolve();
    return (patch) => {
      const safePatch = Object.fromEntries(Object.entries(patch || {}).filter(([key]) =>
        !['__proto__', 'constructor', 'prototype'].includes(key)));
      const task = async () => {
        const { settings = {} } = await storage.get('settings');
        const next = normalizeQualitySettings(Object.assign({}, settings, safePatch));
        await storage.set({ settings: next });
        return next;
      };
      const result = pending.then(task, task);
      pending = result.catch(() => {});
      return result;
    };
  }

  // 密钥仅由扩展消息传递；网页可见的 DOM token 只用于路由。
  class SecureChannel {
    constructor(rawKey, context, outgoing) {
      this.key = crypto.subtle.importKey('raw', new Uint8Array(rawKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
      this.context = context;
      this.outgoing = outgoing;
      this.sent = 0;
      this.received = 0;
      this.sendChain = Promise.resolve();
      this.receiveChain = Promise.resolve();
    }

    aad(direction, sequence) {
      return new TextEncoder().encode(JSON.stringify([this.context, direction, sequence]));
    }

    send(message, post) {
      const task = async () => {
        const header = { ...message };
        let binary = new Uint8Array(0);
        for (const slot of ['payload', 'result']) {
          if (message[slot]?.buffer instanceof ArrayBuffer) {
            header[slot] = { ...message[slot], buffer: undefined };
            header.binarySlot = slot;
            binary = new Uint8Array(message[slot].buffer);
            break;
          }
        }
        const json = new TextEncoder().encode(JSON.stringify(header));
        if (json.length > MAX_METADATA_BYTES || binary.length > 64 * 1024 * 1024) throw new Error('存储消息过大');
        const plain = new Uint8Array(4 + json.length + binary.length);
        new DataView(plain.buffer).setUint32(0, json.length);
        plain.set(json, 4);
        plain.set(binary, 4 + json.length);
        const sequence = ++this.sent;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
          additionalData: this.aad(this.outgoing, sequence) }, await this.key, plain);
        post({ sequence, iv, buffer });
      };
      const result = this.sendChain.then(task, task);
      this.sendChain = result.catch(() => {});
      return result;
    }

    receive(packet) {
      const task = async () => {
        if (!Number.isSafeInteger(packet.sequence) || packet.sequence <= this.received
          || !(packet.buffer instanceof ArrayBuffer) || packet.buffer.byteLength > MAX_METADATA_BYTES + 64 * 1024 * 1024 + 20) {
          throw new Error('无效或重复的存储消息');
        }
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packet.iv,
          additionalData: this.aad(this.outgoing === 'request' ? 'response' : 'request', packet.sequence) },
        await this.key, packet.buffer);
        if (plain.byteLength < 4) throw new Error('存储消息不完整');
        const size = new DataView(plain).getUint32(0);
        if (size > MAX_METADATA_BYTES || size > plain.byteLength - 4) throw new Error('存储消息不完整');
        const message = JSON.parse(new TextDecoder().decode(new Uint8Array(plain, 4, size)));
        if (message.binarySlot) {
          if (!['payload', 'result'].includes(message.binarySlot)) throw new Error('无效的存储消息');
          message[message.binarySlot].buffer = plain.slice(4 + size);
          delete message.binarySlot;
        }
        this.received = packet.sequence;
        return message;
      };
      const result = this.receiveChain.then(task, task);
      this.receiveChain = result.catch(() => {});
      return result;
    }
  }

  function normalizeQualitySettings(settings) {
    const next = { ...settings };
    delete next.adaptiveQuality;
    delete next.adaptiveQualityVersion;
    delete next.nativeHighestOnEntry;
    return next;
  }

  return { readBoundedResponse, resourceDigest, settingsPatch, createSettingsUpdater, SecureChannel, normalizeQualitySettings };
});
