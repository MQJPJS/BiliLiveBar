(function initHlsRecorder(global) {
  'use strict';
  const BLB = global.BiliLiveBar;

  class HlsRecorder extends EventTarget {
    constructor({ storage, session, quality = 'auto' }) {
      super();
      this.storage = storage;
      this.session = session;
      this.quality = quality === 'auto' ? 'auto' : Number(quality);
      this.qualityOptions = [];
      this.running = false;
      this.stream = null;
      this.masterUrl = '';
      this.mediaUrl = '';
      this.lineIndex = 0;
      this.seen = new Set();
      this.initCache = new Map();
      this.timeline = new Map();
      this.errorCount = 0;
      this.lastSegmentAt = 0;
      this.lastStoredEdgeMs = Number(session.liveEdgeMs || 0);
      this.stagnantPolls = 0;
      this.groupCounter = Number(session.groupCounter || 0);
      this.currentGroupId = session.lastGroupId || '';
      this.currentInitKey = '';
      this.currentMime = '';
      this.lastDiscontinuitySequence = null;
      this.pendingBoundary = !this.currentGroupId;
      this.boundaryReason = 'start';
      this.downloadRate = 0;
      this.lastThroughputAt = 0;
      this.sourceGeneration = 0;
      this.stopVersion = 0;
      this.sourceClock = null;
      this.lastMediaEndSeconds = null;
      this.selectedQn = 0;
      this.selectedLabel = '';
      this.wakePoll = null;
      this.fetchRetries = 0;
      this.lastDownloadMs = 0;
      this.lastCommitMs = 0;
      this.lastSegmentDurationMs = 0;
      this.cacheLimitBlocked = false;
      this.storageFault = null;
      this.networkController = new AbortController();
      this.lastCommittedAt = 0;
      this.lastCommitIntervalMs = 0;
      this.playlistTargetMs = 0;
      this.skippedSegments = 0;
      this.lastBatchSkipped = 0;
    }

    checkSource(generation) {
      if (!this.running || generation !== this.sourceGeneration) {
        const error = new Error('直播源已切换');
        error.name = 'AbortError';
        throw error;
      }
    }

    waitForPoll(milliseconds) {
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          if (this.wakePoll === finish) this.wakePoll = null;
          resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        this.wakePoll = finish;
      });
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    resume(timeline) {
      const state = timeline?.session || timeline || {};
      this.lastStoredEdgeMs = Number(timeline?.segmentCount || state.segmentCount || 0)
        ? Number(timeline?.liveEdgeMs || state.liveEdgeMs || this.lastStoredEdgeMs || 0) : 0;
      this.groupCounter = Number(state.groupCounter || this.groupCounter || 0);
      this.currentGroupId = state.lastGroupId || this.currentGroupId;
      this.pendingBoundary = Boolean(this.lastStoredEdgeMs);
      this.boundaryReason = 'resume';
      const clock = state.lastMediaClock;
      if (clock && Number.isFinite(clock.wallMs) && Number.isFinite(clock.mediaSeconds)) {
        this.sourceClock = { wallMs: clock.wallMs, mediaSeconds: clock.mediaSeconds };
        this.lastMediaEndSeconds = clock.endSeconds;
        this.lastDiscontinuitySequence = clock.discontinuitySequence;
      }
    }

    async fetch(url, type = 'text', byteRange = null, timeoutMs = 20000, signal = this.networkController.signal) {
      try {
        const result = await this.storage.fetchResource(url, type === 'buffer' ? 'buffer' : 'text', byteRange, timeoutMs, signal);
        return type === 'buffer' ? result.buffer : result.text;
      } catch (error) {
        if (error.name === 'AbortError' && !signal.aborted) throw new Error('请求超时或连接中断');
        throw error;
      }
    }

    async fetchWithRetry(url, byteRange, generation = this.sourceGeneration, durationMs = 2000, signal = this.networkController.signal) {
      let lastError;
      // 有限重试后刷新签名，避免旧 CDN 请求长期阻塞录制。
      const timeoutMs = Math.max(4000, Math.min(12000, Number(durationMs || 2000) * 2 + 1000));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.checkSource(generation);
        if (signal.aborted) throw new DOMException('分片请求已取消', 'AbortError');
        try {
          const buffer = await this.fetch(url, 'buffer', byteRange, timeoutMs, signal);
          this.checkSource(generation);
          if (signal.aborted) throw new DOMException('分片请求已取消', 'AbortError');
          if (!buffer?.byteLength) throw new Error('服务器返回空分片');
          return buffer;
        }
        catch (error) {
          this.checkSource(generation);
          if (signal.aborted || error.name === 'AbortError') throw error;
          lastError = error;
          if (/HTTP (401|403|404|410)\b/.test(error.message)) break;
          if (attempt === 0) {
            this.fetchRetries += 1;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      }
      throw lastError || new Error('分片下载失败');
    }

    collectStreams(playurl) {
      const candidates = [];
      for (const stream of playurl?.stream || []) {
        if (stream.protocol_name !== 'http_hls') continue;
        for (const format of stream.format || []) {
          if (format.format_name !== 'fmp4') continue;
          for (const codec of format.codec || []) {
            if (codec.codec_name !== 'avc') continue;
            for (const info of codec.url_info || []) {
              candidates.push({
                url: `${info.host || ''}${codec.base_url || ''}${info.extra || ''}`,
                qn: Number(codec.current_qn || 0),
                acceptQn: codec.accept_qn || [],
                codec: codec.codec_name,
                protocol: stream.protocol_name,
                format: format.format_name
              });
            }
          }
        }
      }
      return candidates;
    }

    collectQualityOptions(playurl) {
      const supported = new Set();
      for (const stream of playurl?.stream || []) {
        if (stream.protocol_name !== 'http_hls') continue;
        for (const format of stream.format || []) {
          if (format.format_name !== 'fmp4') continue;
          for (const codec of format.codec || []) {
            if (codec.codec_name !== 'avc') continue;
            supported.add(Number(codec.current_qn));
            for (const qn of codec.accept_qn || []) supported.add(Number(qn));
          }
        }
      }
      supported.delete(0);
      const descriptions = new Map((playurl?.g_qn_desc || []).map((item) => [Number(item.qn), String(item.desc || item.hdr_desc || '')]));
      const ordered = [];
      for (const item of playurl?.g_qn_desc || []) {
        const qn = Number(item.qn);
        if (!supported.has(qn) || ordered.some((entry) => entry.qn === qn)) continue;
        ordered.push({ qn, label: String(item.desc || item.hdr_desc || `qn ${qn}`) });
      }
      for (const qn of Array.from(supported).sort((a, b) => b - a)) {
        if (!ordered.some((entry) => entry.qn === qn)) ordered.push({ qn, label: descriptions.get(qn) || `qn ${qn}` });
      }
      return ordered.sort((a, b) => b.qn - a.qn);
    }

    availableFormatSummary(playurl) {
      const values = new Set();
      for (const stream of playurl?.stream || []) {
        for (const format of stream.format || []) {
          for (const codec of format.codec || []) {
            values.add(`${stream.protocol_name}/${format.format_name}/${codec.codec_name}`);
          }
        }
      }
      return Array.from(values).join('、') || '无可用播放流';
    }

    async requestPlayInfo(qn) {
      const url = new URL('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo');
      const params = {
        room_id: this.session.roomId,
        protocol: '0,1',
        format: '0,1,2',
        codec: '0,1',
        qn: String(qn),
        platform: 'web',
        ptype: '8',
        dolby: '5',
        panorama: '1'
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const result = JSON.parse(await this.fetch(url.href));
      if (result.code !== 0) throw new Error(result.message || `播放地址接口错误 ${result.code}`);
      return result.data?.playurl_info?.playurl || null;
    }

    async refreshStream(generation = this.sourceGeneration) {
      const requestedQuality = this.quality;
      let playurl = await this.requestPlayInfo(this.quality === 'auto' ? 30000 : this.quality);
      this.checkSource(generation);
      let candidates = this.collectStreams(playurl);
      if (!candidates.length) {
        throw new Error(`当前直播没有浏览器可缓存的 AVC/fMP4 流（接口返回：${this.availableFormatSummary(playurl)}）`);
      }
      this.qualityOptions = this.collectQualityOptions(playurl);
      const desiredQn = this.quality === 'auto'
        ? Number(this.qualityOptions[0]?.qn || candidates[0].qn)
        : this.qualityOptions.some((item) => item.qn === Number(this.quality))
          ? Number(this.quality)
          : Number(this.qualityOptions[0]?.qn || candidates[0].qn);
      if (!candidates.some((candidate) => candidate.qn === desiredQn)) {
        playurl = await this.requestPlayInfo(desiredQn);
        this.checkSource(generation);
        candidates = this.collectStreams(playurl);
      }
      if (!candidates.length) throw new Error(`清晰度 ${desiredQn} 没有可缓存的 AVC/fMP4 地址`);
      const matching = candidates.filter((candidate) => candidate.qn === desiredQn);
      if (matching.length) candidates = matching;
      const selectedQn = Number(candidates[0].qn);
      if (!(selectedQn > 0)) throw new Error('直播接口未返回实际画质');
      const selectedLabel = this.qualityOptions.find((item) => item.qn === selectedQn)?.label || `qn ${selectedQn}`;
      this.selectedQn = selectedQn;
      this.selectedLabel = selectedLabel;
      // 仅修正本房间有效画质，不覆盖全局偏好或反复请求不支持的 QN。
      if (this.quality !== 'auto' && !this.qualityOptions.some((item) => item.qn === Number(this.quality))) {
        this.quality = selectedQn;
      }
      this.emit('qualities', {
        options: this.qualityOptions,
        preference: this.quality,
        selectedQn,
        selectedLabel,
        sourceGeneration: generation,
        fallback: requestedQuality !== 'auto' && Number(requestedQuality) !== selectedQn
      });
      this.stream = candidates;
      this.lineIndex %= candidates.length;
      this.masterUrl = candidates[this.lineIndex].url;
      this.mediaUrl = this.masterUrl;
      this.emit('stream', { quality: candidates[this.lineIndex].qn, label: selectedLabel, lines: candidates.length });
    }

    segmentIdentity(segment) {
      const url = new URL(segment.url);
      const range = segment.byteRange ? `${segment.byteRange.offset}-${segment.byteRange.length}` : '';
      return `${url.pathname}|${segment.sequence}|${range}`;
    }

    alignTimeline(segments) {
      const anchor = segments.find((segment) => this.timeline.has(this.segmentIdentity(segment)));
      if (anchor) {
        const delta = this.timeline.get(this.segmentIdentity(anchor)) - anchor.startMs;
        for (const segment of segments) segment.startMs += delta;
      }
      for (const segment of segments) {
        const identity = this.segmentIdentity(segment);
        if (this.timeline.has(identity)) segment.startMs = this.timeline.get(identity);
        else this.timeline.set(identity, segment.startMs);
      }
      if (this.timeline.size > 5000) {
        const keepAfter = (segments[0]?.startMs || Date.now()) - 120000;
        for (const [key, value] of this.timeline) if (value < keepAfter) this.timeline.delete(key);
      }
    }

    initIdentity(segment) {
      return `${segment.init?.url || ''}|${JSON.stringify(segment.init?.byteRange || '')}`;
    }

    async storeInit(segment) {
      if (!segment.init?.url) throw new Error('fMP4 播放列表缺少 EXT-X-MAP 初始化段');
      const key = this.initIdentity(segment);
      if (this.initCache.has(key)) return this.initCache.get(key);
      const id = `${this.session.id}-i-${await BLB.resourceDigest(key)}`;
      const buffer = await this.fetchWithRetry(segment.init.url, segment.init.byteRange);
      const mime = BLB.detectFmp4Mime(buffer);
      const mediaInfo = BLB.inspectFmp4Init(buffer);
      if (!MediaSource.isTypeSupported(mime)) throw new Error(`浏览器不支持缓存流编码：${mime}`);
      await this.writeSegment({
        id,
        sessionId: this.session.id,
        kind: 'init',
        startMs: segment.startMs,
        durationMs: 0,
        mime,
        mediaInfo,
        sourceUrl: segment.init.url
      }, buffer);
      const value = { id, mime, key, mediaInfo };
      this.initCache.set(key, value);
      return value;
    }

    beginGroup(reason) {
      this.groupCounter += 1;
      this.currentGroupId = `${this.session.id}-g-${this.groupCounter}`;
      this.pendingBoundary = false;
      this.boundaryReason = reason || 'discontinuity';
    }

    async mediaId(segment) {
      return this.session.id + '-m-' + await BLB.resourceDigest(this.segmentIdentity(segment) + '|' + Math.round(segment.startMs));
    }

    async writeSegment(meta, buffer) {
      try { return await this.storage.putSegment(meta, buffer); }
      catch (error) { error.storageFailure = true; throw error; }
    }

    async downloadMedia(segment, generation, signal = this.networkController.signal) {
      const started = performance.now();
      const buffer = await this.fetchWithRetry(segment.url, segment.byteRange, generation, segment.durationMs, signal);
      this.checkSource(generation);
      const elapsedMs = Math.max(1, performance.now() - started);
      const instantRate = buffer.byteLength * 1000 / elapsedMs;
      this.downloadRate = this.downloadRate ? this.downloadRate * 0.72 + instantRate * 0.28 : instantRate;
      this.lastThroughputAt = Date.now();
      this.emit('throughput', { bytes: buffer.byteLength, elapsedMs, bytesPerSecond: this.downloadRate, measuredAt: this.lastThroughputAt });
      return { buffer, elapsedMs };
    }

    async storeMedia(segment, generation, hasKeyframeHints, playlistDurationMs, downloaded = null) {
      const identity = this.segmentIdentity(segment);
      const id = await this.mediaId(segment);
      if (this.seen.has(id)) return false;
      this.checkSource(generation);
      if (segment.gap) {
        this.pendingBoundary = true;
        this.boundaryReason = 'hls-gap';
        this.seen.add(id);
        return false;
      }
      const init = await this.storeInit(segment);
      this.checkSource(generation);
      const sourceBoundary = this.lastDiscontinuitySequence != null
        && segment.discontinuitySequence !== this.lastDiscontinuitySequence;
      const initChanged = Boolean(this.currentInitKey && (init.key !== this.currentInitKey || init.mime !== this.currentMime));
      const boundary = !this.currentGroupId || this.pendingBoundary || segment.discontinuity || sourceBoundary || initChanged;
      // 新解码组必须从 GOP 起点开始，EXTINF 不代表独立帧。
      if (boundary && hasKeyframeHints && !segment.independent) {
        this.seen.add(id);
        return false;
      }

      const quality = this.selectedQn;
      const qualityLabel = this.selectedLabel;
      const { buffer, elapsedMs } = downloaded || await this.downloadMedia(segment, generation);
      this.checkSource(generation);
      this.lastDownloadMs = elapsedMs;

      const inspected = BLB.inspectFmp4Segment(buffer, init.mediaInfo);
      const independent = Boolean(segment.independent || inspected?.independent === true);
      if (boundary && !independent && inspected?.independent === false) {
        this.seen.add(id);
        return false; // Explicitly dependent first samples need an earlier GOP.
      }
      const expected = Math.max(1, Number(segment.durationMs));
      const measured = Number(inspected?.durationMs);
      const durationMs = Number.isFinite(measured) && measured > 0 && measured < Math.max(60000, expected * 4)
        ? measured : expected;
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('缓存片段缺少有效媒体时长');
      const mediaStartSeconds = Number.isFinite(inspected?.startSeconds) ? inspected.startSeconds : null;
      const clockContinuous = mediaStartSeconds != null && this.sourceClock
        && !sourceBoundary && !segment.discontinuity
        && mediaStartSeconds >= (this.lastMediaEndSeconds ?? mediaStartSeconds) - playlistDurationMs / 1000 - 2
        && mediaStartSeconds - (this.lastMediaEndSeconds ?? mediaStartSeconds) < 120;
      let startMs = clockContinuous
        ? this.sourceClock.wallMs + (mediaStartSeconds - this.sourceClock.mediaSeconds) * 1000
        : segment.startMs;
      if (!Number.isFinite(startMs)) throw new Error('缓存片段缺少有效媒体时间戳');
      const clockSource = clockContinuous ? 'media-timestamp' : segment.programDateTimeMs != null ? 'program-date-time' : 'playlist-anchor';
      // 无法校准重连时保留缺口，禁止改写已显示帧的时间。
      if (!clockContinuous && this.lastStoredEdgeMs && startMs < this.lastStoredEdgeMs
        && startMs + durationMs > this.lastStoredEdgeMs) {
        this.seen.add(id);
        return false;
      }
      if (this.lastStoredEdgeMs && startMs + durationMs <= this.lastStoredEdgeMs + 0.5) {
        this.seen.add(id);
        return false;
      }
      const gapMs = this.lastStoredEdgeMs ? startMs - this.lastStoredEdgeMs : 0;
      if (this.lastStoredEdgeMs && Math.abs(gapMs) < 50) startMs = this.lastStoredEdgeMs;
      else if (gapMs < 0) { this.seen.add(id); return false; }
      const largeGap = this.lastStoredEdgeMs && startMs - this.lastStoredEdgeMs > 50;
      if (largeGap && !independent && (hasKeyframeHints || inspected?.independent === false)) {
        this.pendingBoundary = true;
        this.boundaryReason = 'timeline-gap';
        this.seen.add(id);
        return false;
      }
      if (boundary || largeGap) {
        this.beginGroup(this.pendingBoundary ? this.boundaryReason
          : sourceBoundary ? 'source-discontinuity' : initChanged ? 'quality-boundary' : 'timeline-gap');
      }
      const meta = {
        id, sessionId: this.session.id, kind: 'media', startMs,
        durationMs, mediaDurationMs: durationMs, mediaStartSeconds,
        clockSource, sourceStartMs: segment.startMs,
        sequence: segment.sequence, sourceDiscontinuitySequence: segment.discontinuitySequence,
        groupId: this.currentGroupId, groupNumber: this.groupCounter, groupReason: this.boundaryReason,
        initId: init.id, mime: init.mime, independent,
        discontinuity: Boolean(boundary || largeGap), quality, qualityLabel, sourceGeneration: generation, sourceUrl: segment.url
      };
      const commitStarted = performance.now();
      const result = await this.writeSegment(meta, buffer);
      this.lastCommitMs = performance.now() - commitStarted;
      this.lastSegmentDurationMs = durationMs;
      this.seen.add(id);
      this.lastSegmentAt = Date.now();
      this.lastCommitIntervalMs = this.lastCommittedAt ? this.lastSegmentAt - this.lastCommittedAt : 0;
      this.lastCommittedAt = this.lastSegmentAt;
      this.lastStoredEdgeMs = Math.max(this.lastStoredEdgeMs, startMs + durationMs);
      // 迟到的旧画质写入不得清除新请求的解码边界。
      if (generation === this.sourceGeneration) {
        if (mediaStartSeconds != null) {
          this.sourceClock = { wallMs: startMs, mediaSeconds: mediaStartSeconds };
          this.lastMediaEndSeconds = mediaStartSeconds + durationMs / 1000;
        }
        this.currentInitKey = init.key;
        this.currentMime = init.mime;
        this.lastDiscontinuitySequence = segment.discontinuitySequence;
      }
      this.emit('segment', {
        id, startMs, durationMs, liveEdgeMs: this.lastStoredEdgeMs,
        quality, qualityLabel, sourceGeneration: generation, clockSource, groupId: meta.groupId,
        gapMs: Math.max(0, gapMs), duplicate: result.duplicate, pruned: result.pruned,
        downloadMs: this.lastDownloadMs, commitMs: this.lastCommitMs, intervalMs: this.lastCommitIntervalMs
      });
      if (result.pruned?.blocked) {
        this.cacheLimitBlocked = true;
        this.running = false;
        this.emit('status', { state: 'error', text: '缓存已达上限，无法安全删除关键帧依赖；增大上限后恢复录制' });
      }
      return !result.duplicate;
    }

    async pollOnce() {
      const generation = this.sourceGeneration;
      if (!this.mediaUrl) await this.refreshStream(generation);
      this.checkSource(generation);
      let playlistUrl = this.mediaUrl;
      let parsed = BLB.parseHlsPlaylist(await this.fetch(playlistUrl, 'text', null, 8000), playlistUrl);
      this.checkSource(generation);
      if (parsed.type === 'master') {
        playlistUrl = parsed.variant.url;
        this.mediaUrl = playlistUrl;
        parsed = BLB.parseHlsPlaylist(await this.fetch(playlistUrl, 'text', null, 8000), playlistUrl);
      }
      this.checkSource(generation);
      if (parsed.type !== 'media') throw new Error('没有找到 HLS 媒体播放列表');
      this.alignTimeline(parsed.segments);
      let added = false;
      let lastFailure = null;
      this.lastBatchSkipped = 0;
      const hasKeyframeHints = parsed.segments.some((segment) => segment.independent);
      const playlistDurationMs = parsed.segments.reduce((total, segment) => total + segment.durationMs, 0);
      this.playlistTargetMs = parsed.targetDurationMs;
      const ids = await Promise.all(parsed.segments.map((segment) => this.mediaId(segment)));
      this.checkSource(generation);
      const candidates = parsed.segments.filter((segment, index) =>
        segment.startMs + segment.durationMs >= this.session.startedAt - 60000 && !this.seen.has(ids[index]));
      const batch = new AbortController();
      const sourceSignal = this.networkController.signal;
      const abortBatch = () => batch.abort();
      sourceSignal.addEventListener('abort', abortBatch, { once: true });
      if (sourceSignal.aborted) batch.abort();
      try {
        await BLB.orderedPrefetch(candidates,
          async (segment) => {
            if (segment.gap) return null;
            try { return await this.downloadMedia(segment, generation, batch.signal); }
            catch (error) {
              if (error.name === 'AbortError') throw error;
              return { failure: error };
            }
          },
          async (segment, downloaded) => {
            this.checkSource(generation);
            if (downloaded?.failure) {
              const error = downloaded.failure;
              // 鉴权错误需更新签名，不能永久跳过片段。
              if (/HTTP (401|403)\b/.test(error.message)) throw error;
              lastFailure = error;
              this.seen.add(await this.mediaId(segment));
              this.pendingBoundary = true;
              this.boundaryReason = 'missing-segment';
              this.skippedSegments++;
              this.lastBatchSkipped++;
              this.emit('gap', { sequence: segment.sequence, durationMs: segment.durationMs, reason: error.message });
              return;
            }
            added = (await this.storeMedia(segment, generation, hasKeyframeHints, playlistDurationMs, downloaded)) || added;
            if (!this.running) batch.abort();
          }, batch.signal);
      } finally {
        sourceSignal.removeEventListener('abort', abortBatch);
        batch.abort(); // Also cancels prefetched requests on a failed commit.
      }
      if (!added && lastFailure) throw lastFailure;
      if (added) this.stagnantPolls = 0;
      else this.stagnantPolls += 1;
      if (this.stagnantPolls > 12 && Date.now() - (this.lastSegmentAt || this.runStartedAt) > Math.max(15000, parsed.targetDurationMs * 4)) {
        throw new Error('播放列表长时间没有新分片');
      }
      return parsed.targetDurationMs;
    }

    start() {
      if (this.running) return this.runPromise;
      // 重启先等待旧循环结束，确保只有一个磁盘写入者。
      if (this.runPromise) {
        if (!this.restartPromise) {
          const stopVersion = this.stopVersion;
          this.restartPromise = this.runPromise.catch(() => {}).then(() => {
            this.restartPromise = null;
            if (stopVersion === this.stopVersion) return this.start();
          });
        }
        return this.restartPromise;
      }
      const work = this.run();
      this.runPromise = work.finally(() => { this.runPromise = null; });
      return this.runPromise;
    }

    async run() {
      if (this.networkController.signal.aborted) this.networkController = new AbortController();
      this.running = true;
      this.runStartedAt = Date.now();
      this.emit('status', { state: 'starting', text: '正在连接直播流…' });
      while (this.running) {
        let delay = 1500;
        const pollStarted = performance.now();
        try {
          const target = await this.pollOnce();
          if (!this.running) break;
          this.errorCount = 0;
          // 轮询间隔扣除下载与提交耗时。
          delay = Math.max(100, Math.max(800, Math.min(4000, target / 2)) - (performance.now() - pollStarted));
          this.emit('status', { state: 'recording', text: this.lastBatchSkipped ? '正在缓存，部分分片缺失' : '正在缓存' });
        } catch (error) {
          if (!this.running) break;
          if (error.storageFailure || /配额不足|QuotaExceeded/i.test(error.message)) {
            this.running = false;
            this.storageFault = error.message;
            this.downloadRate = 0;
            this.emit('throughput', { bytesPerSecond: 0, measuredAt: Date.now() });
            this.emit('status', { state: 'error', text: `缓存写入已停止：${error.message}。释放空间或恢复授权后，点击“重试连接与播放”`, error });
            break;
          }
          if (error.name === 'AbortError') continue;
          this.errorCount += 1;
          this.downloadRate = 0;
          this.emit('throughput', { bytesPerSecond: 0, measuredAt: Date.now() });
          this.emit('status', { state: 'reconnecting', text: `直播流重连中：${error.message}`, error });
          delay = Math.min(8000, 1000 * (2 ** Math.min(this.errorCount, 3)));
          this.mediaUrl = '';
          this.pendingBoundary = true;
          this.boundaryReason = 'reconnect';
          if (this.stream?.length) this.lineIndex = (this.lineIndex + 1) % this.stream.length;
        }
        await this.waitForPoll(delay);
      }
    }

    restartSource(reason) {
      this.sourceGeneration += 1;
      this.networkController.abort();
      this.networkController = new AbortController();
      this.mediaUrl = '';
      this.masterUrl = '';
      this.stream = null;
      this.pendingBoundary = true;
      this.boundaryReason = reason;
      this.wakePoll?.();
    }

    reconnect({ retryStorage = false } = {}) {
      this.errorCount = 0;
      if (retryStorage && this.storageFault && !this.cacheLimitBlocked) {
        this.storageFault = null;
        this.restartSource('storage-retry');
        this.start().catch((error) => this.emit('status', { state: 'error', text: error.message }));
        return;
      }
      if (!this.running) return;
      this.restartSource('network-reconnect');
    }

    async setQuality(quality) {
      let nextQuality = quality === 'auto' ? 'auto' : Number(quality);
      if (nextQuality !== 'auto' && !Number.isFinite(nextQuality)) return;
      if (nextQuality !== 'auto' && this.qualityOptions.length
        && !this.qualityOptions.some((item) => item.qn === nextQuality)) nextQuality = this.qualityOptions[0].qn;
      const previousQuality = this.quality;
      if (nextQuality !== this.quality) {
        this.quality = nextQuality;
        this.restartSource('quality-change');
        this.emit('status', { state: 'reconnecting', text: '正在切换观看与缓存画质…' });
      }
      this.emit('qualitychange', { previousQuality, quality: nextQuality, sourceGeneration: this.sourceGeneration, keepsHistory: true });
    }

    stop() {
      this.storageFault = null;
      this.stopVersion += 1;
      this.sourceGeneration += 1;
      this.networkController.abort();
      this.running = false;
      this.wakePoll?.();
      this.emit('status', { state: 'stopped', text: '缓存已停止' });
    }
  }

  BLB.HlsRecorder = HlsRecorder;
})(globalThis);
