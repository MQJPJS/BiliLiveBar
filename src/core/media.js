(function initMediaCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function mediaCoreFactory() {
  'use strict';

  function hex(value) {
    return Number(value || 0).toString(16).padStart(2, '0');
  }

  function bytesOf(input) {
    return input instanceof Uint8Array ? input : new Uint8Array(input);
  }

  function readType(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.byteLength) return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function readUint32(view, offset) {
    return offset >= 0 && offset + 4 <= view.byteLength ? view.getUint32(offset) : null;
  }

  function readUint64(view, offset) {
    const high = readUint32(view, offset);
    const low = readUint32(view, offset + 4);
    if (high == null || low == null) return null;
    const value = high * 0x100000000 + low;
    return Number.isSafeInteger(value) ? value : null;
  }

  function listBoxes(bytes, start = 0, end = bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    let cursor = Math.max(0, start);
    const limit = Math.min(bytes.byteLength, end);
    while (cursor + 8 <= limit) {
      let size = readUint32(view, cursor);
      const type = readType(bytes, cursor + 4);
      let headerSize = 8;
      if (size === 1) {
        size = readUint64(view, cursor + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = limit - cursor;
      }
      if (!Number.isFinite(size) || size < headerSize || cursor + size > limit) break;
      boxes.push({
        type,
        start: cursor,
        end: cursor + size,
        payloadStart: cursor + headerSize
      });
      cursor += size;
    }
    return boxes;
  }

  function child(bytes, parent, type) {
    return listBoxes(bytes, parent.payloadStart, parent.end).find((box) => box.type === type) || null;
  }

  function inspectFmp4Init(input) {
    const bytes = bytesOf(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = listBoxes(bytes).find((box) => box.type === 'moov');
    if (!moov) return null;

    const tracks = {};
    for (const trak of listBoxes(bytes, moov.payloadStart, moov.end).filter((box) => box.type === 'trak')) {
      const tkhd = child(bytes, trak, 'tkhd');
      const mdia = child(bytes, trak, 'mdia');
      const mdhd = mdia && child(bytes, mdia, 'mdhd');
      const hdlr = mdia && child(bytes, mdia, 'hdlr');
      if (!tkhd || !mdhd) continue;

      const tkhdVersion = bytes[tkhd.payloadStart];
      const mdhdVersion = bytes[mdhd.payloadStart];
      const trackId = readUint32(view, tkhd.payloadStart + (tkhdVersion === 1 ? 20 : 12));
      const timescale = readUint32(view, mdhd.payloadStart + (mdhdVersion === 1 ? 20 : 12));
      if (!trackId || !timescale) continue;
      tracks[trackId] = {
        type: hdlr ? readType(bytes, hdlr.payloadStart + 8) : '',
        timescale,
        defaultSampleDuration: 0,
        defaultSampleFlags: null
      };
    }

    const mvex = child(bytes, moov, 'mvex');
    if (mvex) {
      for (const trex of listBoxes(bytes, mvex.payloadStart, mvex.end).filter((box) => box.type === 'trex')) {
        const trackId = readUint32(view, trex.payloadStart + 4);
        const defaultSampleDuration = readUint32(view, trex.payloadStart + 12);
        if (trackId && tracks[trackId]) {
          tracks[trackId].defaultSampleDuration = defaultSampleDuration || 0;
          tracks[trackId].defaultSampleFlags = trex.payloadStart + 24 <= trex.end
            ? readUint32(view, trex.payloadStart + 20) : null;
        }
      }
    }

    return Object.keys(tracks).length ? { tracks } : null;
  }

  function parseTfhd(bytes, view, box) {
    const flagsValue = readUint32(view, box.payloadStart);
    const trackId = readUint32(view, box.payloadStart + 4);
    if (flagsValue == null || !trackId) return null;
    const flags = flagsValue & 0xffffff;
    let cursor = box.payloadStart + 8;
    if (flags & 0x000001) cursor += 8;
    if (flags & 0x000002) cursor += 4;
    let defaultSampleDuration = 0;
    if (flags & 0x000008) {
      defaultSampleDuration = readUint32(view, cursor) || 0;
      cursor += 4;
    }
    if (flags & 0x000010) cursor += 4;
    const defaultSampleFlags = (flags & 0x000020) && cursor + 4 <= box.end ? readUint32(view, cursor) : null;
    return { trackId, defaultSampleDuration, defaultSampleFlags };
  }

  function firstSampleIndependent(view, trun, defaultFlags) {
    if (!trun || !readUint32(view, trun.payloadStart + 4)) return null;
    const flags = readUint32(view, trun.payloadStart) & 0xffffff;
    let cursor = trun.payloadStart + 8;
    if (flags & 0x000001) cursor += 4;
    let sampleFlags = defaultFlags;
    if (flags & 0x000004) sampleFlags = cursor + 4 <= trun.end ? readUint32(view, cursor) : null;
    else if (flags & 0x000400) {
      if (flags & 0x000100) cursor += 4;
      if (flags & 0x000200) cursor += 4;
      sampleFlags = cursor + 4 <= trun.end ? readUint32(view, cursor) : null;
    }
    if (sampleFlags == null) return null;
    const dependsOn = (sampleFlags >>> 24) & 3;
    if ((sampleFlags & 0x10000) || dependsOn === 1) return false;
    return dependsOn === 2 ? true : null;
  }

  function parseTrunDuration(bytes, view, box, defaultSampleDuration) {
    const flagsValue = readUint32(view, box.payloadStart);
    const sampleCount = readUint32(view, box.payloadStart + 4);
    if (flagsValue == null || sampleCount == null) return null;
    const flags = flagsValue & 0xffffff;
    let cursor = box.payloadStart + 8;
    if (flags & 0x000001) cursor += 4;
    if (flags & 0x000004) cursor += 4;
    let total = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      let duration = defaultSampleDuration;
      if (flags & 0x000100) {
        duration = readUint32(view, cursor);
        cursor += 4;
      }
      if (!Number.isFinite(duration)) return null;
      total += duration;
      if (flags & 0x000200) cursor += 4;
      if (flags & 0x000400) cursor += 4;
      if (flags & 0x000800) cursor += 4;
      if (cursor > box.end) return null;
    }
    return total;
  }

  function inspectFmp4Segment(input, initInfo) {
    const bytes = bytesOf(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tracks = initInfo?.tracks || {};
    const timings = [];

    for (const moof of listBoxes(bytes).filter((box) => box.type === 'moof')) {
      for (const traf of listBoxes(bytes, moof.payloadStart, moof.end).filter((box) => box.type === 'traf')) {
        const children = listBoxes(bytes, traf.payloadStart, traf.end);
        const tfhdBox = children.find((box) => box.type === 'tfhd');
        const tfdtBox = children.find((box) => box.type === 'tfdt');
        if (!tfhdBox) continue;
        const tfhd = parseTfhd(bytes, view, tfhdBox);
        if (!tfhd) continue;
        const track = tracks[tfhd.trackId] || {};
        const timescale = Number(track.timescale || 0);
        if (!timescale) continue;
        const defaultDuration = tfhd.defaultSampleDuration || Number(track.defaultSampleDuration || 0);
        let durationUnits = 0;
        for (const trun of children.filter((box) => box.type === 'trun')) {
          const parsed = parseTrunDuration(bytes, view, trun, defaultDuration);
          if (parsed == null) {
            durationUnits = 0;
            break;
          }
          durationUnits += parsed;
        }
        if (!durationUnits) continue;

        let baseDecodeTime = null;
        if (tfdtBox) {
          const version = bytes[tfdtBox.payloadStart];
          baseDecodeTime = version === 1
            ? readUint64(view, tfdtBox.payloadStart + 4)
            : readUint32(view, tfdtBox.payloadStart + 4);
        }
        timings.push({
          trackId: tfhd.trackId,
          type: track.type || '',
          startSeconds: baseDecodeTime == null ? null : baseDecodeTime / timescale,
          durationSeconds: durationUnits / timescale,
          independent: firstSampleIndependent(view, children.find((box) => box.type === 'trun'),
            tfhd.defaultSampleFlags ?? track.defaultSampleFlags ?? null)
        });
      }
    }

    if (!timings.length) return null;
    const aggregate = new Map();
    for (const timing of timings) {
      const current = aggregate.get(timing.trackId) || {
        trackId: timing.trackId,
        type: timing.type,
        startSeconds: timing.startSeconds,
        independent: timing.independent,
        durationSeconds: 0
      };
      current.durationSeconds += timing.durationSeconds;
      if (Number.isFinite(timing.startSeconds)) {
        current.startSeconds = Number.isFinite(current.startSeconds)
          ? Math.min(current.startSeconds, timing.startSeconds)
          : timing.startSeconds;
      }
      aggregate.set(timing.trackId, current);
    }
    const aggregateTimings = Array.from(aggregate.values());
    const preferred = aggregateTimings.filter((timing) => timing.type === 'vide');
    const durationSeconds = Math.max(...(preferred.length ? preferred : aggregateTimings).map((timing) => timing.durationSeconds));
    const knownStarts = (preferred.length ? preferred : aggregateTimings)
      .map((timing) => timing.startSeconds).filter(Number.isFinite);
    return {
      durationMs: Math.round(durationSeconds * 1000000) / 1000,
      startSeconds: knownStarts.length ? Math.min(...knownStarts) : null,
      independent: preferred.length && preferred.every((track) => track.independent === true) ? true
        : preferred.some((track) => track.independent === false) ? false : null,
      tracks: aggregateTimings
    };
  }

  function detectFmp4Mime(input) {
    const bytes = bytesOf(input);
    let videoCodec = '';
    let hasAudio = false;
    for (let i = 0; i + 3 < bytes.length; i += 1) {
      if (i + 7 < bytes.length && bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x63 && bytes[i + 3] === 0x43) {
        videoCodec = `avc1.${hex(bytes[i + 5])}${hex(bytes[i + 6])}${hex(bytes[i + 7])}`;
      }
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x70 && bytes[i + 2] === 0x34 && bytes[i + 3] === 0x61) {
        hasAudio = true;
      }
    }
    if (!videoCodec) videoCodec = 'avc1.640028';
    const codecs = hasAudio ? `${videoCodec}, mp4a.40.2` : videoCodec;
    return `video/mp4; codecs="${codecs}"`;
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  return { detectFmp4Mime, inspectFmp4Init, inspectFmp4Segment, fnv1a };
});
