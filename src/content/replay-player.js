(function initReplayPlayer(global) {
  'use strict';
  const BLB = global.BiliLiveBar;
  const KEYFRAME_LOOKBACK_MS = 60 * 1000;
  const STALL_RELOAD_MS = 4000;
  const DANMAKU_QUERY_AHEAD_MS = 8000;
  const DANMAKU_QUERY_LEAD_MS = 2500;
  const DANMAKU_LATE_GRACE_MS = 2000;
  const DANMAKU_MAX_ACTIVE_NODES = 500;
  const DANMAKU_MAX_RENDER_PER_TICK = 160;
  const DANMAKU_FONT_FAMILIES = {
    sans: 'Microsoft YaHei, PingFang SC, system-ui, sans-serif',
    yahei: 'Microsoft YaHei, PingFang SC, sans-serif',
    simhei: 'SimHei, Microsoft YaHei, sans-serif',
    simsun: 'SimSun, STSong, serif',
    kaiti: 'KaiTi, STKaiti, serif'
  };
  const instances = new Map();
  const CACHE_MANIFEST_MIME = 'application/x-bililivebar-hls';
  let schemeInstalled = false;

  function asBuffer(text) {
    return new TextEncoder().encode(text).buffer;
  }

  function normalizeLiveBuffer(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return 5;
    return Math.max(0, Math.min(10, Math.round(seconds * 2) / 2));
  }

  let cachedDeepRoots = [document];
  let cachedDeepRootsAt = 0;

  function deepRoots() {
    if (Date.now() - cachedDeepRootsAt < 1000) return cachedDeepRoots;
    const roots = [document];
    const seen = new Set(roots);
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      let elements = [];
      try { elements = root.querySelectorAll('*'); } catch (_) { /* stale root */ }
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
          } catch (_) { /* cross-origin frame */ }
        }
      }
    }
    cachedDeepRoots = roots;
    cachedDeepRootsAt = Date.now();
    return roots;
  }

  function deepElements(selector, roots = deepRoots()) {
    const matches = [];
    for (const root of roots) {
      try { matches.push(...root.querySelectorAll(selector)); } catch (_) { /* stale root */ }
    }
    return matches;
  }

  function ensureExtensionStyles(node) {
    const ownerDocument = node?.ownerDocument || document;
    const rootNode = node?.getRootNode?.();
    const target = rootNode?.host ? rootNode : ownerDocument.head;
    if (!target?.querySelector || target.querySelector('link[data-bililivebar-styles]')) return;
    const link = ownerDocument.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/bililivebar.css');
    link.dataset.bililivebarStyles = 'true';
    target.append(link);
  }

  function installBiliLiveBarScheme() {
    if (schemeInstalled) return;
    if (!global.shaka?.net?.NetworkingEngine) throw new Error('Shaka Player 没有正确加载');
    global.shaka.polyfill.installAll();
    // 仅使用公开解析器接口，不影响页面其他播放器。
    global.shaka.media.ManifestParser.registerParserByMime(CACHE_MANIFEST_MIME, () => {
      const parser = new global.shaka.hls.HlsParser();
      const start = parser.start.bind(parser), stop = parser.stop.bind(parser), update = parser.update.bind(parser);
      let owner, stopped = false, updating = null;
      parser.start = async (uri, playerInterface) => {
        owner = instances.get(new URL(uri).hostname);
        const manifest = await start(uri, playerInterface);
        if (!stopped && owner && Number(new URL(uri).searchParams.get('v')) === owner.snapshotVersion) {
          owner.cacheParser = parser;
        }
        return manifest;
      };
      parser.update = () => {
        if (stopped) return Promise.resolve();
        if (!updating) updating = Promise.resolve().then(update).finally(() => { updating = null; });
        return updating;
      };
      parser.stop = () => {
        stopped = true;
        if (owner?.cacheParser === parser) owner.cacheParser = null;
        return stop();
      };
      return parser;
    });
    global.shaka.net.NetworkingEngine.registerScheme('bililivebar', (uri) => {
      let canceled = false;
      const pending = (async () => {
        const parsed = new URL(uri);
        const replay = instances.get(parsed.hostname);
        if (!replay) throw new Error('历史播放器实例已经失效');
        const result = await replay.getVirtualResource(parsed);
        if (canceled) throw new Error('请求已取消');
        return {
          uri,
          originalUri: uri,
          data: result.buffer,
          status: 200,
          headers: { 'content-type': result.contentType },
          timeMs: Date.now(),
          byteLength: result.buffer.byteLength
        };
      })();
      return new global.shaka.util.AbortableOperation(pending, () => {
        canceled = true;
        return Promise.resolve();
      });
    });
    schemeInstalled = true;
  }

  function codecList(mime) {
    return /codecs\s*=\s*"([^"]+)"/i.exec(mime || '')?.[1]?.replace(/\s+/g, '') || 'avc1.640028,mp4a.40.2';
  }

  function segmentUri(instanceId, kind, id) {
    const extension = kind === 'init' ? 'mp4' : 'm4s';
    return `bililivebar://${instanceId}/segment.${extension}?id=${encodeURIComponent(id)}`;
  }

  function playableDurationMs(record) {
    const measured = Number(record?.mediaDurationMs || 0);
    return Number.isFinite(measured) && measured > 0 ? measured : Math.max(1, Number(record?.durationMs || 0));
  }

  function buildPlaylist(instanceId, records) {
    const maxDuration = records.reduce((max, record) => Math.max(max, Math.ceil(playableDurationMs(record) / 1000)), 1);
    const firstOrdinal = Math.max(0, Number(records[0]?.ordinal ?? records[0]?.sequence ?? 0));
    const allIndependent = records.length > 0 && records.every((record) => record.independent);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${maxDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstOrdinal}`,
      '#EXT-X-PLAYLIST-TYPE:EVENT'
    ];
    if (allIndependent) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');

    let currentInitId = '';
    let currentGroupId = records[0]?.groupId || '';
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const groupChanged = index > 0 && record.groupId !== currentGroupId;
      if (groupChanged || (index > 0 && record.discontinuity)) lines.push('#EXT-X-DISCONTINUITY');
      if (groupChanged) currentGroupId = record.groupId;
      if (record.initId !== currentInitId) {
        lines.push(`#EXT-X-MAP:URI="${segmentUri(instanceId, 'init', record.initId)}"`);
        currentInitId = record.initId;
      }
      lines.push(`#EXTINF:${(playableDurationMs(record) / 1000).toFixed(6)},`);
      lines.push(segmentUri(instanceId, 'media', record.id));
    }
    lines.push('');
    return lines.join('\n');
  }

  class ReplayPlayer extends EventTarget {
    constructor({ storage, session, settings = {} }) {
      super();
      this.storage = storage;
      this.session = session;
      this.liveEdgeMs = Number(session.liveEdgeMs || session.startedAt);
      this.earliestMs = Math.max(session.startedAt, Number(session.firstMediaMs || session.startedAt));
      this.segmentCount = Number(session.segmentCount || 0);
      this.liveBufferSeconds = normalizeLiveBuffer(settings.liveBufferSeconds);
      this.stallRecovery = settings.stallRecovery === 'live' ? 'live' : 'resume';
      this.liveRecoveryPending = false;
      this.bufferPolicy = new BLB.LiveBufferPolicy({
        seconds: settings.adaptiveBuffer !== false ? 5 : this.liveBufferSeconds,
        adaptive: settings.adaptiveBuffer !== false
      });
      this.rateEvents = [];
      this.active = false; // Managed playback, including LIVE. Never a native/history switch.
      this.mode = 'live';
      this.rate = 1;
      this.catchupToLive = false;
      this.userPaused = false;
      this.pausedWallMs = 0;
      this.pausePoint = null;
      this.playRequest = 0;
      this.lastPauseCorrectionAt = 0;
      this.pauseExpired = false;
      this.presentedFrame = null;
      this.scrubHeld = false;
      this.pendingSeekWallMs = 0;
      this.failedWallMs = 0;
      this.lastConfirmedWallMs = this.earliestMs;
      this.root = null;
      this.layerHost = null;
      this.nativeVideo = null;
      this.nativeVisualSnapshots = new Map();
      this.nativeAudioSnapshots = new Map();
      this.hostPositionSnapshots = new Map();
      this.observedNativeVideos = new WeakSet();
      this.observedPointerRoots = new WeakSet();
      this.lastForwardedPointerAt = 0;
      this.layer = document.createElement('div');
      this.layer.className = 'bililivebar-replay-layer';
      for (const [key, value] of Object.entries({
        position: 'absolute', inset: '0', 'z-index': '11', display: 'none',
        overflow: 'hidden', background: '#000', 'pointer-events': 'none'
      })) this.layer.style.setProperty(key, value, 'important');
      this.video = document.createElement('video');
      this.video.className = 'bililivebar-replay-video';
      this.video.playsInline = true;
      this.video.preload = 'auto';
      this.video.preservesPitch = true;
      this.video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none';
      this.freezeFrame = document.createElement('canvas');
      this.freezeFrame.style.cssText = 'display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none';
      this.danmakuLayer = document.createElement('div');
      this.danmakuLayer.className = 'bililivebar-danmaku-layer';
      this.danmakuLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:layout paint';
      this.layer.append(this.video, this.freezeFrame, this.danmakuLayer);
      this.instanceId = crypto.randomUUID().replace(/-/g, '').toLowerCase();
      this.snapshotVersion = 0;
      this.windowSegments = [];
      this.windowStartMs = this.earliestMs;
      this.windowEndMs = this.liveEdgeMs;
      this.mediaManifest = '';
      this.masterManifest = '';
      this.manifestRefreshPromise = null;
      this.cacheParser = null;
      this.cacheRefreshTimer = 0;
      this.cacheRefreshBusy = false;
      this.cacheRefreshDirty = false;
      this.handoff = { commitAt: 0, manifestAt: 0, readAt: 0, readMs: 0, commitToReadMs: 0, notifications: 0 };
      this.timelinePromise = null;
      this.player = null;
      this.playerPromise = null;
      this.playerLoaded = false;
      this.generation = 0;
      this.loading = 0;
      this.operations = Promise.resolve();
      this.startPromise = null;
      this.nextStartAt = 0;
      this.recoveryPromise = null;
      this.recoveryPlan = null;
      this.recoveryPending = false;
      this.automaticSeek = false;
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
      this.recoveryEdgeMs = 0;
      this.lastRetryStreamingAt = 0;
      this.laggingSince = 0;
      this.tailRecords = [];
      this.tailEdgeMs = 0;
      this.tailStartMs = this.earliestMs;
      this.lastEdgeAt = 0;
      this.audioPreference = null;
      this.lastAudibleVolume = 1;
      this.lastRecoveryAt = 0;
      this.bufferingSince = 0;
      this.engineBuffering = false;
      this.lastProgressAt = Date.now();
      this.lastVideoTime = 0;
      this.playbackHealth = new BLB.PlaybackHealth();
      this.healthState = null;
      if (typeof settings.playbackMuted === 'boolean' || Number.isFinite(settings.playbackVolume)) {
        this.audioPreference = {
          volume: Math.max(0, Math.min(1, Number.isFinite(settings.playbackVolume) ? settings.playbackVolume : 1)),
          muted: settings.playbackMuted === true
        };
        if (this.audioPreference.volume > 0) this.lastAudibleVolume = this.audioPreference.volume;
      }
      this.events = [];
      this.destroyed = false;
      instances.set(this.instanceId, this);
      installBiliLiveBarScheme();
      this.monitor = global.setInterval(() => this.onTick(), 200);
      this.video.addEventListener('waiting', () => this.markBuffering());
      this.video.addEventListener('stalled', () => this.markBuffering());
      this.video.addEventListener('play', () => this.enforcePause());
      this.video.addEventListener('playing', () => {
        if (this.userPaused || this.scrubHeld) this.enforcePause();
        else {
          this.clearBuffering();
        }
      });
      this.video.addEventListener('seeked', () => this.enforcePause());
      this.video.addEventListener('volumechange', () => this.emit('volume', this.audioState()));
      this.video.addEventListener('ratechange', () => {
        if (this.rateEvents.at(-1)?.rate === this.video.playbackRate) return;
        this.rateEvents.push({ at: Date.now(), rate: this.video.playbackRate,
          defaultRate: this.video.defaultPlaybackRate, buffering: this.engineBuffering, mode: this.mode,
          strategy: this.rateStrategy(), bufferAheadSeconds: this.replayBufferAhead() });
        if (this.rateEvents.length > 120) this.rateEvents.shift();
      });
      this.video.addEventListener('error', () => {
        this.recordEvent('media-error', { code: this.video.error?.code });
        this.recoveryPending = true;
        this.markBuffering();
        this.emit('status', { state: 'warning', text: '视频解码中断，等待恢复播放' });
      });
      // 帧观测仅辅助健康判断，后台缺回调不得阻塞定位。
      if (this.video.requestVideoFrameCallback) {
        const observeFrame = (_now, metadata) => {
          if (this.destroyed) return;
          this.presentedFrame = {
            mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
            observedAt: Date.now(), revision: this.snapshotVersion
          };
          this.frameCallback = this.video.requestVideoFrameCallback(observeFrame);
        };
        this.frameCallback = this.video.requestVideoFrameCallback(observeFrame);
      }
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    recordEvent(type, detail = {}) {
      this.events.push({ at: new Date().toISOString(), type, ...detail });
      if (this.events.length > 100) this.events.shift();
    }

    async ensurePlayer() {
      if (this.playerPromise) return this.playerPromise;
      this.playerPromise = (async () => {
        if (!global.shaka.Player.isBrowserSupported()) throw new Error('浏览器不支持 MSE 播放');
        const player = new global.shaka.Player();
        await player.attach(this.video);
        player.configure({
          abr: { enabled: false },
          streaming: {
            bufferingGoal: 45, rebufferingGoal: this.playbackBufferGoal(), bufferBehind: 120,
            lowLatencyMode: false, startAtSegmentBoundary: false,
            safeSeekOffset: 0, safeSeekEndOffset: 0,
            returnToEndOfLiveWindowWhenOutside: false, stopFetchingOnPause: false,
            liveSync: { enabled: false }, vodDynamicPlaybackRate: false,
            // 停滞检测不得擅自改变播放位置。
            stallEnabled: false, gapDetectionThreshold: 0.05
          },
          manifest: {
            updatePeriod: 1, continueLoadingWhenPaused: true,
            // 零值会回退到 HLS 默认延迟，需显式禁用三分片回退。
            defaultPresentationDelay: 0.05,
            hls: { sequenceMode: true, ignoreManifestProgramDateTime: true, liveSegmentsDelay: 0 }
          }
        });
        player.addEventListener('error', (event) => {
          this.recordEvent('player-error', { code: event.detail?.code });
          if (this.active) this.emit('status', {
            state: 'warning', text: '播放数据暂不可用，正在重试'
          });
          this.recoveryPending = true;
          this.markBuffering();
        });
        player.addEventListener('buffering', (event) => {
          this.engineBuffering = Boolean(event.buffering ?? event.detail?.buffering);
          if (this.engineBuffering) this.markBuffering();
          else {
            if (!this.loading && !this.pendingSeekWallMs) this.applyPlaybackRate(this.mode === 'live' ? 1 : this.rate);
            this.clearBuffering();
          }
        });
        this.player = player;
        return player;
      })();
      return this.playerPromise;
    }

    mount(root, nativeVideo) {
      if (!root || !nativeVideo) return;
      const layerHost = root;
      ensureExtensionStyles(layerHost);
      const previousHost = this.layerHost;
      this.root = root;
      this.layerHost = layerHost;
      this.observePointerRoot(layerHost);
      if (layerHost !== document.body && layerHost !== document.documentElement
        && getComputedStyle(layerHost).position === 'static') {
        if (!this.hostPositionSnapshots.has(layerHost)) {
          this.hostPositionSnapshots.set(layerHost, {
            value: layerHost.style.getPropertyValue('position'),
            priority: layerHost.style.getPropertyPriority('position')
          });
        }
        layerHost.style.setProperty('position', 'relative', 'important');
      }
      if (this.layer.parentElement !== layerHost) layerHost.appendChild(this.layer);
      layerHost.classList.add('bililivebar-player-host');
      if (previousHost && previousHost !== layerHost && !previousHost.contains(this.layer)) {
        previousHost.classList.remove('bililivebar-player-host');
        this.restoreHostPosition(previousHost);
      }
      if (this.nativeVideo !== nativeVideo) {
        this.nativeVideo = nativeVideo;
        // 原生节点更换不得重置音量。
        if (this.active) {
          nativeVideo.volume = this.video.volume;
          this.nativeAudioSnapshots.set(nativeVideo, this.video.muted);
        }
        this.observeNativeVideo(nativeVideo);
        if (this.active) {
          this.saveAndMaskVideo(nativeVideo);
          this.maskNativeVideos();
        }
      }
      this.maybeStart();
    }

    observePointerRoot(root) {
      if (!root || this.observedPointerRoots.has(root)) return;
      this.observedPointerRoots.add(root);
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'input']) {
        root.addEventListener(type, (event) => this.captureNativeAudioGesture(event), { capture: true, passive: true });
      }
      root.addEventListener('mousemove', (event) => {
        if (!this.active || !event.isTrusted || !this.nativeVideo
          || Date.now() - this.lastForwardedPointerAt < 40) return;
        const originalTarget = event.composedPath?.()[0] || event.target;
        if (originalTarget === this.nativeVideo) return;
        this.lastForwardedPointerAt = Date.now();
        const EventConstructor = this.nativeVideo.ownerDocument?.defaultView?.MouseEvent || MouseEvent;
        this.nativeVideo.dispatchEvent(new EventConstructor('mousemove', {
          bubbles: true,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY
        }));
      }, { passive: true });
    }

    observeNativeVideo(video) {
      if (!video || this.observedNativeVideos.has(video)) return;
      this.observedNativeVideos.add(video);
      video.addEventListener('volumechange', () => {
        if (this.destroyed || this.nativeVideo !== video) return;
        // 原生遮蔽或重载也触发 volumechange；只接受用户手势修改偏好。
        if (this.active && !video.muted) {
          video.muted = true;
        }
      });
    }

    captureNativeAudioGesture(event) {
      if (this.destroyed || !event.isTrusted || (event.type === 'pointermove' && !event.buttons)) return;
      const target = event.composedPath?.()[0] || event.target;
      if (target?.closest?.('.bililivebar-controls,.bililivebar-popover')
        || !target?.closest?.('[class*="volume"],[class*="Volume"]')) return;
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const native = this.nativeVideo;
      // 在原生用户操作后读取一次音量，忽略后续重载或遮蔽事件。
      global.setTimeout(() => {
        if (this.destroyed || !native || native !== this.nativeVideo) return;
        if (native.volume !== (this.audioPreference?.volume ?? this.video.volume)) this.setVolume(native.volume);
      }, 0);
    }

    audioState() {
      const media = this.active ? this.video : this.nativeVideo || this.video;
      return { volume: media?.volume ?? 1, muted: Boolean(media?.muted) };
    }

    initialAudioState() {
      if (this.audioPreference) return this.audioPreference;
      const native = this.audioState();
      // 不继承自动播放静音；浏览器仍可要求用户点击播放。
      return { volume: native.volume > 0 ? native.volume : this.lastAudibleVolume || 1, muted: false };
    }

    setVolume(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      const volume = Math.max(0, Math.min(1, number));
      if (volume > 0) this.lastAudibleVolume = volume;
      this.applyAudio({ volume, muted: volume === 0 });
    }

    setMuted(muted) {
      const audio = this.audioState();
      if (!muted && audio.volume === 0) audio.volume = this.lastAudibleVolume || 1;
      this.applyAudio({ volume: audio.volume, muted: Boolean(muted) });
    }

    applyAudio(audio) {
      this.audioPreference = audio;
      this.video.volume = audio.volume;
      this.video.muted = audio.muted;
      if (this.nativeVideo) {
        if (this.nativeVideo.volume !== audio.volume) this.nativeVideo.volume = audio.volume;
        if (this.active) this.nativeAudioSnapshots.set(this.nativeVideo, audio.muted);
        this.nativeVideo.muted = this.active || audio.muted;
      }
      this.emit('volume', audio);
      this.emit('audio-preference', audio);
    }

    restoreHostPosition(host) {
      const snapshot = this.hostPositionSnapshots.get(host);
      if (!snapshot) return;
      if (snapshot.value) host.style.setProperty('position', snapshot.value, snapshot.priority);
      else host.style.removeProperty('position');
      this.hostPositionSnapshots.delete(host);
    }

    saveAndMaskSurface(surface) {
      if (!surface || surface === this.video || this.layer.contains(surface)) return;
      if (!this.nativeVisualSnapshots.has(surface)) {
        this.nativeVisualSnapshots.set(surface, ['opacity'].reduce((snapshot, key) => {
          snapshot[key] = {
            value: surface.style.getPropertyValue(key),
            priority: surface.style.getPropertyPriority(key)
          };
          return snapshot;
        }, {}));
      }
      // 用 opacity 隐藏原生画面，保留命中测试以维持全屏控制栏。
      if (surface.style.getPropertyValue('opacity') !== '0' || surface.style.getPropertyPriority('opacity') !== 'important') {
        surface.style.setProperty('opacity', '0', 'important');
      }
    }

    saveAndMaskVideo(video) {
      if (!video || video === this.video) return;
      if (!this.nativeAudioSnapshots.has(video)) this.nativeAudioSnapshots.set(video, video.muted);
      if (video.dataset.bililivebarParked !== 'true') video.dataset.bililivebarParked = 'true';
      if (!video.muted) video.muted = true;
      if (!video.paused) video.pause();
      this.saveAndMaskSurface(video);
    }

    maskNativeVideos() {
      if (!this.active) return;
      // 活动页可能在播放器根外保留媒体节点，须全页静音并遮蔽其画面。
      const roots = deepRoots();
      for (const video of deepElements('video:not(.bililivebar-replay-video)', roots)) {
        this.saveAndMaskVideo(video);
      }
      for (const audio of deepElements('audio', roots)) {
        if (!this.nativeAudioSnapshots.has(audio)) this.nativeAudioSnapshots.set(audio, audio.muted);
        if (!audio.muted) audio.muted = true;
      }
      for (const canvas of deepElements('canvas', roots)) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width >= 320 && rect.height >= 180 && rect.width * rect.height >= 100000) {
          this.saveAndMaskSurface(canvas);
        }
      }
      this.saveAndMaskVideo(this.nativeVideo);
    }

    restoreNativeVideos() {
      for (const [video, snapshot] of this.nativeVisualSnapshots) {
        for (const [key, state] of Object.entries(snapshot)) {
          if (state.value) video.style.setProperty(key, state.value, state.priority);
          else video.style.removeProperty(key);
        }
      }
      this.nativeVisualSnapshots.clear();
      for (const [video, muted] of this.nativeAudioSnapshots) {
        delete video.dataset.bililivebarParked;
        video.muted = muted;
      }
      this.nativeAudioSnapshots.clear();
    }

    isLive() { return this.active && this.followsLive() && !this.userPaused && !this.pendingSeekWallMs; }
    followsLive() { return this.mode === 'live' || this.mode === 'edge'; }
    isPaused() { return this.userPaused; }
    playbackBufferGoal() {
      // MSE 恢复门槛与磁盘保留时长独立。
      const base = this.followsLive() ? Math.min(1, Math.max(0.5, this.playbackTargetBuffer() / 2)) : 0.5;
      const position = this.pendingSeekWallMs || this.lastConfirmedWallMs || this.earliestMs;
      const available = Math.max(0, (this.liveEdgeMs - position) / 1000);
      return Math.min(base, Math.max(0.05, available / 2));
    }
    targetLiveBuffer() { return this.bufferPolicy.target(); }
    playbackTargetBuffer() { return this.mode === 'edge' ? 0 : this.targetLiveBuffer(); }
    rateStrategy() {
      return this.followsLive() ? (this.playbackTargetBuffer() === 0 ? 'low-delay' : 'steady-live') : 'manual';
    }
    configurePlaybackBuffer() {
      const goal = this.playbackBufferGoal();
      if (this.player && (this.lastBufferGoal == null || Math.abs(this.lastBufferGoal - goal) > 0.05)) {
        this.player.configure({ streaming: { rebufferingGoal: goal } });
        this.lastBufferGoal = goal;
      }
    }
    applyPlaybackRate(rate) {
      // 缓冲时由 Shaka 持有 0×；其余情况统一更新默认与实际倍率。
      if (this.engineBuffering) return;
      if (this.video.defaultPlaybackRate !== rate) this.video.defaultPlaybackRate = rate;
      if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
    }
    applyLivePlaybackRate() { this.applyPlaybackRate(1); }
    observeBufferSample(detail) {
      if (detail.duplicate || detail.gapMs > 250) return;
      this.lastSegmentDurationMs = detail.durationMs;
      this.bufferPolicy.observe(detail);
      this.configurePlaybackBuffer();
    }
    setAdaptiveBuffer(enabled) {
      const previousTarget = this.targetLiveBuffer();
      this.bufferPolicy.configure(enabled ? 5 : this.liveBufferSeconds, enabled);
      if (this.targetLiveBuffer() !== previousTarget) this.liveBufferTargetDirty = true;
      this.configurePlaybackBuffer();
    }
    setStallRecovery(value) {
      const next = value === 'live' ? 'live' : 'resume';
      if (next === this.stallRecovery) return;
      this.stallRecovery = next;
      this.liveRecoveryPending = false;
    }
    returnsLiveAfterStall() { return this.stallRecovery === 'live' && this.followsLive(); }
    recoveryLiveTarget() {
      if (!this.liveDataAvailable()) return null;
      const start = Math.max(this.earliestMs, this.tailStartMs || this.earliestMs);
      const target = Math.max(start, this.liveEdgeMs - Math.max(0.5, this.playbackTargetBuffer()) * 1000);
      return this.liveEdgeMs - target >= Math.max(0.5, this.playbackBufferGoal()) * 1000 ? target : null;
    }
    timelineEndWallMs() { return this.liveEdgeMs; }

    currentWallMs() {
      if (this.pendingSeekWallMs || this.loading || this.scrubHeld) return this.lastConfirmedWallMs;
      if (this.failedWallMs) return this.failedWallMs;
      if (this.userPaused && this.pausedWallMs) return this.pausedWallMs;
      if (!this.active || !this.playerLoaded) return this.lastConfirmedWallMs;
      return BLB.mediaToWall(this.windowSegments, this.video.currentTime) ?? this.lastConfirmedWallMs;
    }

    liveDataAvailable() {
      const staleAfter = Math.min(30000, Math.max(5000, (this.lastSegmentDurationMs || 1000) * 3));
      return this.segmentCount > 0 && Date.now() - this.lastEdgeAt < staleAfter;
    }

    // 诊断差值以已提交缓存为基准，不是主播时钟。
    liveLagSeconds() { return Math.max(0, (this.liveEdgeMs - this.currentWallMs()) / 1000); }

    setLiveBuffer(value) {
      const previousTarget = this.targetLiveBuffer();
      this.liveBufferSeconds = normalizeLiveBuffer(value);
      this.bufferPolicy.configure(this.bufferPolicy.adaptive ? 5 : this.liveBufferSeconds, this.bufferPolicy.adaptive);
      if (this.targetLiveBuffer() !== previousTarget) this.liveBufferTargetDirty = true;
      this.configurePlaybackBuffer();
      // 下次 LIVE 定位应用，不移动暂停画面。
      this.recordEvent('live-buffer', { seconds: this.liveBufferSeconds });
      this.emit('timeline', {});
    }

    observeLiveEdge(value) {
      if (!Number.isFinite(Number(value))) return;
      if (Number(value) > this.liveEdgeMs) this.lastEdgeAt = Date.now();
      this.liveEdgeMs = Math.max(this.liveEdgeMs, Number(value));
      this.emit('timeline', {});
    }

    notifyCacheCommit(detail) {
      if (this.destroyed) return;
      this.observeLiveEdge(detail.liveEdgeMs);
      if (detail.duplicate) return;
      if (detail.gapMs > 250 && Number.isFinite(detail.startMs)) {
        this.tailStartMs = Math.max(this.earliestMs, detail.startMs);
        this.recordEvent('live-tail-changed', { reason: 'cache-gap', gapMs: detail.gapMs });
      }
      this.handoff.commitAt = Date.now();
      this.cacheRefreshDirty = true;
      this.scheduleCacheRefresh();
    }

    scheduleCacheRefresh() {
      if (this.destroyed || this.cacheRefreshTimer || this.cacheRefreshBusy || !this.playerLoaded) return;
      this.cacheRefreshTimer = global.setTimeout(async () => {
        this.cacheRefreshTimer = 0;
        if (this.destroyed || !this.playerLoaded) return;
        this.cacheRefreshBusy = true;
        this.cacheRefreshDirty = false;
        const revision = this.snapshotVersion;
        try {
          await this.refreshWindowManifest();
          if (this.destroyed || revision !== this.snapshotVersion || !this.playerLoaded) return;
          await this.cacheParser?.update();
          this.handoff.notifications += 1;
        } catch (error) {
          if (!this.destroyed) this.recordEvent('cache-handoff-retry', { name: error.name });
          // 通知失败回退到解析器轮询，不重载或移动播放位置。
        } finally {
          this.cacheRefreshBusy = false;
          if (this.cacheRefreshDirty) this.scheduleCacheRefresh();
        }
      }, 50);
    }

    async refreshSegments() {
      if (this.timelinePromise) return this.timelinePromise;
      const work = (async () => {
        const timeline = await this.storage.getTimeline(this.session.id);
        this.segmentCount = Number(timeline.segmentCount || 0);
        if (this.segmentCount) {
          this.earliestMs = Math.max(this.session.startedAt, Number(timeline.earliestMs));
          this.observeLiveEdge(timeline.liveEdgeMs);
          if (this.tailEdgeMs !== this.liveEdgeMs || !this.tailRecords.length) {
            const edge = this.liveEdgeMs;
            this.tailRecords = await this.storage.listSegments(this.session.id, edge - 60000, edge + 1);
            const tail = BLB.contiguousTailStart(this.tailRecords);
            // 查询窗口起点不一定是缓存缺口。
            const knownGap = tail != null && tail > this.tailRecords[0]?.startMs;
            this.tailStartMs = Math.max(this.earliestMs, this.tailStartMs || 0, knownGap ? tail : 0);
            this.tailEdgeMs = edge;
          }
        } else {
          this.earliestMs = this.liveEdgeMs;
        }
        this.emit('timeline', {});
        return timeline;
      })();
      this.timelinePromise = work;
      try { return await work; }
      finally { if (this.timelinePromise === work) this.timelinePromise = null; }
    }

    maybeStart() {
      if (this.destroyed || this.active || this.startPromise || !this.root || !this.segmentCount
        || Date.now() < this.nextStartAt) return;
      // 原生预览不参与统一时间轴。
      if (this.liveEdgeMs - this.earliestMs < Math.max(1500, this.targetLiveBuffer() * 1000 + 500)) return;
      this.startPromise = this.goLive({ startup: true }).catch((error) => {
        this.nextStartAt = Date.now() + 10000;
        this.emit('status', { state: 'warning', text: '统一播放器准备失败：' + error.message });
      }).finally(() => { this.startPromise = null; });
    }

    mapRecords(records) { return BLB.mapTimeline(records); }

    setWindowRecords(records, append = false) {
      const mapped = BLB.mapTimeline(records, append ? this.windowSegments : []);
      if (append && mapped.length === this.windowSegments.length) return;
      this.windowSegments = mapped;
      if (!this.windowSegments.length) throw new Error('缓存窗口为空');
      this.windowStartMs = this.windowSegments[0].startMs;
      const last = this.windowSegments[this.windowSegments.length - 1];
      this.windowEndMs = last.startMs + last.durationMs;
      this.mediaManifest = buildPlaylist(this.instanceId, this.windowSegments);
    }

    findRecord(records, wallMs) { return BLB.recordAtWall(records, wallMs); }
    wallToMediaSeconds(wallMs) { return BLB.wallToMedia(this.windowSegments, wallMs); }
    mediaToWallMs(seconds) { return BLB.mediaToWall(this.windowSegments, seconds); }

    requestQualitySwitch({ quality, sourceGeneration }) {
      this.pendingQuality = null;
      if (!this.active || !this.followsLive() || this.userPaused || this.scrubHeld) return;
      this.pendingQuality = { quality, sourceGeneration, startedAt: Date.now() };
      this.recordEvent('quality-request', { quality, sourceGeneration });
      this.maybeSwitchQuality();
    }

    maybeSwitchQuality() {
      const pending = this.pendingQuality;
      if (!pending || this.destroyed) return;
      if (!this.followsLive() || this.userPaused || this.scrubHeld) { this.pendingQuality = null; return; }
      if (Date.now() - pending.startedAt > 30000) {
        this.pendingQuality = null;
        this.emit('status', { state: 'warning', text: '所选画质尚未就绪，当前画面未切换' });
        return;
      }
      if (this.loading || this.pendingSeekWallMs) return;
      const matches = (record) => record && record.sourceGeneration >= pending.sourceGeneration
        && (pending.quality === 'auto' || Number(record.quality) === Number(pending.quality));
      if (matches(this.findRecord(this.windowSegments, this.currentWallMs()))) {
        this.pendingQuality = null;
        return;
      }
      const records = this.tailRecords || [];
      const last = records[records.length - 1];
      if (!matches(last) || !this.liveDataAvailable()) return;
      let index = records.length - 1;
      while (index > 0 && matches(records[index - 1]) && records[index - 1].groupId === last.groupId
        && records[index].startMs - records[index - 1].startMs - records[index - 1].durationMs <= 50) index--;
      const first = records.slice(index).find((record) => record.independent);
      const margin = Math.max(0.5, this.playbackTargetBuffer()) * 1000;
      const target = last.startMs + last.durationMs - margin;
      if (!first || target < Math.max(this.earliestMs, first.startMs + 50)) return;
      this.pendingQuality = null;
      this.recordEvent('quality-switch', { quality: last.quality, target: target - this.session.startedAt });
      return this.seek(target, { mode: this.mode, forceReload: true, boundaryFallback: true })
        .catch((error) => { if (!this.destroyed) this.emit('status', { state: 'warning', text: error.message }); });
    }

    playbackInfo() {
      const video = this.active ? this.video : this.nativeVideo;
      const records = this.windowSegments || [];
      const record = this.active ? this.findRecord(records, this.currentWallMs()) : null;
      let bytes = 0, duration = 0;
      if (record) {
        for (let i = records.indexOf(record); i >= 0 && duration < 5000; i--) {
          const item = records[i];
          if (item.groupId !== record.groupId || item.quality !== record.quality) break;
          if (item.byteLength > 0 && item.durationMs > 0) { bytes += item.byteLength; duration += item.durationMs; }
        }
      }
      return { quality: record?.quality ?? null, qualityLabel: record?.qualityLabel || '',
        width: video?.videoWidth || 0, height: video?.videoHeight || 0,
        bitrate: duration ? bytes * 8000 / duration : null,
        codecs: /codecs\s*=\s*"([^"]+)"/i.exec(record?.mime || '')?.[1] || '',
        switching: Boolean(this.pendingQuality || this.loading || this.pendingSeekWallMs) };
    }

    findKeyframeStart(records, index) {
      const target = records[index];
      while (index > 0 && !records[index].independent) {
        const previous = records[index - 1];
        if (previous.groupId !== target.groupId || target.startMs - previous.startMs > KEYFRAME_LOOKBACK_MS) break;
        index -= 1;
      }
      return index;
    }

    async prepareWindow(targetMs, generation) {
      const records = await this.storage.listSegments(
        this.session.id, targetMs - KEYFRAME_LOOKBACK_MS, this.liveEdgeMs + 1
      );
      this.checkGeneration(generation);
      const record = this.findRecord(records, targetMs);
      if (!record) throw new Error('该时刻没有完整缓存（断流、画质切换或缓存已淘汰）');
      const index = this.findKeyframeStart(records, records.indexOf(record));
      this.setWindowRecords(records.slice(index));
      this.snapshotVersion += 1;
      this.masterUri = 'bililivebar://' + this.instanceId + '/master.m3u8?v=' + this.snapshotVersion;
      this.mediaUri = 'bililivebar://' + this.instanceId + '/media.m3u8?v=' + this.snapshotVersion;
      this.masterManifest = [
        '#EXTM3U', '#EXT-X-VERSION:7',
        '#EXT-X-STREAM-INF:BANDWIDTH=10000000,CODECS="' + codecList(records[index].mime) + '"',
        this.mediaUri, ''
      ].join('\n');
      return this.wallToMediaSeconds(targetMs);
    }

    async refreshWindowManifest() {
      if (this.manifestRefreshPromise) return this.manifestRefreshPromise;
      const version = this.snapshotVersion;
      const work = (async () => {
        await this.refreshSegments();
        const last = this.windowSegments[this.windowSegments.length - 1];
        if (!last || version !== this.snapshotVersion) return;
        const records = await this.storage.listSegments(this.session.id, last.startMs, this.liveEdgeMs + 1);
        if (version === this.snapshotVersion && records.length) this.setWindowRecords(records, true);
      })();
      this.manifestRefreshPromise = work;
      try { await work; }
      finally { if (this.manifestRefreshPromise === work) this.manifestRefreshPromise = null; }
    }

    async getVirtualResource(uri) {
      if (uri.pathname.includes('/segment.')) {
        const started = performance.now();
        const result = await this.storage.getSegment(uri.searchParams.get('id'));
        if (result.meta.kind === 'media') {
          this.handoff.readAt = Date.now();
          this.handoff.readMs = performance.now() - started;
          this.handoff.commitToReadMs = result.meta.committedAt ? Date.now() - result.meta.committedAt : null;
        }
        return { buffer: result.buffer, contentType: result.meta.mime || 'video/mp4' };
      }
      if (Number(uri.searchParams.get('v')) !== this.snapshotVersion) throw new Error('播放窗口已更新');
      if (uri.pathname.endsWith('/media.m3u8')) await this.refreshWindowManifest();
      if (Number(uri.searchParams.get('v')) !== this.snapshotVersion) throw new Error('播放窗口已更新');
      if (uri.pathname.endsWith('/media.m3u8')) this.handoff.manifestAt = Date.now();
      return {
        buffer: asBuffer(uri.pathname.endsWith('/master.m3u8') ? this.masterManifest : this.mediaManifest),
        contentType: 'application/vnd.apple.mpegurl'
      };
    }

    checkGeneration(generation) {
      if (this.destroyed || generation !== this.generation) {
        const error = new Error('定位已被后续操作替代');
        error.name = 'AbortError';
        throw error;
      }
    }

    freeze() {
      if (!this.active || this.video.readyState < 2) return;
      try {
        this.freezeFrame.width = this.video.videoWidth;
        this.freezeFrame.height = this.video.videoHeight;
        this.freezeFrame.getContext('2d').drawImage(this.video, 0, 0);
        this.freezeFrame.style.display = 'block';
      } catch (_) { /* A frame may be unavailable during decoder recovery. */ }
    }

    replayBufferAhead(time = this.video.currentTime) {
      for (let index = 0; index < this.video.buffered.length; index += 1) {
        if (time >= this.video.buffered.start(index) - 0.02 && time < this.video.buffered.end(index)) {
          return this.video.buffered.end(index) - time;
        }
      }
      return 0;
    }

    bridgeSmallBufferGap() {
      if (this.userPaused || this.scrubHeld || this.loading || this.pendingSeekWallMs || this.video.seeking) return false;
      const ranges = this.video.buffered;
      const time = this.video.currentTime;
      for (let index = 1; index < ranges.length; index += 1) {
        const end = ranges.end(index - 1), next = ranges.start(index);
        if (next - end > 0.1 || time < end - 0.025 || time >= next || next - time > 0.125) continue;
        try {
          this.video.currentTime = next;
          this.playbackHealth?.reset(Date.now(), next);
          this.lastProgressAt = Date.now();
          this.lastVideoTime = next;
          this.recordEvent('bridge-media-gap', { from: time, to: next, gapSeconds: next - end });
          return true;
        } catch (_) { return false; }
      }
      return false;
    }

    frameObservationVisible() {
      const owner = this.video.ownerDocument || document;
      if (document.hidden || owner.hidden) return false;
      if (!this.presentedFrame || Date.now() - this.presentedFrame.observedAt < 1000) return true;
      // 离屏视频可能没有呈现回调，但音频和媒体时钟仍正常。
      const rect = this.video.getBoundingClientRect?.();
      const view = owner.defaultView || global;
      if (rect && (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
        || rect.top >= (view.innerHeight || Infinity) || rect.left >= (view.innerWidth || Infinity))) return false;
      return this.video.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false;
    }

    seekRange() {
      const range = this.player?.seekRange();
      return range || { start: 0, end: 0 };
    }

    async positionPrecisely(targetMs, generation, { boundaryFallback = false } = {}) {
      let desired = this.wallToMediaSeconds(targetMs);
      const requestedMs = targetMs;
      const failure = (message, reason) => {
        const error = new Error(message);
        error.name = 'SeekPositionError';
        error.reason = reason;
        this.lastSeekFailure = {
          targetMs: targetMs - this.session.startedAt, desiredMediaTime: desired,
          buffered: Array.from({ length: this.video.buffered.length }, (_, i) => [this.video.buffered.start(i), this.video.buffered.end(i)]),
          seekRange: this.seekRange(), reason
        };
        return error;
      };
      if (desired == null) throw failure('该时刻位于缓存缺口，未跳转到 LIVE', 'cache-gap');
      const deadline = Date.now() + 8000;
      let lastAdjustmentAt = Date.now();
      let adjustments = 0;
      let assigned = false;
      let corrections = 0;
      while (Date.now() < deadline) {
        this.checkGeneration(generation);
        this.video.pause();
        const range = this.seekRange();
        if (boundaryFallback && !this.userPaused && !this.scrubHeld && adjustments < 2
          && Date.now() - lastAdjustmentAt >= 320) {
          const ranges = Array.from({ length: this.video.buffered.length }, (_, i) => [this.video.buffered.start(i), this.video.buffered.end(i)]);
          const landing = BLB.nearestBufferedLanding(this.windowSegments, targetMs, ranges, range,
            Math.max(0, 2000 - (targetMs - requestedMs)));
          if (landing) {
            this.recordEvent('seek-boundary-adjusted', {
              from: targetMs - this.session.startedAt, to: landing.wallMs - this.session.startedAt,
              fromMedia: desired, toMedia: landing.mediaTime, reason: 'mse-range'
            });
            targetMs = landing.wallMs;
            desired = landing.mediaTime;
            this.pendingSeekWallMs = targetMs;
            if (this.recoveryPlan) this.recoveryPlan.lastTargetMs = targetMs;
            assigned = false;
            corrections = 0;
            adjustments++;
            lastAdjustmentAt = Date.now();
          }
        }
        if (!assigned && desired >= range.start - 0.01 && desired <= range.end) {
          this.video.currentTime = desired; // Never fastSeek(), never clamp to the live edge.
          assigned = true;
        }
        const errorSeconds = Math.abs(this.video.currentTime - desired);
        const requiredAhead = Math.min(0.25, Math.max(0.05, (this.windowEndMs - targetMs) / 2000));
        const ready = this.userPaused ? this.video.readyState >= 2
          : this.video.readyState >= 3 && this.replayBufferAhead() >= requiredAhead;
        if (assigned && !this.video.seeking && ready) {
          if (errorSeconds <= 0.06) {
            this.recordEvent('seek-landed', {
              target: targetMs - this.session.startedAt,
              actual: this.mediaToWallMs(this.video.currentTime) - this.session.startedAt,
              errorMs: Math.round(errorSeconds * 1000)
            });
            return targetMs;
          }
          if (++corrections > 2 && (!boundaryFallback || Date.now() - lastAdjustmentAt >= 320)) {
            throw failure('播放器未停在目标帧；请重新定位或复制诊断报告', 'position-drift');
          }
          assigned = false;
        }
        await new Promise((resolve) => global.setTimeout(resolve, 80));
      }
      throw failure('目标片段不可播或定位超时；未跳转到最新直播', 'target-unplayable');
    }

    async loadWindow(targetMs, generation) {
      const player = await this.ensurePlayer();
      this.checkGeneration(generation);
      this.playerLoaded = false;
      await player.unload();
      this.checkGeneration(generation);
      const initialTime = await this.prepareWindow(targetMs, generation);
      this.loadingMedia = true;
      try {
        await BLB.withDeadline(player.load(this.masterUri, initialTime, CACHE_MANIFEST_MIME),
          12000, () => player.unload());
      } finally { this.loadingMedia = false; }
      this.checkGeneration(generation);
      // EVENT/sequence 原点固定为 0，seekRange.start 仅表示可用范围。
      this.playerLoaded = true;
      if (this.cacheRefreshDirty) this.scheduleCacheRefresh();
    }

    async playCurrent() {
      if (this.destroyed || this.userPaused || this.scrubHeld || this.pendingSeekWallMs || this.loading) return;
      const request = ++this.playRequest;
      const generation = this.generation;
      try {
        await this.video.play();
        // 异步 play 等待期间，以用户暂停为准。
        if (this.loading || this.pendingSeekWallMs) this.video.pause();
        else if (this.userPaused || this.scrubHeld) this.enforcePause();
      }
      catch (error) {
        if (request !== this.playRequest || generation !== this.generation || this.destroyed || error.name === 'AbortError') return;
        const wallMs = this.currentWallMs();
        if (error.name !== 'NotAllowedError') {
          this.lastConfirmedWallMs = wallMs;
          this.failedWallMs = wallMs;
          this.recoveryPending = true;
          this.markBuffering();
          this.emit('status', { state: 'buffering', text: '播放暂不可用，等待重试' });
          return;
        }
        this.userPaused = true;
        this.pausedWallMs = wallMs;
        this.pausePoint = { wallMs, mediaTime: this.video.currentTime, revision: this.snapshotVersion };
        this.freeze();
        this.mode = 'history';
        this.emit('pause', { paused: true });
        this.emit('status', { state: 'warning', text: '浏览器阻止自动播放，请点击“播放”' });
      }
    }

    seek(targetMs, options = {}) {
      if (this.destroyed) return Promise.reject(new Error('播放器已关闭'));
      if (!this.active && !options.startup) return Promise.reject(new Error('统一播放器尚未就绪'));
      let requested = Number(targetMs);
      if (!Number.isFinite(requested)) return Promise.reject(new Error('无效的播放时刻'));
      this.liveRecoveryPending = false;
      const originalWallMs = this.pendingSeekWallMs || this.loading
        ? this.lastConfirmedWallMs : this.currentWallMs();
      const livePoint = this.liveTarget();
      const generation = ++this.generation;
      if (this.loadingMedia) this.player?.unload().catch(() => {});
      this.automaticSeek = Boolean(options.recovery);
      if (options.recovery) this.recoveryGeneration = generation;
      if (!options.recovery) {
        this.pendingQuality = null;
        this.recoveryPending = false;
        this.recoveryAttempts = 0;
        this.recoveryPlan = null;
      }
      this.lastConfirmedWallMs = originalWallMs;
      if (!this.pendingSeekWallMs && !this.loading && !this.failedWallMs) this.freeze();
      this.video.pause();
      this.emit('motion', { paused: true, rate: this.rate });
      this.pendingSeekWallMs = requested;
      this.mode = options.mode || 'history';
      this.configurePlaybackBuffer();
      if (!options.recovery) this.rate = 1;
      this.catchupToLive = Boolean(options.recovery) && this.mode === 'history' && this.rate > 1 && requested < livePoint;
      if (this.followsLive()) this.rate = 1;
      this.applyPlaybackRate(this.rate);
      this.emit('mode', { live: false, mode: this.mode });
      this.emit('status', { state: 'seeking', text: options.recovery ? '正在恢复播放…' : '正在定位缓存画面…' });
      this.recordEvent('seek-request', {
        from: originalWallMs - this.session.startedAt,
        target: requested - this.session.startedAt, mode: this.mode
      });
      const operation = this.operations.catch(() => {}).then(async () => {
        this.checkGeneration(generation);
        this.loading += 1;
        try {
          await this.refreshSegments();
          this.checkGeneration(generation);
          if (!this.segmentCount) throw new Error('还没有完整的缓存片段');
          if (options.startup) {
            requested = this.liveTarget(true);
            this.pendingSeekWallMs = requested;
          }
          if (requested < this.earliestMs || requested >= this.liveEdgeMs) {
            throw new Error('目标超出已缓存范围；未改变播放位置');
          }
          await this.refreshWindowManifest();
          this.checkGeneration(generation);
          if (options.forceReload || !this.playerLoaded || !this.findRecord(this.windowSegments, requested)) {
            await this.loadWindow(requested, generation);
          }
          if (options.startup) {
            // 初次加载后只更新一次起播目标，不持续追逐变化的末端。
            await this.refreshWindowManifest();
            this.checkGeneration(generation);
            requested = this.liveTarget(true);
            this.pendingSeekWallMs = requested;
            this.recordEvent('startup-target', { target: requested - this.session.startedAt });
          }
          const landed = await this.positionPrecisely(requested, generation, {
            boundaryFallback: Boolean(options.recovery || options.boundaryFallback || options.startup)
          });
          if (Number.isFinite(landed)) requested = landed;
          this.checkGeneration(generation);
          if (!this.active) {
            const audio = this.initialAudioState();
            this.video.volume = audio.volume;
            this.video.muted = audio.muted;
            this.active = true;
            this.layer.classList.add('is-active');
            this.layer.style.setProperty('display', 'block', 'important');
            this.emit('managed', { active: true });
          }
          this.maskNativeVideos();
          this.pendingSeekWallMs = 0;
          this.failedWallMs = 0;
          this.pauseExpired = false;
          this.recoveryPending = false;
          this.recoveryAttempts = 0;
          this.automaticSeek = false;
          this.lastConfirmedWallMs = this.mediaToWallMs(this.video.currentTime);
          if (options.recovery && this.recoveryPlan) {
            this.recoveryPlan.lastTargetMs = this.lastConfirmedWallMs;
            this.recoveryPlan.landedMedia = this.video.currentTime;
            this.recoveryPlan.landedRevision = this.snapshotVersion;
            this.recoveryPlan.landedFrameAt = this.presentedFrame?.observedAt ?? null;
            this.recoveryPlan.advance = true; // If it stalls again before progressing, use the next keyframe.
          }
          this.pausedWallMs = this.userPaused ? this.lastConfirmedWallMs : 0;
          this.freezeFrame.style.display = 'none';
          this.pausePoint = this.userPaused ? {
            wallMs: this.lastConfirmedWallMs, mediaTime: this.video.currentTime, revision: this.snapshotVersion
          } : null;
          if (this.userPaused) this.freeze();
          this.applyPlaybackRate(this.rate);
          this.lastVideoTime = this.video.currentTime;
          this.lastProgressAt = Date.now();
          this.clearBuffering();
          this.playbackHealth?.reset(Date.now(), this.video.currentTime);
          this.emit('seek', { wallMs: this.lastConfirmedWallMs });
          this.emit('mode', { live: this.followsLive(), mode: this.mode });
          this.emit('rate', { rate: this.rate });
          this.emit('status', { state: 'recording', text: this.userPaused ? '已暂停，缓存继续' : '正在缓存' });
        } catch (error) {
          if (generation === this.generation) {
            this.pendingSeekWallMs = 0;
            this.failedWallMs = originalWallMs;
            if (options.recovery && !this.userPaused) {
              if (this.recoveryPlan) {
                this.recoveryPlan.advance = error.name === 'SeekPositionError';
                this.recoveryPlan.lastError = { name: error.name, reason: error.reason || 'load-failed' };
              }
              this.recoveryPending = true;
              this.bufferingSince ||= Date.now();
              this.recoveryAttempts += 1;
              this.nextRecoveryAt = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(this.recoveryAttempts, 4));
              this.recoveryEdgeMs = this.liveEdgeMs;
              this.pausedWallMs = 0;
            } else {
              this.userPaused = this.active;
              this.pausedWallMs = originalWallMs;
              this.mode = 'history';
            }
            this.automaticSeek = false;
            this.video.pause();
            this.emit('pause', { paused: this.userPaused });
            this.emit('status', { state: 'warning', text: options.recovery && !this.userPaused
              ? '恢复暂未成功，等待可播数据后重试' : error.message });
            this.recordEvent('seek-failed', { name: error.name, reason: error.reason, target: requested - this.session.startedAt });
          }
          throw error;
        } finally {
          this.loading -= 1;
        }
        if (generation === this.generation) await this.playCurrent();
      });
      this.operations = operation;
      return operation.catch((error) => { if (error.name !== 'AbortError') throw error; });
    }

    async seekRelative(deltaSeconds) {
      if (!Number.isFinite(Number(deltaSeconds))) throw new Error('无效的定位秒数');
      // 相对快进仍是手动定位；只有拖到最右端才选择低延迟入口。
      const target = Math.max(this.earliestMs, Math.min(this.liveEdgeMs - 100,
        (this.pendingSeekWallMs || this.currentWallMs()) + Number(deltaSeconds) * 1000));
      await this.seek(target, { mode: 'history' });
    }

    async goLive({ startup = false } = {}) {
      if (!startup && !this.liveDataAvailable()) {
        this.emit('status', { state: 'buffering', text: '等待新的直播数据，可继续回看缓存' });
        return;
      }
      const target = this.liveTarget();
      const targetSeconds = this.targetLiveBuffer();
      this.recoveryAttempts = 0;
      this.userPaused = false;
      this.scrubHeld = false;
      this.pausedWallMs = 0;
      this.emit('pause', { paused: false });
      // LIVE 点击只定位一次，不属于自动恢复。
      await this.seek(target, { mode: 'live', startup, boundaryFallback: true });
      if (targetSeconds === this.targetLiveBuffer()) this.liveBufferTargetDirty = false;
    }

    liveTarget() {
      const start = Math.max(this.earliestMs, this.tailStartMs || this.earliestMs);
      const margin = Math.max(0.5, this.targetLiveBuffer()); // 0 is the saved low-delay preset.
      return Math.max(start, Math.min(this.liveEdgeMs - 100, this.liveEdgeMs - margin * 1000));
    }

    cancelAutomaticRecovery() {
      if (!this.automaticSeek && !(this.recoveryPromise && this.recoveryGeneration === this.generation)) return;
      this.generation += 1;
      if (this.automaticSeek) {
        this.pendingSeekWallMs = 0;
        this.failedWallMs = this.lastConfirmedWallMs;
      }
      this.automaticSeek = false;
      this.recoveryPending = false;
      if (this.loadingMedia) this.player?.unload().catch(() => {});
    }

    async seekEdge(edgeMs = this.liveEdgeMs) {
      // 低延迟只选点一次；暂停拖动仍保持暂停。
      const marginMs = this.userPaused ? 100 : 500;
      const start = this.userPaused ? this.earliestMs : Math.max(this.earliestMs, this.tailStartMs || this.earliestMs);
      const target = Math.max(start,
        Math.min(edgeMs, this.liveEdgeMs) - marginMs);
      await this.seek(target, { mode: this.userPaused ? 'history' : 'edge', boundaryFallback: !this.userPaused });
    }

    enforcePause() {
      if (this.destroyed || (!this.userPaused && !this.scrubHeld)) return;
      if (!this.video.paused) {
        this.video.pause();
        this.recordEvent('pause-play-blocked', { mediaTime: this.video.currentTime });
      }
      if (!this.userPaused || this.loading || this.pendingSeekWallMs || this.failedWallMs) return;
      const point = this.pausePoint;
      if (!point || point.revision !== this.snapshotVersion || !this.playerLoaded || this.video.seeking) return;
      if (Math.abs(this.video.currentTime - point.mediaTime) <= 0.02) return;
      // 续播时再从磁盘恢复被淘汰的帧，禁止循环抵消钳位或跳到 LIVE。
      if (this.replayBufferAhead(point.mediaTime) <= 0 || Date.now() - this.lastPauseCorrectionAt < 500) return;
      this.lastPauseCorrectionAt = Date.now();
      this.recordEvent('pause-position-restored', { from: this.video.currentTime, to: point.mediaTime });
      this.video.currentTime = point.mediaTime;
    }

    setPaused(paused) {
      if (!this.active) return;
      const next = Boolean(paused);
      if (next === this.userPaused) return;
      if (next) {
        this.pendingQuality = null;
        this.liveRecoveryPending = false;
        this.cancelAutomaticRecovery();
      }
      if (!next && !this.loading && !this.pendingSeekWallMs) {
        const point = this.pausePoint;
        const inMemory = point && this.playerLoaded && !this.failedWallMs
          && point.revision === this.snapshotVersion
          && Math.abs(this.video.currentTime - point.mediaTime) <= 0.02
          && this.replayBufferAhead(point.mediaTime) > 0;
        if ((!this.segmentCount || this.pausedWallMs < this.earliestMs) && !inMemory) {
          this.pauseExpired = true;
          this.emit('status', { state: 'warning', text: '暂停位置缓存已过期；请重新定位或点击 LIVE' });
          return;
        }
      }
      this.playRequest += 1;
      if (next) {
        const wallMs = this.currentWallMs();
        this.userPaused = true;
        this.video.pause();
        this.pausedWallMs = wallMs;
        this.pausePoint = this.loading || this.pendingSeekWallMs || this.failedWallMs ? null : {
          wallMs, mediaTime: this.video.currentTime, revision: this.snapshotVersion
        };
        if (!this.loading && !this.pendingSeekWallMs && !this.failedWallMs) this.freeze();
        this.mode = 'history'; // Repeated pauses accumulate; no automatic LIVE absorption.
        this.catchupToLive = false;
        this.rate = 1;
        this.applyPlaybackRate(1);
      }
      this.userPaused = next;
      this.configurePlaybackBuffer();
      this.recordEvent(next ? 'pause' : 'resume', {
        wall: (this.pausedWallMs || this.currentWallMs()) - this.session.startedAt,
        mediaTime: this.video.currentTime
      });
      this.emit('pause', { paused: next });
      this.emit('mode', { live: false, mode: this.mode });
      this.emit('rate', { rate: this.rate });
      if (!next) {
        this.lastProgressAt = Date.now();
        this.lastVideoTime = this.video.currentTime;
        this.playbackHealth?.reset(Date.now(), this.video.currentTime);
        this.clearBuffering();
        const target = this.pausedWallMs;
        const point = this.pausePoint;
        this.pausedWallMs = 0;
        this.pausePoint = null;
        // 定位期间的暂停/播放以最后意图为准，由当前操作完成定位。
        if ((this.loading || this.pendingSeekWallMs) && !this.failedWallMs) return;
        const moved = !point || point.revision !== this.snapshotVersion
          || Math.abs(this.video.currentTime - point.mediaTime) > 0.02;
        if (this.failedWallMs || !this.playerLoaded || moved) {
          this.failedWallMs = target; // Keep the held frame/time if disk restoration fails.
          this.seek(target, { mode: 'history' }).catch(() => {});
        } else {
          this.freezeFrame.style.display = 'none';
          this.playCurrent();
        }
      } else {
        this.enforcePause();
        this.emit('motion', { paused: true, rate: this.video.playbackRate });
      }
    }

    togglePause() { this.setPaused(!this.userPaused); }

    holdForScrub() {
      if (this.scrubHeld) return;
      this.pendingQuality = null;
      this.liveRecoveryPending = false;
      this.cancelAutomaticRecovery();
      this.lastConfirmedWallMs = this.currentWallMs();
      this.scrubHeld = true;
      this.video.pause();
      this.applyPlaybackRate(this.followsLive() ? 1 : this.rate);
      this.emit('motion', { paused: true, rate: this.video.playbackRate });
    }

    releaseScrub() {
      this.scrubHeld = false;
      this.lastProgressAt = Date.now();
      this.lastVideoTime = this.video.currentTime;
      this.playbackHealth?.reset(Date.now(), this.video.currentTime);
      if (this.failedWallMs && !this.userPaused) this.seek(this.failedWallMs, { mode: 'history' }).catch(() => {});
      else this.playCurrent();
    }

    setRate(rate) {
      const next = Number(rate);
      if (!Number.isFinite(next) || next < 0.5 || next > 3) return;
      this.pendingQuality = null;
      this.liveRecoveryPending = false;
      this.cancelAutomaticRecovery();
      this.recoveryPlan = null;
      const liveTarget = this.liveTarget();
      this.catchupToLive = next > 1 && this.currentWallMs() < liveTarget;
      this.rate = next;
      // 仅主动倍速具有追赶意图；1× 回看不自动切换 LIVE。
      this.mode = 'history';
      this.configurePlaybackBuffer();
      this.applyPlaybackRate(next);
      this.emit('rate', { rate: next });
      this.emit('mode', { live: false, mode: this.mode });
      if (this.failedWallMs && !this.userPaused && !this.scrubHeld) {
        this.seek(this.failedWallMs, { mode: 'history' }).catch(() => {});
      }
    }

    markBuffering() {
      if (this.userPaused || this.scrubHeld || this.loading || this.pendingSeekWallMs) return;
      if (this.active && this.playerLoaded && this.returnsLiveAfterStall()
        && (this.engineBuffering || this.video.readyState < 3 || this.video.error || this.recoveryPending
          || ['buffered-stall', 'waiting-data', 'rebuffering'].includes(this.healthState?.kind))) this.liveRecoveryPending = true;
      if (!this.bufferingSince && this.mode === 'live' && this.targetLiveBuffer() > 0
        && this.bufferPolicy.stalled(Date.now(), this.replayBufferAhead() < 1)) {
        this.configurePlaybackBuffer();
        this.recordEvent('buffer-adapted', { targetSeconds: this.targetLiveBuffer(), extraSeconds: this.bufferPolicy.extra });
      }
      if (!this.bufferingSince) this.bufferingSince = Date.now();
      this.emit('motion', { paused: true, rate: this.video.playbackRate });
    }

    clearBuffering() {
      if (this.engineBuffering) return;
      this.bufferingSince = 0;
      this.emit('motion', { paused: this.userPaused || this.scrubHeld, rate: this.video.playbackRate });
    }

    stopRecovery(reason) {
      if (this.recoveryPlan) this.recoveryPlan.blocked = reason;
      this.setPaused(true);
      this.recoveryPending = false;
      this.recordEvent('recovery-stopped', { reason, attempts: this.recoveryPlan?.attempts || 0 });
      this.emit('status', { state: 'warning', text: '此段暂不可播，已停止自动重试；请选择其他位置或点击 LIVE，缓存继续' });
    }

    recoverPlayback({ force = false, reason = 'stall' } = {}) {
      if (this.recoveryPromise || this.loading || this.pendingSeekWallMs || this.userPaused || this.scrubHeld) return;
      const wall = this.currentWallMs();
      const mode = this.mode;
      const following = this.followsLive();
      const mediaAtRequest = this.video.currentTime;
      const frameAtRequest = this.presentedFrame?.observedAt;
      const frameWasVisible = this.frameObservationVisible();
      if (!this.segmentCount) return;
      if (wall < this.earliestMs && !this.returnsLiveAfterStall()) {
        this.setPaused(true);
        this.pauseExpired = true;
        this.emit('status', { state: 'warning', text: '当前位置缓存已过期；请重新定位或点击 LIVE' });
        return;
      }
      const now = Date.now();
      if (!force && now < this.nextRecoveryAt) return;
      if (this.returnsLiveAfterStall() && this.recoveryLiveTarget() == null) return;
      if (force) this.recoveryPlan = null;
      const plan = this.recoveryPlan ||= { anchorMs: wall, attempts: 0, metadataFailures: 0, lastTargetMs: null, advance: false };
      if (plan.blocked) return;
      if (plan.attempts >= 3) { this.stopRecovery('attempt-limit'); return; }
      // 数据不足时等待，不因达不到恢复门槛而反复重建 MSE。
      if (!force && !this.recoveryPending && (this.tailStartMs || 0) <= wall
        && this.replayBufferAhead() < 0.5
        && (this.liveEdgeMs - wall) / 1000 <= this.playbackBufferGoal() + 0.25) return;
      if (force) this.recoveryAttempts = 0;
      this.lastRecoveryAt = now;
      const repeated = Math.abs(wall - (this.lastRecoveryWallMs ?? -Infinity)) < 250;
      this.samePositionRecoveries = repeated ? (this.samePositionRecoveries || 0) + 1 : 0;
      this.lastRecoveryWallMs = wall;
      this.nextRecoveryAt = now + Math.min(30000, 4000 * 2 ** Math.min(this.samePositionRecoveries, 3));
      const generation = this.generation;
      this.recoveryGeneration = generation;
      const work = (async () => {
        await this.refreshSegments();
        if (generation !== this.generation || this.userPaused || this.scrubHeld || this.destroyed) return;
        if (wall < this.earliestMs && !this.returnsLiveAfterStall()) {
          this.setPaused(true);
          this.pauseExpired = true;
          this.emit('status', { state: 'warning', text: '当前位置缓存已过期；请重新定位或点击 LIVE' });
          return;
        }
        let target = wall;
        if (target >= this.liveEdgeMs - 50) return;
        const liveTarget = this.returnsLiveAfterStall() ? this.recoveryLiveTarget() : null;
        if (this.returnsLiveAfterStall() && liveTarget == null) return;
        const returnToLive = liveTarget != null && liveTarget > wall + 50;
        if (returnToLive) target = liveTarget;
        else {
          const searchAfter = plan.advance ? Math.max(wall, plan.lastTargetMs || wall) : wall;
          const records = await this.storage.listSegments(this.session.id, searchAfter - 100, searchAfter + 60000);
          if (generation !== this.generation || this.userPaused || this.scrubHeld) return;
          if (!force && !this.failedWallMs && !this.engineBuffering && !this.video.error
            && this.video.readyState >= 3 && this.video.currentTime > mediaAtRequest + 0.05
            && (!frameWasVisible || frameAtRequest == null || this.presentedFrame?.observedAt > frameAtRequest)) {
            this.recoveryPending = false;
            this.recoveryPlan = null;
            this.clearBuffering();
            this.recordEvent('recovery-cancelled', { reason: 'playback-resumed' });
            return;
          }
          if (plan.advance || !this.findRecord(records, wall)) {
            const next = records.find((record) => record.startMs > searchAfter + (plan.advance ? 1 : -1) && record.independent);
            if (!next) {
              plan.waitSince ||= Date.now();
              if (Date.now() - plan.waitSince >= 15000) this.stopRecovery('no-next-keyframe');
              else this.emit('status', { state: 'buffering', text: '等待后续可解码片段，不重复定位失败位置' });
              return;
            }
            target = next.startMs; // An actual missing interval, never a LIVE fallback.
            this.recordEvent(plan.advance ? 'recovery-next-keyframe' : 'skip-cache-gap', {
              from: wall - this.session.startedAt, to: target - this.session.startedAt,
              previousTarget: plan.lastTargetMs == null ? null : plan.lastTargetMs - this.session.startedAt
            });
          }
        }
        plan.waitSince = 0;
        plan.attempts++;
        plan.lastTargetMs = target;
        plan.landedMedia = null;
        this.recoveryPending = true;
        this.recoveryEdgeMs = this.liveEdgeMs;
        this.recordEvent(following ? 'recover-live' : 'recover-same-position', {
          reason, policy: returnToLive ? 'return-live' : 'nearest-playable', attempt: plan.attempts,
          wall: wall - this.session.startedAt, target: target - this.session.startedAt
        });
        await this.seek(target, { mode, recovery: true, forceReload: reason !== 'resume-live' });
      })();
      this.recoveryPromise = work.catch((error) => {
        if (this.destroyed || this.userPaused || error.name === 'AbortError') return;
        // 元数据读取失败也需保留恢复意图。
        if (generation === this.generation) {
          if (++plan.metadataFailures >= 3) { this.stopRecovery('metadata-failure'); return; }
          this.recoveryPending = true;
          this.nextRecoveryAt = Date.now() + 4000;
        }
      }).finally(() => { this.recoveryPromise = null; });
      return this.recoveryPromise;
    }

    onTick() {
      if (this.destroyed) return;
      if (!this.active) { this.maybeStart(); return; }
      this.maskNativeVideos();
      this.enforcePause();
      if (this.pendingQuality && this.maybeSwitchQuality()) return;
      if (this.loading || this.pendingSeekWallMs) return;
      if (this.failedWallMs) {
        if (this.recoveryPending) this.recoverPlayback();
        return;
      }
      const current = this.currentWallMs();
      this.lastConfirmedWallMs = current;
      const liveTarget = this.liveTarget();
      if (!this.userPaused && !this.scrubHeld) {
        const now = Date.now();
        this.playbackHealth ||= new BLB.PlaybackHealth();
        const previousHealth = this.healthState?.kind;
        this.healthState = this.playbackHealth.sample({
          now, mediaTime: this.video.currentTime, aheadSeconds: this.replayBufferAhead(),
          frame: this.presentedFrame, revision: this.snapshotVersion,
          visible: this.frameObservationVisible(),
          seeking: this.video.seeking, engineBuffering: this.engineBuffering, rebufferGoal: this.playbackBufferGoal()
        });
        const stalled = ['buffered-stall', 'waiting-data', 'rebuffering'].includes(this.healthState.kind);
        if (stalled && previousHealth !== this.healthState.kind) {
          this.recordEvent('playback-stall', this.healthState);
        }
        if (this.liveRecoveryPending && !stalled && !this.engineBuffering && this.video.readyState >= 3
          && this.healthState.kind === 'playing' && this.video.currentTime > this.lastVideoTime + 0.005) {
          const target = this.returnsLiveAfterStall() ? this.recoveryLiveTarget() : null;
          if (!this.returnsLiveAfterStall() || (target != null && target - current <= 1000)) this.liveRecoveryPending = false;
          else if (target != null) {
            this.recoverPlayback({ reason: 'resume-live' });
            if (this.recoveryPromise) return;
          }
        }
        if (this.video.currentTime > this.lastVideoTime + 0.005) {
          this.lastProgressAt = Date.now();
          if (!stalled) {
            this.recoveryPending = false;
            const plan = this.recoveryPlan;
            const frameProgress = !this.frameObservationVisible() || plan?.landedFrameAt == null
              || (this.presentedFrame?.revision === this.snapshotVersion
                && this.presentedFrame.observedAt > plan.landedFrameAt);
            if (plan?.landedMedia != null && plan.landedRevision === this.snapshotVersion
              && frameProgress && this.video.currentTime - plan.landedMedia >= 0.5) this.recoveryPlan = null;
            this.clearBuffering();
          }
        }
        if (stalled) {
          if (this.bridgeSmallBufferGap()) return;
          this.markBuffering();
          this.emit('status', { state: 'buffering', text: this.healthState.kind === 'buffered-stall'
            ? '播放停滞，正在恢复' : this.returnsLiveAfterStall() ? '等待可播数据，准备返回 LIVE' : '等待可播数据，位置保持不变' });
          if (Date.now() - this.lastRetryStreamingAt >= 2500) {
            this.lastRetryStreamingAt = Date.now();
            try { this.player?.retryStreaming?.(0.1); } catch (_) { /* full recovery can follow */ }
            if (this.video.paused && !this.userPaused && !this.recoveryPending) this.playCurrent();
          }
          const retryAfter = this.healthState.kind === 'buffered-stall' ? 2000 : STALL_RELOAD_MS;
          if (this.healthState.stalledForMs > retryAfter) this.recoverPlayback({ reason: this.healthState.kind });
        } else if (previousHealth && previousHealth !== 'playing') {
          this.clearBuffering();
          this.recordEvent('playback-resumed', { aheadSeconds: this.replayBufferAhead() });
          this.emit('status', { state: 'recording', text: '播放已恢复' });
        }
        this.lastVideoTime = this.video.currentTime;
        if (this.catchupToLive && this.rate > 1 && this.liveDataAvailable() && current >= liveTarget && !this.video.seeking) {
          this.mode = 'live';
          this.configurePlaybackBuffer();
          this.catchupToLive = false;
          this.rate = 1;
          this.applyPlaybackRate(1);
          this.emit('rate', { rate: 1 });
          this.emit('mode', { live: true, mode: 'live' }); // NO seek or reload.
        }
        if (this.followsLive()) {
          this.applyLivePlaybackRate();
          if (this.bufferPolicy.healthy(Date.now(), !this.engineBuffering && !this.bufferingSince && this.replayBufferAhead() >= 2)) this.configurePlaybackBuffer();
          const excessiveLag = liveTarget - current > 15000
            && Date.now() - this.lastEdgeAt < 10000;
          if (excessiveLag) {
            this.laggingSince ||= Date.now();
          } else this.laggingSince = 0;
        } else this.applyPlaybackRate(this.rate);
      }
      this.emit('motion', {
        paused: this.userPaused || this.scrubHeld || this.video.paused || this.engineBuffering || Boolean(this.bufferingSince),
        rate: this.video.playbackRate
      });
      this.emit('time', { wallMs: current, liveMs: liveTarget, edgeMs: this.liveEdgeMs, rate: this.video.playbackRate });
    }

    diagnostics() {
      const ranges = (value) => Array.from({ length: value.length }, (_, index) => [value.start(index), value.end(index)]);
      const offset = (value) => Number.isFinite(value) ? Math.round(value - this.session.startedAt) : null;
      const current = this.currentWallMs();
      const record = this.findRecord(this.windowSegments, current);
      const frames = this.video.getVideoPlaybackQuality?.();
      let bufferedTracks = null;
      try {
        const info = this.player?.getBufferedInfo?.();
        if (info) bufferedTracks = { audio: info.audio.slice(-8), video: info.video.slice(-8) };
      } catch (_) { /* A report must still work during unload/recovery. */ }
      return {
        version: chrome.runtime.getManifest().version, capturedAt: new Date().toISOString(),
        playbackInfo: this.playbackInfo(), pendingQuality: this.pendingQuality ? { ...this.pendingQuality } : null,
        roomId: this.session.roomId, active: this.active, mode: this.mode,
        paused: this.userPaused, loading: this.loading, pendingMs: this.pendingSeekWallMs ? offset(this.pendingSeekWallMs) : null,
        pausePoint: this.pausePoint ? {
          wallMs: offset(this.pausePoint.wallMs), mediaTime: this.pausePoint.mediaTime, revision: this.pausePoint.revision
        } : null,
        currentMs: offset(current), liveMs: offset(this.liveTarget()), cachedEndMs: offset(this.liveEdgeMs),
        earliestMs: offset(this.earliestMs), liveBufferSeconds: this.liveBufferSeconds,
        bufferAheadSeconds: this.replayBufferAhead(), rebufferingGoal: this.playbackBufferGoal(),
        engineBuffering: this.engineBuffering,
        playbackHealth: this.healthState,
        rateControl: { policy: 'fixed-live-user-catchup', automaticMicroAdjust: false,
          strategy: this.rateStrategy(),
          bufferTargetPending: Boolean(this.liveBufferTargetDirty),
          defaultRate: this.video.defaultPlaybackRate,
          recentChanges: (this.rateEvents || []).filter((event) => Date.now() - event.at <= 60000) },
        audio: { ...this.audioState(), preservesPitch: this.video.preservesPitch, bufferedTracks },
        liveDataAvailable: this.liveDataAvailable(),
        liveLagSeconds: this.liveLagSeconds(),
        liveLagBasis: 'committed-cache-end',
        lowDelaySafetySeconds: 0.5,
        effectiveBufferSeconds: this.targetLiveBuffer(), adaptiveBuffer: this.bufferPolicy.adaptive,
        playbackTargetSeconds: this.playbackTargetBuffer(),
        handoff: { ...this.handoff, manifestBehindMs: Math.max(0, this.liveEdgeMs - this.windowEndMs),
          mseBehindMs: Math.max(0, this.liveEdgeMs - current - this.replayBufferAhead() * 1000) },
        adaptiveExtraSeconds: this.bufferPolicy.extra,
        pauseExpired: this.pauseExpired, presentedFrame: this.presentedFrame,
        recovery: { pending: this.recoveryPending, attempts: this.recoveryAttempts, nextAt: this.nextRecoveryAt,
          policy: this.returnsLiveAfterStall() ? 'return-live' : 'nearest-playable',
          stallRecovery: this.stallRecovery || 'resume', limit: 3, plan: this.recoveryPlan ? {
            anchorMs: offset(this.recoveryPlan.anchorMs), attempts: this.recoveryPlan.attempts,
            lastTargetMs: this.recoveryPlan.lastTargetMs == null ? null : offset(this.recoveryPlan.lastTargetMs),
            advance: this.recoveryPlan.advance, blocked: this.recoveryPlan.blocked || null,
            lastError: this.recoveryPlan.lastError || null
          } : null, lastSeekFailure: this.lastSeekFailure || null,
          samePositionRetries: this.samePositionRecoveries || 0, laggingSince: this.laggingSince,
          tailStartMs: offset(this.tailStartMs), lastEdgeAt: this.lastEdgeAt },
        frames: frames ? { total: frames.totalVideoFrames, dropped: frames.droppedVideoFrames } : null,
        video: {
          currentTime: this.video.currentTime, paused: this.video.paused, seeking: this.video.seeking,
          readyState: this.video.readyState, playbackRate: this.video.playbackRate,
          buffered: ranges(this.video.buffered), seekable: ranges(this.video.seekable),
          width: this.video.videoWidth, height: this.video.videoHeight, error: this.video.error?.code || null
        },
        window: { startMs: offset(this.windowStartMs), endMs: offset(this.windowEndMs), segments: this.windowSegments.length, revision: this.snapshotVersion },
        segment: record ? {
          ordinal: record.ordinal, group: record.groupNumber, startMs: offset(record.startMs),
          durationMs: record.durationMs, mediaStartSeconds: record.mediaStartSeconds,
          playStartSeconds: record.playStartSeconds, quality: record.quality, clockSource: record.clockSource
        } : null,
        events: this.events.slice() // No signed CDN URLs, cookies, tokens or danmaku text.
      };
    }

    destroy() {
      this.destroyed = true;
      if (this.frameCallback != null) this.video.cancelVideoFrameCallback?.(this.frameCallback);
      this.generation += 1;
      clearInterval(this.monitor);
      clearTimeout(this.cacheRefreshTimer);
      this.video.pause();
      this.restoreNativeVideos();
      this.nativeVideo?.play().catch(() => {});
      this.layerHost?.classList.remove('bililivebar-player-host');
      for (const host of this.hostPositionSnapshots.keys()) this.restoreHostPosition(host);
      this.operations.catch(() => {}).then(() => this.player?.destroy()).catch(() => {});
      instances.delete(this.instanceId);
      this.layer.remove();
    }
  }

  class DanmakuRenderer {
    constructor({ storage, session, replay, settings = {} }) {
      this.storage = storage;
      this.session = session;
      this.replay = replay;
      this.settings = settings;
      this.layer = replay.danmakuLayer;
      this.items = [];
      this.index = 0;
      this.loadedUntil = 0;
      this.lastWallMs = 0;
      this.loading = false;
      this.nextLoadAt = 0;
      this.renderedIds = new Map();
      this.activeNodes = new Set();
      this.placements = new Map();
      this.overlapSkipped = 0;
      this.recentCaptured = new Map();
      this.captureDirty = false;
      this.lastCaptureMergeAt = 0;
      this.lateRendered = 0;
      this.renderFloorMs = 0;
      this.lastLoadErrorAt = 0;
      this.dataGeneration = 0;
      this.resettingGeneration = 0;
      this.nativeStyle = this.manualStyle();
      this.lanes = Array(32).fill(0);
      this.layoutObserver = typeof global.ResizeObserver === 'function' ? new global.ResizeObserver((entries) => {
        const changed = entries.some(({ target }) => {
          const entry = this.placements.get(target);
          return entry && (Math.abs(target.offsetWidth - entry.geometry.width) > 1
            || Math.abs(target.offsetHeight - entry.geometry.height) > 1);
        });
        // 字体或图片加载后，旧轨道占位可能失效。
        if (changed) this.clearVisible();
      }) : null;
      this.timer = global.setInterval(() => this.tick(), 80);
      replay.addEventListener('seek', (event) => this.reset(event.detail.wallMs));
      replay.addEventListener('motion', (event) => {
        const rate = this.settings.danmakuSpeedSync !== false ? Number(event.detail.rate || 1) : 1;
        const paused = Boolean(event.detail.paused);
        if (this.lastMotion?.paused === paused && this.lastMotion?.rate === rate) return;
        this.lastMotion = { paused, rate };
        for (const animation of this.layer.getAnimations({ subtree: true })) {
          if (animation.playbackRate !== rate) animation.playbackRate = rate;
          if (paused) {
            if (animation.playState !== 'paused') animation.pause();
          } else if (animation.playState === 'paused') animation.play();
        }
      });
      replay.addEventListener('pause', (event) => {
        this.lastMotion = null;
        const paused = event.detail.paused || replay.scrubHeld || replay.loading || replay.pendingSeekWallMs || replay.engineBuffering || replay.bufferingSince;
        for (const animation of this.layer.getAnimations({ subtree: true })) {
          if (paused) animation.pause();
          else animation.play();
        }
      });
      replay.addEventListener('rate', (event) => {
        this.lastMotion = null;
        const rate = this.settings.danmakuSpeedSync !== false ? Number(event.detail.rate || 1) : 1;
        for (const animation of this.layer.getAnimations({ subtree: true })) animation.playbackRate = rate;
      });
      this.applySettings(settings);
      this.updateDiagnostics();
    }

    updateDiagnostics() {
      this.layer.dataset.enabled = String(this.nativeStyle?.enabled !== false);
      this.layer.dataset.items = String(this.items.length);
      this.layer.dataset.pending = String(Math.max(0, this.items.length - this.index));
      this.layer.dataset.active = String(this.activeNodes.size);
      this.layer.dataset.overlapSkipped = String(this.overlapSkipped);
      this.layer.dataset.avoidOverlap = String(this.nativeStyle?.avoidOverlap !== false);
      this.layer.dataset.loadedUntil = String(Math.round(this.loadedUntil || 0));
    }

    diagnostics() {
      const layer = this.layer.getBoundingClientRect();
      const boxes = Array.from(this.activeNodes, (node, id) => {
        const rect = node.getBoundingClientRect();
        const x = Math.max(0, rect.left - layer.left), y = Math.max(0, rect.top - layer.top);
        const right = Math.min(layer.width, rect.right - layer.left);
        const bottom = Math.min(layer.height, rect.bottom - layer.top);
        const placement = this.placements.get(node);
        return { id, x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y),
          mode: placement?.geometry.mode ?? null };
      }).filter((box) => box.width > 1 && box.height > 1);
      const overlaps = [];
      for (let i = 0; i < boxes.length && overlaps.length < 8; i++) {
        for (let j = i + 1; j < boxes.length && overlaps.length < 8; j++) {
          const a = boxes[i], b = boxes[j];
          if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1
            && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1) overlaps.push([a, b]);
        }
      }
      return { enabled: this.nativeStyle.enabled, avoidOverlap: this.nativeStyle.avoidOverlap,
        recentCaptured: this.recentCaptured.size, lateRendered: this.lateRendered,
        active: this.activeNodes.size, visible: boxes.length, overlapSkipped: this.overlapSkipped,
        layer: { width: layer.width, height: layer.height }, overlaps };
    }

    manualStyle() {
      const shadows = {
        0: '0 0 1px #000, 0 0 2px #000, 0 0 3px #000',
        1: '-1px -1px 1px #000, 1px -1px 1px #000, -1px 1px 1px #000, 1px 1px 1px #000',
        2: '2px 2px 2px #000, 0 0 1px #000'
      };
      const opacity = Number(this.settings.danmakuOpacity);
      const fontScale = Number(this.settings.danmakuFontScale);
      const emoteScale = Number(this.settings.danmakuEmoteScale);
      const speed = Number(this.settings.danmakuSpeed);
      const area = Number(this.settings.danmakuArea);
      const weight = Number(this.settings.danmakuFontWeight);
      const areaRatio = area === 0 ? 1 : Math.max(0.25, Math.min(1, Number.isFinite(area) ? area : 0.75));
      return {
        enabled: this.settings.danmakuEnabled !== false,
        opacity: Number.isFinite(opacity) ? Math.max(0.1, Math.min(1, opacity)) : 0.9,
        fontSizeScale: Number.isFinite(fontScale) ? Math.max(0.4, Math.min(1.6, fontScale)) : 1,
        emoteSizeScale: Number.isFinite(emoteScale) ? Math.max(0.4, Math.min(1.6, emoteScale)) : 1,
        fontFamily: DANMAKU_FONT_FAMILIES[this.settings.danmakuFontFamily]
          || DANMAKU_FONT_FAMILIES.sans,
        fontWeight: String(Number.isFinite(weight)
          ? Math.max(100, Math.min(900, Math.round(weight / 100) * 100))
          : 600),
        textShadow: shadows[Number(this.settings.danmakuFontBorder)] || shadows[1],
        speedPlus: Number.isFinite(speed) ? Math.max(0.4, Math.min(1.6, speed)) : 1,
        areaRatio: this.settings.danmakuPreventShade === true ? Math.min(0.85, areaRatio) : areaRatio,
        unlimited: area === 0,
        avoidOverlap: this.settings.danmakuAvoidOverlap !== false,
        screenSync: this.settings.danmakuScreenSync === true,
        speedSync: this.settings.danmakuSpeedSync !== false,
        blockScroll: this.settings.danmakuBlockScroll === true,
        blockTop: this.settings.danmakuBlockTop === true,
        blockBottom: this.settings.danmakuBlockBottom === true,
        blockColor: this.settings.danmakuBlockColor === true,
        blockEmoji: this.settings.danmakuBlockEmoji === true,
        blockLottery: this.settings.danmakuBlockLottery === true
      };
    }

    applySettings(settings = this.settings) {
      this.settings = settings;
      this.lastMotion = null;
      const previous = this.nativeStyle;
      this.nativeStyle = this.manualStyle();
      if (previous && JSON.stringify(previous) !== JSON.stringify(this.nativeStyle)) {
        // 样式变化清除旧轨道占位，不清除缓存或读取游标。
        this.clearVisible();
      }
      this.updateDiagnostics();
    }

    clearVisible() {
      for (const node of this.activeNodes) {
        this.layoutObserver?.unobserve(node);
        for (const animation of node.getAnimations()) animation.cancel();
        node.remove();
      }
      this.activeNodes.clear();
      this.placements.clear();
      this.lanes.fill(0);
    }

    reportLoadError(error) {
      if (Date.now() - this.lastLoadErrorAt < 5000) return;
      this.lastLoadErrorAt = Date.now();
      this.replay.emit('status', {
        state: 'warning',
        text: `历史弹幕读取失败，正在重试：${error?.message || error}`
      });
    }

    clear() {
      this.dataGeneration += 1;
      this.resettingGeneration = 0;
      this.clearVisible();
      this.layer.replaceChildren();
      this.items = [];
      this.index = 0;
      this.loadedUntil = 0;
      this.lastWallMs = 0;
      this.renderFloorMs = 0;
      this.recentCaptured.clear();
      this.captureDirty = false;
      this.lastCaptureMergeAt = 0;
      this.nextLoadAt = 0;
      this.renderedIds.clear();
      this.activeNodes.clear();
      this.placements.clear();
      this.lanes.fill(0);
      this.updateDiagnostics();
    }

    async reset(wallMs) {
      const generation = ++this.dataGeneration;
      this.resettingGeneration = generation;
      this.clearVisible();
      this.layer.replaceChildren();
      this.items = [];
      this.index = 0;
      this.loadedUntil = 0;
      this.nextLoadAt = 0;
      this.renderedIds.clear();
      this.activeNodes.clear();
      this.placements.clear();
      this.lanes.fill(0);
      this.lastWallMs = wallMs - 150;
      this.renderFloorMs = wallMs - 150;
      try {
        // 短窗口预取，避免高密度弹幕的跨 iframe 复制阻塞渲染。
        const toMs = Math.min(wallMs + DANMAKU_QUERY_AHEAD_MS, this.replay.liveEdgeMs + 500);
        const incoming = await this.storage.getDanmakuRange(this.session.id, wallMs - 150, toMs);
        if (generation !== this.dataGeneration) return;
        this.mergeItems(incoming, wallMs - 150, toMs);
        // LIVE 附近重叠查询 2 秒，以补齐迟到或尚未落盘的弹幕。
        const nearLiveEdge = toMs >= this.replay.liveEdgeMs - 2000;
        this.loadedUntil = Math.max(wallMs, toMs - (nearLiveEdge ? 2000 : 0));
        this.nextLoadAt = Date.now() + (nearLiveEdge ? 600 : 1500);
        this.updateDiagnostics();
      } catch (error) {
        if (generation === this.dataGeneration) {
          this.nextLoadAt = Date.now() + 1200;
          this.reportLoadError(error);
        }
      } finally {
        if (this.resettingGeneration === generation) this.resettingGeneration = 0;
      }
    }

    async load(fromMs, toMs) {
      if (this.loading) return;
      const generation = this.dataGeneration;
      this.loading = true;
      try {
        const incoming = await this.storage.getDanmakuRange(this.session.id, fromMs, toMs);
        if (generation !== this.dataGeneration) return;
        this.mergeItems(incoming, fromMs, toMs);
        const nearLiveEdge = toMs >= this.replay.liveEdgeMs - 2000;
        this.loadedUntil = Math.max(this.loadedUntil, toMs - (nearLiveEdge ? 2000 : 0));
        this.updateDiagnostics();
      } catch (error) {
        if (generation === this.dataGeneration) {
          this.nextLoadAt = Date.now() + 1200;
          this.reportLoadError(error);
        }
      } finally {
        this.loading = false;
      }
    }

    mergeItems(incoming, fromMs, toMs) {
      if (this.index) { this.items = this.items.slice(this.index); this.index = 0; }
      const existing = new Set(this.items.map((item) => item.id));
      const append = (item) => {
        if (item.timeMs < fromMs || item.timeMs > toMs || existing.has(item.id) || this.renderedIds.has(item.id)) return;
        existing.add(item.id);
        this.items.push(item);
      };
      this.pruneCaptured();
      for (const item of incoming) append(item);
      for (const { item } of this.recentCaptured.values()) append(item);
      this.items.sort((a, b) => a.timeMs - b.timeMs);
      this.captureDirty = false;
      this.lastCaptureMergeAt = Date.now();
    }

    pruneCaptured(now = Date.now()) {
      // 按接收顺序淘汰，不受服务端时钟偏差影响。
      for (const [id, entry] of this.recentCaptured) {
        if (entry.at >= now - 30000 && this.recentCaptured.size <= 5000) break;
        this.recentCaptured.delete(id);
      }
    }

    ingest(item) {
      // 短期暂存只衔接落盘；新弹幕仍按媒体时间调度。
      const now = Date.now();
      this.recentCaptured.delete(item.id);
      this.recentCaptured.set(item.id, { item, at: now });
      this.pruneCaptured(now);
      // 每 tick 批量排序，避免高密度消息逐条排序。
      this.captureDirty = true;
    }

    tick() {
      if (!this.replay.active) return;
      if (this.replay.loading || this.replay.pendingSeekWallMs || this.replay.failedWallMs) return;
      if (this.resettingGeneration) return;
      if (this.replay.userPaused || this.replay.scrubHeld) return;
      const wallMs = this.replay.currentWallMs();
      if (wallMs < this.lastWallMs || wallMs - this.lastWallMs > 2500) {
        this.reset(wallMs);
        return;
      }
      if (this.captureDirty || (this.recentCaptured.size && Date.now() - this.lastCaptureMergeAt >= 700)) {
        this.mergeItems([], Math.max(this.renderFloorMs, wallMs - DANMAKU_LATE_GRACE_MS), wallMs + DANMAKU_QUERY_AHEAD_MS);
      }
      if (wallMs > this.loadedUntil - DANMAKU_QUERY_LEAD_MS && Date.now() >= this.nextLoadAt) {
        const toMs = Math.min(wallMs + DANMAKU_QUERY_AHEAD_MS, this.replay.liveEdgeMs + 500);
        // 补查限制在迟到窗口内，不追溯磁盘故障前的旧游标。
        const fromMs = Math.max(this.renderFloorMs, wallMs - DANMAKU_LATE_GRACE_MS);
        const nearLiveEdge = toMs >= this.replay.liveEdgeMs - 2000;
        this.nextLoadAt = Date.now() + (nearLiveEdge ? 700 : 1600);
        this.load(fromMs, toMs);
      }
      let renderedThisTick = 0;
      while (this.index < this.items.length && this.items[this.index].timeMs <= wallMs + 80) {
        const item = this.items[this.index++];
        if (item.timeMs >= Math.max(this.renderFloorMs, wallMs - DANMAKU_LATE_GRACE_MS) && !this.renderedIds.has(item.id)) {
          this.renderedIds.set(item.id, item.timeMs);
          // 限制单帧创建的渲染节点数，不删减缓存弹幕。
          if (renderedThisTick < DANMAKU_MAX_RENDER_PER_TICK) {
            renderedThisTick += 1;
            if (item.timeMs < this.lastWallMs - 100) this.lateRendered += 1;
            this.render(item);
          }
        }
      }
      for (const [id, timeMs] of this.renderedIds) {
        if (timeMs < wallMs - DANMAKU_LATE_GRACE_MS) this.renderedIds.delete(id);
      }
      if (this.index > 1000) {
        this.items = this.items.slice(this.index);
        this.index = 0;
      }
      this.lastWallMs = wallMs;
      this.updateDiagnostics();
    }

    createEmoteNode(emote, label, fontPixels) {
      const image = document.createElement('img');
      const pixels = BLB.danmakuEmotePixels(fontPixels, Boolean(emote.large));
      image.className = 'bililivebar-danmaku-emote';
      image.classList.toggle('is-large', Boolean(emote.large));
      // 显式预留像素尺寸，避免站点样式或图片加载改变表情占位。
      Object.assign(image.style, {
        width: `${pixels.size}px`, height: `${pixels.size}px`,
        minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none',
        fontSize: `${fontPixels}px`, margin: `0 ${pixels.margin}px`,
        verticalAlign: `${pixels.baseline}px`, objectFit: 'contain'
      });
      for (const [property, value] of Object.entries({ width: `${pixels.size}px`, height: `${pixels.size}px`,
        'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none' })) {
        image.style.setProperty(property, value, 'important');
      }
      image.alt = label;
      image.src = String(emote.url).replace(/^http:\/\//i, 'https://');
      return image;
    }

    appendDanmakuContent(node, item, fontPixels) {
      const emotes = Array.isArray(item.emotes) ? item.emotes.filter((emote) => emote?.token && emote?.url) : [];
      if (!emotes.length) {
        node.textContent = item.text;
        return;
      }
      const byToken = new Map(emotes.map((emote) => [String(emote.token), emote]));
      const pattern = Array.from(byToken.keys())
        .sort((a, b) => b.length - a.length)
        .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const parts = pattern ? String(item.text || '').split(new RegExp(`(${pattern})`, 'g')) : [String(item.text || '')];
      let renderedEmote = false;
      for (const part of parts) {
        const emote = byToken.get(part);
        if (!emote) {
          if (part) node.append(document.createTextNode(part));
          continue;
        }
        node.append(this.createEmoteNode(emote, part, fontPixels));
        renderedEmote = true;
      }
      if (!renderedEmote) {
        node.textContent = '';
        for (const emote of emotes) {
          node.append(this.createEmoteNode(emote, emote.token, fontPixels));
        }
      }
    }

    trackNode(node, animation) {
      if (this.replay.userPaused || this.replay.scrubHeld || this.replay.engineBuffering || this.replay.bufferingSince) animation.pause();
      while (this.activeNodes.size >= DANMAKU_MAX_ACTIVE_NODES) {
        const oldest = this.activeNodes.values().next().value;
        if (!oldest) break;
        this.activeNodes.delete(oldest);
        this.layoutObserver?.unobserve(oldest);
        for (const running of oldest.getAnimations()) running.cancel();
        oldest.remove();
      }
      this.activeNodes.add(node);
      animation.onfinish = () => {
        this.layoutObserver?.unobserve(node);
        this.activeNodes.delete(node);
        this.placements.delete(node);
        node.remove();
      };
      animation.oncancel = () => {
        this.layoutObserver?.unobserve(node);
        this.activeNodes.delete(node);
        this.placements.delete(node);
      };
    }

    render(item) {
      if (!this.nativeStyle.enabled) return;
      if (item.mode === 4 && this.nativeStyle.blockBottom) return;
      if (item.mode === 5 && this.nativeStyle.blockTop) return;
      if (item.mode !== 4 && item.mode !== 5 && this.nativeStyle.blockScroll) return;
      if (Number(item.color || 0xffffff) !== 0xffffff && this.nativeStyle.blockColor) return;
      if (this.nativeStyle.blockEmoji && item.emotes?.some((emote) => emote?.url)) return;
      if (this.nativeStyle.blockLottery && item.lottery === true) return;
      const node = document.createElement('div');
      node.className = 'bililivebar-danmaku';
      node.style.position = 'absolute';
      node.style.left = '0';
      node.style.width = 'max-content';
      node.style.margin = '0';
      node.style.maxWidth = 'max-content';
      node.style.whiteSpace = 'nowrap';
      node.style.lineHeight = '1.25';
      node.style.willChange = 'transform';
      node.style.color = `#${Number(item.color || 0xffffff).toString(16).padStart(6, '0')}`;
      const fontSize = BLB.danmakuFontPixels(item, this.nativeStyle, this.layer.clientHeight);
      node.style.fontSize = `${fontSize}px`;
      const emoteFont = BLB.danmakuFontPixels({ fontSize: 25 },
        { ...this.nativeStyle, fontSizeScale: this.nativeStyle.emoteSizeScale }, this.layer.clientHeight);
      this.appendDanmakuContent(node, item, emoteFont);
      node.style.opacity = String(this.nativeStyle.opacity);
      node.style.fontFamily = this.nativeStyle.fontFamily;
      node.style.fontWeight = this.nativeStyle.fontWeight;
      node.style.textShadow = this.nativeStyle.textShadow;
      if (this.nativeStyle.avoidOverlap) {
        this.renderWithoutOverlap(node, item);
        return;
      }
      if (item.mode === 4 || item.mode === 5) {
        node.classList.add('is-fixed');
        node.style[item.mode === 4 ? 'bottom' : 'top'] = item.mode === 4 ? '12%' : '8%';
        node.style.left = '50%';
        const animation = node.animate([
          { opacity: this.nativeStyle.opacity, transform: 'translateX(-50%)' },
          { opacity: this.nativeStyle.opacity, transform: 'translateX(-50%)' }
        ], { duration: 4000 / this.nativeStyle.speedPlus });
        animation.playbackRate = this.nativeStyle.speedSync ? (this.replay.video.playbackRate || 1) : 1;
        this.layer.appendChild(node);
        this.trackNode(node, animation);
        return;
      }
      const laneHeight = Math.max(22, Math.ceil(fontSize * 1.3));
      const now = performance.now();
      const laneCount = Math.max(1, Math.floor(this.layer.clientHeight * this.nativeStyle.areaRatio / laneHeight));
      const usableLanes = Math.min(this.lanes.length, laneCount);
      let lane = this.nativeStyle.unlimited
        ? Math.floor(Math.random() * usableLanes)
        : this.lanes.slice(0, usableLanes).findIndex((freeAt) => freeAt <= now);
      if (lane < 0) lane = this.lanes.slice(0, usableLanes).indexOf(Math.min(...this.lanes.slice(0, usableLanes)));
      node.style.top = `${lane * laneHeight + 8}px`;
      this.layer.appendChild(node);
      const speedRate = this.nativeStyle.speedSync ? (this.replay.video.playbackRate || 1) : 1;
      const width = this.layer.clientWidth;
      const duration = BLB.danmakuScrollDuration(node.offsetWidth, width, this.nativeStyle, this.layer.clientHeight);
      const animation = node.animate([
        { transform: `translateX(${width}px)` },
        { transform: `translateX(-${node.offsetWidth + 20}px)` }
      ], { duration, easing: 'linear' });
      animation.playbackRate = speedRate;
      this.lanes[lane] = now + (duration / speedRate) * 0.45;
      this.trackNode(node, animation);
    }

    renderWithoutOverlap(node, item) {
      const screenWidth = this.layer.clientWidth;
      const areaHeight = this.layer.clientHeight * this.nativeStyle.areaRatio;
      const sizeKey = `${screenWidth}:${areaHeight}`;
      if (this.placementSize !== sizeKey) {
        this.clearVisible();
        this.placementSize = sizeKey;
      }
      this.layer.appendChild(node);
      const fixed = item.mode === 4 || item.mode === 5;
      const duration = fixed ? 4000 / this.nativeStyle.speedPlus
        : BLB.danmakuScrollDuration(node.offsetWidth, screenWidth, this.nativeStyle, this.layer.clientHeight);
      const geometry = { width: node.offsetWidth, height: node.offsetHeight, screenWidth, areaHeight, duration, mode: item.mode };
      const active = Array.from(this.placements.values(), (entry) => ({
        ...entry.geometry, elapsed: Number(entry.animation.currentTime || 0)
      }));
      const y = BLB.findDanmakuLane(geometry, active);
      if (y == null) {
        node.remove();
        this.overlapSkipped++;
        return;
      }
      node.style.top = `${y}px`;
      const start = fixed ? (screenWidth - geometry.width) / 2 : screenWidth;
      const end = fixed ? start : -geometry.width - 20;
      const animation = node.animate([
        { transform: `translateX(${start}px)` }, { transform: `translateX(${end}px)` }
      ], { duration, easing: 'linear' });
      animation.playbackRate = this.nativeStyle.speedSync ? this.replay.video.playbackRate || 1 : 1;
      this.placements.set(node, { geometry: { ...geometry, y }, animation });
      this.layoutObserver?.observe(node);
      this.trackNode(node, animation);
    }

    destroy() {
      clearInterval(this.timer);
      this.layoutObserver?.disconnect();
      this.clear();
    }
  }

  BLB.ReplayPlayer = ReplayPlayer;
  BLB.DanmakuRenderer = DanmakuRenderer;
})(globalThis);
