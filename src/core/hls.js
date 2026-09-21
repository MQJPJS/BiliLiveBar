(function initHlsCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function hlsCoreFactory() {
  'use strict';

  function parseAttributeList(value) {
    const out = {};
    const matcher = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
    let match;
    while ((match = matcher.exec(value))) {
      const raw = match[2];
      out[match[1].toUpperCase()] = raw.startsWith('"')
        ? raw.slice(1, -1).replace(/\\"/g, '"')
        : raw;
    }
    return out;
  }

  function parseByteRange(value, previousEnd) {
    if (!value) return null;
    const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
    if (!match) return null;
    const length = Number(match[1]);
    const offset = match[2] == null ? (previousEnd || 0) : Number(match[2]);
    return { length, offset };
  }

  function absoluteUrl(uri, baseUrl) {
    return new URL(uri, baseUrl).href;
  }

  function selectVariant(lines, baseUrl) {
    const variants = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseAttributeList(lines[i].slice(18));
      let next = i + 1;
      while (next < lines.length && (!lines[next] || lines[next].startsWith('#'))) next += 1;
      if (next < lines.length) {
        variants.push({
          url: absoluteUrl(lines[next], baseUrl),
          bandwidth: Number(attrs.BANDWIDTH || 0),
          codecs: attrs.CODECS || ''
        });
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return variants[0] || null;
  }

  function fillTimeline(segments, fetchedAt) {
    if (!segments.length) return;
    const firstKnown = segments.findIndex((segment) => Number.isFinite(segment.startMs));
    if (firstKnown === -1) {
      const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
      let cursor = fetchedAt - total;
      for (const segment of segments) {
        segment.startMs = cursor;
        cursor += segment.durationMs;
      }
      return;
    }

    for (let i = firstKnown - 1; i >= 0; i -= 1) {
      segments[i].startMs = segments[i + 1].startMs - segments[i].durationMs;
    }
    for (let i = firstKnown + 1; i < segments.length; i += 1) {
      if (!Number.isFinite(segments[i].startMs)) {
        segments[i].startMs = segments[i - 1].startMs + segments[i - 1].durationMs;
      }
    }
  }

  function parseHlsPlaylist(text, baseUrl, fetchedAt = Date.now()) {
    const lines = String(text).replace(/\r/g, '').split('\n').map((line) => line.trim());
    if (!lines.includes('#EXTM3U')) throw new Error('响应不是有效的 HLS 播放列表');

    const variant = selectVariant(lines, baseUrl);
    if (variant) return { type: 'master', variant };

    let mediaSequence = 0;
    let discontinuitySequence = 0;
    let targetDurationMs = 4000;
    let version = 7;
    let sequence = 0;
    let durationMs = null;
    let title = '';
    let currentMap = null;
    let programDateTime = null;
    let discontinuity = false;
    let gap = false;
    let biliIndependent = false;
    let byteRange = null;
    let previousRangeEnd = 0;
    const independentSegments = lines.includes('#EXT-X-INDEPENDENT-SEGMENTS');
    const segments = [];

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number(line.slice(22)) || 0;
        sequence = mediaSequence;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        discontinuitySequence = Number(line.slice(30)) || 0;
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        version = Number(line.slice(15)) || 7;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDurationMs = (Number(line.slice(22)) || 4) * 1000;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributeList(line.slice(11));
        currentMap = {
          url: absoluteUrl(attrs.URI, baseUrl),
          byteRange: parseByteRange(attrs.BYTERANGE, 0)
        };
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        const parsed = Date.parse(line.slice(25));
        programDateTime = Number.isFinite(parsed) ? parsed : null;
      } else if (line === '#EXT-X-DISCONTINUITY') {
        discontinuity = true;
        discontinuitySequence += 1;
      } else if (line === '#EXT-X-GAP') {
        gap = true;
      } else if (line.startsWith('#EXT-BILI-AUX:')) {
        const fields = line.slice(14).split('|');
        biliIndependent = fields[1] === 'K';
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        byteRange = parseByteRange(line.slice(17), previousRangeEnd);
      } else if (line.startsWith('#EXTINF:')) {
        const parts = line.slice(8).split(',');
        durationMs = Math.max(1, Number(parts.shift()) * 1000);
        title = parts.join(',');
      } else if (!line.startsWith('#') && durationMs != null) {
        const url = absoluteUrl(line, baseUrl);
        segments.push({
          sequence,
          url,
          durationMs,
          title,
          startMs: programDateTime,
          programDateTimeMs: programDateTime,
          init: currentMap,
          byteRange,
          discontinuity,
          discontinuitySequence,
          independent: independentSegments || biliIndependent,
          gap
        });
        if (byteRange) previousRangeEnd = byteRange.offset + byteRange.length;
        if (programDateTime != null) programDateTime += durationMs;
        sequence += 1;
        durationMs = null;
        title = '';
        byteRange = null;
        discontinuity = false;
        gap = false;
        biliIndependent = false;
      }
    }

    fillTimeline(segments, fetchedAt);
    return {
      type: 'media',
      mediaSequence,
      discontinuitySequence,
      targetDurationMs,
      version,
      independentSegments,
      endList: lines.includes('#EXT-X-ENDLIST'),
      segments
    };
  }

  return { parseAttributeList, parseHlsPlaylist, parseByteRange };
});
