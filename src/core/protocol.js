(function initProtocolCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function protocolCoreFactory() {
  'use strict';

  const HEADER_LENGTH = 16;
  const MAX_PACKET_BYTES = 16 * 1024 * 1024;
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function toBytes(body) {
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return textEncoder.encode(typeof body === 'string' ? body : JSON.stringify(body || {}));
  }

  function encodePacket(operation, body, version = 1, sequence = 1) {
    const payload = toBytes(body);
    const packet = new ArrayBuffer(HEADER_LENGTH + payload.byteLength);
    const view = new DataView(packet);
    view.setUint32(0, packet.byteLength);
    view.setUint16(4, HEADER_LENGTH);
    view.setUint16(6, version);
    view.setUint32(8, operation);
    view.setUint32(12, sequence);
    new Uint8Array(packet, HEADER_LENGTH).set(payload);
    return packet;
  }

  async function readInflated(stream) {
    const reader = stream.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PACKET_BYTES) { await reader.cancel(); throw new Error('弹幕解压结果过大'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  async function inflateWithStreams(bytes) {
    let lastError;
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return await readInflated(stream);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('浏览器不支持 zlib 解压');
  }

  async function brotliWithStreams(bytes) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('brotli'));
      return await readInflated(stream);
    } catch (error) {
      throw new Error(`浏览器不支持 Brotli 弹幕解压：${error?.message || error}`);
    }
  }

  async function decodePackets(input, inflate = inflateWithStreams, brotli = brotliWithStreams,
    budget = { bytes: 0, commands: 0 }, depth = 0) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    budget.bytes += bytes.byteLength;
    if (depth > 6 || bytes.byteLength > MAX_PACKET_BYTES || budget.bytes > 64 * 1024 * 1024) throw new Error('弹幕包超过解析上限');
    const commands = [];
    let offset = 0;
    while (offset + HEADER_LENGTH <= bytes.byteLength) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
      const packetLength = view.getUint32(0);
      const headerLength = view.getUint16(4);
      const version = view.getUint16(6);
      const operation = view.getUint32(8);
      if (headerLength < HEADER_LENGTH || packetLength < headerLength) throw new Error('弹幕包头无效');
      if (offset + packetLength > bytes.byteLength) break;
      const body = bytes.subarray(offset + headerLength, offset + packetLength);

      if (operation === 5 && version === 2) {
        for (const command of await decodePackets(await inflate(body), inflate, brotli, budget, depth + 1)) commands.push(command);
      } else if (operation === 5 && version === 3) {
        for (const command of await decodePackets(await brotli(body), inflate, brotli, budget, depth + 1)) commands.push(command);
      } else if (operation === 5) {
        const raw = textDecoder.decode(body).replace(/\0+$/g, '');
        for (const candidate of raw.split(/[\u0000-\u001f]+(?=\{)/)) {
          if (!candidate.trim()) continue;
          if (++budget.commands > 50000) throw new Error('弹幕包消息数量过多');
          try { commands.push(JSON.parse(candidate)); } catch (_) { /* 丢弃非 JSON 互动包 */ }
        }
      }
      offset += packetLength;
    }
    return commands;
  }

  function decodeControlPackets(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const packets = [];
    let offset = 0;
    while (offset + HEADER_LENGTH <= bytes.byteLength) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
      const packetLength = view.getUint32(0);
      const headerLength = view.getUint16(4);
      const version = view.getUint16(6);
      const operation = view.getUint32(8);
      if (headerLength < HEADER_LENGTH || packetLength < headerLength
        || offset + packetLength > bytes.byteLength) break;
      if (operation !== 5) {
        const body = bytes.subarray(offset + headerLength, offset + packetLength);
        let data = null;
        if (operation === 8 && body.byteLength) {
          try { data = JSON.parse(textDecoder.decode(body).replace(/\0+$/g, '')); }
          catch (_) { /* malformed auth reply is handled as a timeout by the client */ }
        }
        packets.push({ operation, version, data });
      }
      offset += packetLength;
    }
    return packets;
  }

  function normalizeEpoch(value, fallback) {
    let number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    if (number < 1e12) number *= 1000;
    return Math.abs(number - fallback) < 10 * 60 * 1000 ? number : fallback;
  }

  function parseObject(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || value[0] !== '{') return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function extractDanmakuExtra(meta) {
    const candidates = [meta[15]?.extra, meta[15], meta[14], meta[13]];
    for (const candidate of candidates) {
      const parsed = parseObject(candidate);
      if (!parsed) continue;
      const nested = parseObject(parsed.extra);
      const value = nested || parsed;
      if (value.content != null || value.id_str || value.emots || value.emoticon_unique) return value;
    }
    return {};
  }

  function extractEmotes(extra, bigImage) {
    const result = [];
    const source = extra?.emots;
    if (source && typeof source === 'object') {
      for (const [token, value] of Object.entries(source)) {
        if (!value?.url) continue;
        result.push({
          token,
          url: String(value.url),
          width: Number(value.width || 0),
          height: Number(value.height || 0),
          count: Math.max(1, Number(value.count || 1))
        });
      }
    }
    const emoticon = extra?.emoticon;
    if (emoticon?.url) {
      result.push({
        token: String(emoticon.text || extra.emoticon_unique || '[表情]'),
        url: String(emoticon.url),
        width: Number(emoticon.width || 0),
        height: Number(emoticon.height || 0),
        count: 1
      });
    }
    if (bigImage?.url
      && (!bigImage.emoticon_unique || !extra?.emoticon_unique || bigImage.emoticon_unique === extra.emoticon_unique)) {
      result.push({
        token: String(extra?.content || bigImage.emoticon_unique || '[表情]'),
        url: String(bigImage.url),
        width: Number(bigImage.width || 0),
        height: Number(bigImage.height || 0),
        count: 1,
        large: true
      });
    }
    return result;
  }

  function extractDanmaku(command, receivedAt = Date.now()) {
    if (!command || !String(command.cmd || '').startsWith('DANMU_MSG')) return null;
    const info = command.info;
    if (!Array.isArray(info) || !Array.isArray(info[0])) return null;
    const meta = info[0];
    const user = Array.isArray(info[2]) ? info[2] : [];
    const extra = extractDanmakuExtra(meta);
    const emotes = extractEmotes(extra, parseObject(meta[13]));
    const timeMs = normalizeEpoch(meta[4], receivedAt);
    const text = String(info[1] || extra.content || extra.emoticon_unique || emotes.map((item) => item.token).join(' ') || '');
    const meaningfulId = (value) => {
      const id = String(value ?? '').trim();
      return id && id !== '0' ? id : '';
    };
    // meta[9] 是抽奖标记，不是消息 ID。
    const protocolId = meaningfulId(extra.id_str)
      || meaningfulId(command.msg_id);
    const fallbackId = [timeMs, meta[5] ?? '', meta[7] ?? '', user[0] ?? '', text].join('|');
    return {
      id: protocolId || fallbackId,
      timeMs,
      receivedAt,
      text,
      mode: Number(meta[1] || 1),
      fontSize: Number(meta[2] || 25),
      color: Number(meta[3] || 0xffffff),
      uid: String(user[0] || ''),
      username: String(user[1] || ''),
      emotes,
      lottery: (typeof meta[9] === 'number' || typeof meta[9] === 'string')
        && Number.isSafeInteger(Number(meta[9])) && Number(meta[9]) > 0
    };
  }

  return { encodePacket, decodePackets, decodeControlPackets, extractDanmaku, normalizeEpoch };
});
