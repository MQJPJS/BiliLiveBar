(function initSessionLifecycle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BiliLiveBar = Object.assign(root.BiliLiveBar || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function sessionLifecycleFactory() {
  'use strict';
  const SESSION_REGISTRY_KEY = 'cacheSessionRegistry';

  function roomKey(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'live.bilibili.com') return '';
      return url.pathname.match(/^\/(?:(?:blanc|h5)\/)?(\d+)(?:\/|$)/)?.[1]
        || ['room_id', 'roomid', 'cid'].map((key) => url.searchParams.get(key)).find((id) => /^\d+$/.test(id || '')) || '';
    } catch (_) { return ''; }
  }

  // 后台会话锁串行操作；先持久化清理意图，以支持中断后重试。
  class SessionLifecycle {
    constructor({ storage, backend, tabs, probeSession = null, now = Date.now, epoch = '' }) {
      Object.assign(this, { storage, backend, tabs, probeSession, now, epoch });
    }
    async entries() { return (await this.storage.get(SESSION_REGISTRY_KEY))[SESSION_REGISTRY_KEY] || {}; }
    async save(entries) { await this.storage.set({ [SESSION_REGISTRY_KEY]: entries }); }
    owns(entry, owner) {
      return entry && entry.tabId === owner.tabId
        && (!entry.documentId || entry.documentId === owner.documentId);
    }
    async retire(entries, entry) {
      if (entry.autoClearOnExit === false) {
        // 移除旧标签页记录前，先将用户保留缓存的选择写入数据库。
        await this.backend.setSessionAutoClear({ sessionId: entry.sessionId, enabled: false });
        delete entries[entry.sessionId];
        await this.save(entries);
        return;
      }
      entry.pending = true;
      entry.closedAt ||= this.now();
      await this.save(entries);
      try {
        await this.backend.clearSession({ sessionId: entry.sessionId });
        delete entries[entry.sessionId];
      } catch (error) {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastError = error?.message || String(error);
      }
      await this.save(entries);
    }
    async register(owner, session, autoClearOnExit) {
      if (!Number.isInteger(owner.tabId) || !roomKey(owner.url) || !/^[\w-]{1,180}$/.test(session?.id || '')) {
        throw new Error('无效的直播缓存会话');
      }
      // 关闭页面的迟到请求不能创建孤立缓存。
      const tab = await this.tabs.get(owner.tabId);
      if (roomKey(tab.url) !== roomKey(owner.url)) throw new Error('直播页面已离开');
      const entries = await this.entries();
      const existing = entries[session.id];
      if (existing && (!this.owns(existing, owner) || existing.pending)) throw new Error('缓存会话已失效，请刷新页面');
      for (const entry of Object.values(entries)) {
        if (entry.tabId === owner.tabId && entry.sessionId !== session.id) await this.retire(entries, entry);
      }
      entries[session.id] = {
        sessionId: session.id, tabId: owner.tabId, documentId: owner.documentId || '',
        browserEpoch: this.epoch,
        roomId: String(session.roomId), pageRoom: roomKey(owner.url),
        autoClearOnExit: autoClearOnExit !== false, createdAt: this.now(), pending: false
      };
      await this.save(entries);
      try {
        return await this.backend.ensureSession({ session: { ...session,
          autoClearOnExit: autoClearOnExit !== false } });
      } catch (error) {
        await this.retire(entries, entries[session.id]);
        throw error;
      }
    }
    async release(sessionId, owner) {
      const entries = await this.entries(), entry = entries[sessionId];
      if (this.owns(entry, owner)) await this.retire(entries, entry);
    }
    async releaseTab(tabId) {
      const entries = await this.entries();
      for (const entry of Object.values(entries)) {
        if (entry.tabId === tabId) await this.retire(entries, entry);
      }
    }
    async configure(sessionId, owner, enabled) {
      const entries = await this.entries(), entry = entries[sessionId];
      if (!this.owns(entry, owner) || entry.pending) return;
      // 同步数据库，重启清理时保留最新选择。
      await this.backend.setSessionAutoClear({ sessionId, enabled });
      entry.autoClearOnExit = enabled !== false;
      await this.save(entries);
    }
    async configureAll(enabled) {
      const entries = await this.entries();
      for (const entry of Object.values(entries)) {
        if (entry.pending) continue;
        await this.backend.setSessionAutoClear({ sessionId: entry.sessionId, enabled });
        entry.autoClearOnExit = enabled !== false;
      }
      await this.save(entries);
    }
    async sweep(legacy = {}) {
      const entries = await this.entries();
      const tabs = await this.tabs.query({});
      const open = new Map(tabs.map((tab) => [tab.id, tab]));
      const sessions = await this.backend.listSessions();
      // 迁移旧登记，但不清理仍在观看的会话。
      for (const [tabId, old] of Object.entries(legacy)) {
        if (!old.sessionId || entries[old.sessionId]) continue;
        entries[old.sessionId] = { ...old, tabId: Number(tabId), pageRoom: roomKey(old.pageUrl), pending: false };
      }
      for (const session of sessions) {
        if (entries[session.id] || session.autoClearOnExit === false) continue;
        // 旧清理记录可能丢失；升级时不得误删尚未注册的新会话。
        if (this.now() - Number(session.updatedAt || session.createdAt || 0) < 120000) continue;
        const possibleOwner = tabs.find((tab) => roomKey(tab.url) === String(session.roomId));
        entries[session.id] = { sessionId: session.id, autoClearOnExit: true,
          tabId: possibleOwner?.id, pageRoom: String(session.roomId), pending: !possibleOwner };
      }
      await this.save(entries);
      // 同 URL 刷新须由新文档确认旧会话失去归属；超时不能作为删除依据。
      const replaced = new Set();
      if (this.probeSession) await Promise.all(Object.values(entries).map(async (entry) => {
        const tab = open.get(entry.tabId);
        if (entry.pending || !entry.documentId || !tab || entry.browserEpoch !== this.epoch
          || roomKey(tab.url) !== entry.pageRoom) return;
        try {
          const response = await this.probeSession(entry.tabId);
          if (typeof response?.sessionId === 'string' && response.sessionId !== entry.sessionId) {
            replaced.add(entry.sessionId);
          }
        } catch (_) { /* A busy/frozen page is not proof that it has left. */ }
      }));
      for (const entry of Object.values(entries)) {
        const tab = open.get(entry.tabId);
        if (entry.pending || replaced.has(entry.sessionId) || (entry.browserEpoch && entry.browserEpoch !== this.epoch)
          || !tab || (tab.url && roomKey(tab.url) !== entry.pageRoom)) {
          await this.retire(entries, entry);
        }
      }
    }
  }
  return { SessionLifecycle, SESSION_REGISTRY_KEY, roomKey };
});
