(function initDanmakuClient(global) {
  'use strict';
  const BLB = global.BiliLiveBar;
  const AUTH_TIMEOUT_MS = 8000;
  const AUTH_REJECT_COOLDOWN_MS = 30000;
  const PAGE_STREAM_STALE_MS = 75000;
  const PAGE_STREAM_FALLBACK_MS = 2500;

  function readCookie(name) {
    const prefix = `${name}=`;
    const item = document.cookie.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }

  class DanmakuClient extends EventTarget {
    constructor({ storage, session }) {
      super();
      this.storage = storage;
      this.session = session;
      this.socket = null;
      this.authInfo = null;
      this.heartbeatTimer = 0;
      this.reconnectTimer = 0;
      this.retry = 0;
      this.running = false;
      this.queue = [];
      this.queueBytes = 0;
      this.queuedSizes = new WeakMap();
      this.persistenceDropped = 0;
      this.flushFailureStreak = 0;
      this.nextFlushAt = 0;
      this.pendingPacketBytes = 0;
      this.flushTimer = 0;
      this.flushPromise = null;
      this.flushInFlight = 0;
      this.committed = 0;
      this.flushErrors = 0;
      this.lastFlushAt = 0;
      this.lastFlushDurationMs = 0;
      this.lastFlushError = null;
      this.seen = new Set();
      this.authFingerprint = '';
      this.authenticated = false;
      this.authTimeoutTimer = 0;
      this.unauthenticatedCloses = 0;
      this.rejectedAuth = new Map();
      this.lastPacketAt = 0;
      this.watchdogTimer = 0;
      this.authRequestTimer = 0;
      this.authFetchPromise = null;
      this.lastAuthFetchAt = 0;
      this.captured = 0;
      this.pageStreamActive = false;
      this.pageStreamLastAt = 0;
      this.pageStreamUsable = true;
      this.pagePacketChain = Promise.resolve();
      this.onBridgeMessage = this.onBridgeMessage.bind(this);
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    start() {
      if (this.running) return;
      this.running = true;
      global.addEventListener('message', this.onBridgeMessage);
      this.watchdogTimer = global.setInterval(() => {
        if (this.hasPageStream()) return;
        if (this.pageStreamActive) {
          this.pageStreamActive = false;
          this.emit('status', {
            state: 'reconnecting',
            text: '页面弹幕连接长时间无响应，正在启用备用连接…',
            source: 'fallback'
          });
          this.requestPageAuth();
          if (this.authInfo) this.connect();
          else this.requestAuthFallback();
        }
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        if (this.lastPacketAt && Date.now() - this.lastPacketAt <= 75000) return;
        this.emit('status', {
          state: 'reconnecting',
          text: '备用弹幕连接长时间无响应，正在重连…',
          source: 'independent'
        });
        this.closeSocket();
        this.scheduleReconnect(500);
      }, 15000);
      this.emit('status', { state: 'waiting', text: '等待页面弹幕连接…', source: 'waiting' });
      this.requestPageAuth();
      this.authRequestTimer = global.setInterval(() => {
        if (!this.hasPageStream() && (!this.authInfo || !this.socket)) {
          this.requestPageAuth();
          this.requestAuthFallback();
        }
      }, 3000);
      global.setTimeout(() => this.requestAuthFallback(), 1200);
    }

    hasPageStream(now = Date.now()) {
      return this.pageStreamActive
        && this.pageStreamLastAt > 0
        && now - this.pageStreamLastAt <= PAGE_STREAM_STALE_MS;
    }

    requestPageAuth() {
      global.postMessage({
        source: 'bililivebar-content',
        type: 'need-auth',
        roomId: this.session.roomId
      }, location.origin);
    }

    onBridgeMessage(event) {
      if (!this.running || event.origin !== location.origin) return;
      const message = event.data;
      if (!message || message.source !== 'bililivebar-main') return;
      if (message.type === 'danmaku-auth') {
        this.acceptAuth(message.payload);
      } else if (message.type === 'danmaku-page-state') {
        const lastPacketAt = Number(message.payload?.lastPacketAt || 0);
        if (this.pageStreamUsable
          && Number(message.payload?.readyState) === WebSocket.OPEN
          && Date.now() - lastPacketAt <= PAGE_STREAM_STALE_MS) {
          this.activatePageStream(lastPacketAt);
        }
      } else if (message.type === 'danmaku-packet'
        && this.pageStreamUsable
        && message.payload?.buffer instanceof ArrayBuffer) {
        this.activatePageStream(Date.now());
        const buffer = message.payload.buffer;
        if (this.pendingPacketBytes + buffer.byteLength > 16 * 1024 * 1024) {
          this.persistenceDropped += 1;
          return;
        }
        this.pendingPacketBytes += buffer.byteLength;
        this.pagePacketChain = this.pagePacketChain
          .then(() => this.handleMessage(buffer, null, 'page'))
          .catch(() => {}).finally(() => { this.pendingPacketBytes -= buffer.byteLength; });
      }
    }

    activatePageStream(lastPacketAt) {
      const firstPacket = !this.hasPageStream();
      this.pageStreamActive = true;
      this.pageStreamLastAt = Math.max(this.pageStreamLastAt, Number(lastPacketAt || Date.now()));
      this.retry = 0;
      this.unauthenticatedCloses = 0;
      clearTimeout(this.reconnectTimer);
      this.closeSocket();
      if (firstPacket) {
        this.emit('status', { state: 'connected', text: '弹幕已同步', source: 'page' });
      }
    }

    acceptAuth(payload) {
      if (String(payload?.auth?.roomid) !== String(this.session.roomId)) return;
      if (!payload?.url || !payload?.auth?.key) return;
      const urls = Array.from(new Set([payload.url, ...(Array.isArray(payload.urls) ? payload.urls : [])]
        .filter((url) => /^wss:\/\//i.test(String(url)))));
      if (!urls.length) return;
      const fingerprint = [urls.join(','), payload.auth.roomid, payload.auth.uid || 0, payload.auth.key].join('|');
      const rejectedAt = this.rejectedAuth.get(fingerprint) || 0;
      if (Date.now() - rejectedAt < AUTH_REJECT_COOLDOWN_MS && payload.source !== 'danmu-info-api') return;
      if (payload.source === 'danmu-info-api') this.rejectedAuth.delete(fingerprint);
      this.authInfo = Object.assign({}, payload, { url: urls[0], urls });
      if (fingerprint === this.authFingerprint
        && this.socket
        && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
      this.authFingerprint = fingerprint;
      if (this.hasPageStream()) return;
      // 重复鉴权不重建健康连接，避免切换期间丢弹幕。
      if (this.socket?.readyState === WebSocket.OPEN) return;
      // 等待页面首包后再决定是否启用备用连接，避免重复鉴权。
      this.scheduleReconnect(PAGE_STREAM_FALLBACK_MS);
    }

    async requestAuthFallback(force = false) {
      const cooldown = force ? 3000 : 10000;
      if (!this.running || this.hasPageStream() || (!force && this.authInfo) || this.authFetchPromise
        || Date.now() - this.lastAuthFetchAt < cooldown) return;
      this.lastAuthFetchAt = Date.now();
      const task = (async () => {
        const url = new URL('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo');
        url.searchParams.set('id', this.session.roomId);
        url.searchParams.set('type', '0');
        const navUrl = 'https://api.bilibili.com/x/web-interface/nav';
        const [response, navResponse] = await Promise.all([
          this.storage.fetchResource(url.href, 'text'),
          this.storage.fetchResource(navUrl, 'text').catch(() => null)
        ]);
        const result = JSON.parse(response.text);
        let uid = 0;
        try {
          const nav = JSON.parse(navResponse?.text || 'null');
          if (nav?.code === 0) uid = Number(nav.data?.mid || 0);
        } catch (_) { /* 游客鉴权不需要 uid */ }
        if (result.code !== 0 || !result.data?.token) throw new Error(result.message || '弹幕鉴权接口没有返回 token');
        const hosts = Array.isArray(result.data.host_list)
          ? result.data.host_list.filter((item) => item?.host)
          : [];
        const urls = hosts.map((item) => `wss://${item.host}${item.wss_port ? `:${item.wss_port}` : ''}/sub`);
        if (!urls.length) throw new Error('弹幕鉴权接口没有返回可用服务器');
        this.acceptAuth({
          url: urls[0],
          urls,
          auth: {
            // token 与 uid 必须来自同一鉴权上下文；游客统一使用 uid=0。
            uid,
            roomid: Number(this.session.roomId),
            protover: 2,
            buvid: readCookie('buvid3'),
            platform: 'web',
            type: 2,
            key: result.data.token
          },
          source: 'danmu-info-api'
        });
      })();
      this.authFetchPromise = task;
      try { await task; }
      catch (error) {
        if (this.running && !this.hasPageStream() && (!this.authInfo || force)) {
          this.emit('status', {
            state: 'warning',
            text: `备用弹幕鉴权失败，正在重试：${error.message}`,
            source: 'fallback'
          });
        }
      } finally {
        if (this.authFetchPromise === task) this.authFetchPromise = null;
      }
    }

    connect() {
      if (!this.running || !this.authInfo || this.hasPageStream()) return;
      if (this.socket
        && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
      clearTimeout(this.reconnectTimer);
      this.closeSocket();
      const authInfo = this.authInfo;
      const urls = authInfo.urls?.length ? authInfo.urls : [authInfo.url];
      const socketUrl = urls[this.retry % urls.length] || authInfo.url;
      let socket;
      try { socket = new WebSocket(socketUrl); }
      catch (error) {
        this.emit('status', {
          state: 'reconnecting',
          text: `备用弹幕连接建立失败：${error.message}`,
          source: 'independent'
        });
        this.scheduleReconnect();
        return;
      }
      this.socket = socket;
      this.authenticated = false;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.lastPacketAt = Date.now();
        const auth = Object.assign({}, authInfo.auth, { protover: 2, support_ack: false });
        socket.send(BLB.encodePacket(7, auth));
        this.emit('status', { state: 'authenticating', text: '备用弹幕鉴权中…', source: 'independent' });
        clearTimeout(this.authTimeoutTimer);
        this.authTimeoutTimer = global.setTimeout(() => {
          if (this.socket !== socket || this.authenticated) return;
          this.emit('status', {
            state: 'reconnecting',
            text: '备用弹幕鉴权超时，正在切换服务器…',
            source: 'independent'
          });
          socket.close();
        }, AUTH_TIMEOUT_MS);
      };
      socket.onmessage = (event) => {
        this.lastPacketAt = Date.now();
        this.handleMessage(event.data, socket, 'independent');
      };
      socket.onerror = () => {
        if (!this.hasPageStream()) {
          this.emit('status', {
            state: 'reconnecting',
            text: '备用弹幕连接异常，正在重连…',
            source: 'independent'
          });
        }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        const wasAuthenticated = this.authenticated;
        this.socket = null;
        this.authenticated = false;
        clearTimeout(this.authTimeoutTimer);
        clearInterval(this.heartbeatTimer);
        if (this.hasPageStream()) return;
        if (!wasAuthenticated) this.unauthenticatedCloses += 1;
        else this.unauthenticatedCloses = 0;
        if (this.unauthenticatedCloses >= Math.max(2, urls.length)) {
          this.rejectCurrentAuth();
          return;
        }
        this.scheduleReconnect();
      };
    }

    rejectCurrentAuth() {
      if (this.hasPageStream()) return;
      if (this.authFingerprint) this.rejectedAuth.set(this.authFingerprint, Date.now());
      this.authInfo = null;
      this.authFingerprint = '';
      this.unauthenticatedCloses = 0;
      this.requestPageAuth();
      this.requestAuthFallback(true);
    }

    markAuthenticated(socket) {
      if (this.socket !== socket || this.authenticated) return;
      this.authenticated = true;
      this.retry = 0;
      this.unauthenticatedCloses = 0;
      clearTimeout(this.authTimeoutTimer);
      clearInterval(this.heartbeatTimer);
      const heartbeat = () => {
        if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(BLB.encodePacket(2, '[object Object]'));
        }
      };
      heartbeat();
      this.heartbeatTimer = global.setInterval(heartbeat, 30000);
      this.emit('status', { state: 'connected', text: '弹幕已同步', source: 'independent' });
    }

    scheduleReconnect(delay) {
      if (!this.running) return;
      const wait = Number.isFinite(delay)
        ? delay
        : Math.min(30000, 1000 * (2 ** Math.min(this.retry++, 5)));
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = global.setTimeout(() => {
        if (!this.hasPageStream()) this.connect();
      }, wait);
    }

    async handleMessage(data, socket = this.socket, source = 'independent') {
      if (!this.running) return;
      try {
        const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
        if (source === 'independent' && this.socket !== socket) return;
        const receivedAt = Date.now();
        const authReply = source === 'independent'
          ? BLB.decodeControlPackets(buffer).find((packet) => packet.operation === 8)
          : null;
        if (authReply && source === 'independent') {
          if (Number(authReply.data?.code) === 0) this.markAuthenticated(socket);
          else {
            this.emit('status', {
              state: 'warning',
              text: `备用弹幕鉴权被拒绝（${authReply.data?.code ?? '未知状态'}），正在刷新凭据…`,
              source: 'independent'
            });
            this.closeSocket();
            this.rejectCurrentAuth();
            return;
          }
        }
        const commands = await BLB.decodePackets(buffer);
        if (!this.running) return;
        for (const command of commands) {
          const item = BLB.extractDanmaku(command, receivedAt);
          if (!item || !item.text || this.seen.has(item.id)) continue;
          this.seen.add(item.id);
          if (this.seen.size > 20000) this.seen.clear();
          this.enqueue(item);
          this.captured += 1;
          this.emit('danmaku', item);
        }
        if (commands.length) {
          this.emit('capture', { count: this.captured, queued: this.queue.length, source });
        }
        this.scheduleFlush();
      } catch (error) {
        if (source === 'page' && /Brotli/i.test(String(error?.message || error))) {
          this.pageStreamUsable = false;
          this.pageStreamActive = false;
          this.pageStreamLastAt = 0;
          this.emit('status', {
            state: 'reconnecting',
            text: '当前浏览器无法解析页面弹幕，正在启用备用连接…',
            source: 'fallback'
          });
          if (this.authInfo) this.connect();
          else this.requestAuthFallback(true);
          return;
        }
        this.emit('status', {
          state: 'warning',
          text: `${source === 'page' ? '页面' : '备用'}弹幕包解析失败：${error.message}`,
          source
        });
      }
    }

    enqueue(item) {
      const size = JSON.stringify(item).length * 2;
      // 内存限额包含正在提交的批次，防止磁盘故障导致无界积压。
      if (this.queue.length + this.flushInFlight >= 20000 || this.queueBytes + size > 8 * 1024 * 1024) {
        this.persistenceDropped += 1;
        if (!this.lastQueueWarningAt || Date.now() - this.lastQueueWarningAt > 10000) {
          this.lastQueueWarningAt = Date.now();
          this.emit('status', { state: 'warning', text: '弹幕写盘积压，部分新弹幕未保存；请检查缓存空间与权限' });
        }
        return false;
      }
      this.queuedSizes.set(item, size);
      this.queueBytes += size;
      this.queue.push(item);
      return true;
    }

    retryPersistence() {
      this.nextFlushAt = 0;
      this.flushFailureStreak = 0;
      this.flush();
    }

    scheduleFlush() {
      if (!this.queue.length || this.flushPromise) return;
      if (this.nextFlushAt > Date.now()) {
        if (!this.flushTimer) this.flushTimer = global.setTimeout(() => {
          this.flushTimer = 0;
          this.flush();
        }, this.nextFlushAt - Date.now());
        return;
      }
      if (this.queue.length >= 200) {
        clearTimeout(this.flushTimer);
        this.flushTimer = 0;
        this.flush();
        return;
      }
      if (!this.flushTimer) this.flushTimer = global.setTimeout(() => {
        this.flushTimer = 0;
        this.flush();
      }, 500);
    }

    async flush() {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
      if (this.flushPromise) return this.flushPromise;
      if (!this.queue.length) return;
      const task = (async () => {
        // 单队列有界批量提交，避免事务竞争和阻塞消息接收。
        for (let round = 0; round < 4 && this.queue.length; round += 1) {
          const batch = this.queue.splice(0, 500);
          const started = Date.now();
          this.flushInFlight = batch.length;
          try {
            const result = await this.storage.putDanmakuBatch(this.session.id, batch);
            this.committed += Number(result?.count || 0);
            this.lastFlushAt = Date.now();
            this.lastFlushDurationMs = this.lastFlushAt - started;
            this.lastFlushError = null;
            this.flushFailureStreak = 0;
            this.nextFlushAt = 0;
            for (const item of batch) {
              this.queueBytes = Math.max(0, this.queueBytes - (this.queuedSizes.get(item) || 0));
              this.queuedSizes.delete(item);
            }
          }
          catch (error) {
            this.queue.unshift(...batch);
            this.flushErrors += 1;
            this.flushFailureStreak += 1;
            this.nextFlushAt = Date.now() + Math.min(30000, 500 * 2 ** Math.min(6, this.flushFailureStreak - 1));
            this.lastFlushError = error.message;
            this.emit('status', { state: 'warning', text: `弹幕写盘失败：${error.message}` });
            break;
          } finally { this.flushInFlight = 0; }
        }
      })();
      this.flushPromise = task;
      try { await task; }
      finally {
        if (this.flushPromise === task) this.flushPromise = null;
        if (this.queue.length && this.running) {
          this.flushTimer = global.setTimeout(() => {
            this.flushTimer = 0;
            this.flush();
          }, Math.max(100, this.nextFlushAt - Date.now()));
        }
      }
    }

    diagnostics() {
      return { captured: this.captured, queued: this.queue.length, inFlight: this.flushInFlight,
        queuedBytes: this.queueBytes, dropped: this.persistenceDropped, retryAt: this.nextFlushAt,
        writing: Boolean(this.flushPromise), committed: this.committed, errors: this.flushErrors,
        lastCommitAt: this.lastFlushAt, lastCommitDurationMs: this.lastFlushDurationMs,
        lastError: this.lastFlushError };
    }

    closeSocket() {
      clearTimeout(this.authTimeoutTimer);
      clearInterval(this.heartbeatTimer);
      this.authenticated = false;
      if (this.socket) {
        this.socket.onclose = null;
        this.socket.close();
        this.socket = null;
      }
    }

    stop() {
      this.running = false;
      global.removeEventListener('message', this.onBridgeMessage);
      clearTimeout(this.reconnectTimer);
      clearInterval(this.watchdogTimer);
      clearInterval(this.authRequestTimer);
      clearTimeout(this.authTimeoutTimer);
      this.closeSocket();
      this.flush();
    }
  }

  BLB.DanmakuClient = DanmakuClient;
})(globalThis);
