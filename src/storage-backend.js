(function initBiliLiveBarStorageBackend(global) {
  'use strict';

  const DB_NAME = 'bililivebar-v1';
  const DB_VERSION = 2;
  const OPFS_DIRECTORY = 'bililivebar-v1';
  const EXTERNAL_DIRECTORY = 'BiliLiveBar';
  const DEFAULT_STORAGE_SETTINGS = {
    storageMode: 'opfs',
    directoryId: '',
    directoryName: '',
    maxCacheSizeGB: 0,
    autoClearOnExit: true
  };

  let dbPromise;
  let opfsPromise;

  function withSessionWrite(sessionId, task) {
    if (!/^[\w-]{1,180}$/.test(sessionId || '')) return Promise.reject(new Error('无效的缓存会话 ID'));
    // 跨 iframe/worker 锁串行写入与删除，禁止清理后由迟到写入重建会话。
    return global.navigator.locks.request(`bililivebar-session:${sessionId}`, task);
  }

  async function writableSession(db, sessionId) {
    const transaction = db.transaction('sessions', 'readonly');
    const session = await requestAsPromise(transaction.objectStore('sessions').get(sessionId));
    if (!session || session.cleanupPending) throw new Error('缓存会话已关闭');
    return session;
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function addIfAbsent(store, value) {
    return new Promise((resolve, reject) => {
      const request = store.add(value);
      request.onsuccess = () => resolve(true);
      request.onerror = (event) => {
        if (request.error?.name === 'ConstraintError') {
          // 重连重叠包属于正常去重，不能让单条主键冲突中止整批事务。
          event.preventDefault();
          event.stopPropagation();
          resolve(false);
          return;
        }
        reject(request.error);
      };
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('事务已中止'));
    });
  }

  function safeName(value) {
    return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
  }

  function createStores(db, transaction) {
    let sessions;
    if (!db.objectStoreNames.contains('sessions')) {
      sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('updatedAt', 'updatedAt');
    }

    let segments;
    if (!db.objectStoreNames.contains('segments')) {
      segments = db.createObjectStore('segments', { keyPath: 'id' });
      segments.createIndex('sessionStart', ['sessionId', 'startMs']);
    } else {
      segments = transaction.objectStore('segments');
    }
    if (!segments.indexNames.contains('sessionOrdinal')) {
      segments.createIndex('sessionOrdinal', ['sessionId', 'ordinal']);
    }

    if (!db.objectStoreNames.contains('danmaku')) {
      const danmaku = db.createObjectStore('danmaku', { keyPath: 'id' });
      danmaku.createIndex('sessionTime', ['sessionId', 'timeMs']);
    }
    if (!db.objectStoreNames.contains('binaries')) db.createObjectStore('binaries', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => createStores(request.result, request.transaction);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('缓存数据库升级被旧页面阻止，请关闭其他直播页后重试'));
    });
    return dbPromise;
  }

  async function getSettings() {
    if (!global.chrome?.storage?.local) return Object.assign({}, DEFAULT_STORAGE_SETTINGS);
    const { settings = {} } = await global.chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULT_STORAGE_SETTINGS, settings);
  }

  async function getOpfsRoot() {
    if (!global.navigator?.storage?.getDirectory) return null;
    if (!opfsPromise) {
      opfsPromise = global.navigator.storage.getDirectory()
        .then((root) => root.getDirectoryHandle(OPFS_DIRECTORY, { create: true }))
        .catch(() => { opfsPromise = null; return null; });
    }
    return opfsPromise;
  }

  async function putConfig(record) {
    const db = await openDb();
    const transaction = db.transaction('config', 'readwrite');
    transaction.objectStore('config').put(record);
    await transactionDone(transaction);
    return record;
  }

  async function getConfig(key) {
    const db = await openDb();
    const transaction = db.transaction('config', 'readonly');
    return requestAsPromise(transaction.objectStore('config').get(key));
  }

  async function saveDirectory(handle, id = crypto.randomUUID()) {
    if (!handle || handle.kind !== 'directory') throw new Error('没有选择有效的缓存文件夹');
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('尚未授予缓存文件夹读写权限');
    await putConfig({ key: `directory:${id}`, id, name: handle.name, handle, updatedAt: Date.now() });
    return { id, name: handle.name, permission };
  }

  async function getDirectoryRecord(id) {
    if (!id) return null;
    return getConfig(`directory:${id}`);
  }

  async function directoryPermission(record) {
    if (!record?.handle) return 'missing';
    try { return await record.handle.queryPermission({ mode: 'readwrite' }); }
    catch (_) { return 'denied'; }
  }

  async function getExternalSessionDirectory(directoryId, sessionId, create) {
    const record = await getDirectoryRecord(directoryId);
    if (!record?.handle) throw new Error('指定的缓存文件夹记录不存在，请重新选择');
    if (await directoryPermission(record) !== 'granted') {
      throw new Error('指定缓存文件夹的授权已失效，请打开扩展设置重新授权');
    }
    const root = await record.handle.getDirectoryHandle(EXTERNAL_DIRECTORY, { create });
    return root.getDirectoryHandle(safeName(sessionId), { create });
  }

  function binaryFileName(meta) {
    const suffix = meta.kind === 'init' ? '.init.mp4' : '.m4s';
    return `${safeName(meta.id)}${suffix}`;
  }

  async function writeFile(handle, buffer) {
    const writable = await handle.createWritable();
    try {
      await writable.write(buffer);
      await writable.close();
    } catch (error) {
      try { await writable.abort?.(); } catch (_) { /* preserve the write error */ }
      throw error;
    }
  }

  async function writeBinary(meta, buffer, session) {
    const settings = await getSettings();
    const fileName = binaryFileName(meta);
    if (settings.storageMode === 'directory') {
      if (!settings.directoryId) throw new Error('尚未指定缓存文件夹');
      // 写文件前登记目标，便于清理尚未提交索引的中断写入。
      if (!session.directoryIds?.includes(settings.directoryId)) {
        const db = await openDb();
        const transaction = db.transaction('sessions', 'readwrite');
        session.directoryIds = Array.from(new Set([...(session.directoryIds || []), settings.directoryId]));
        transaction.objectStore('sessions').put(session);
        await transactionDone(transaction);
      }
      const directory = await getExternalSessionDirectory(settings.directoryId, meta.sessionId, true);
      const handle = await directory.getFileHandle(fileName, { create: true });
      await writeFile(handle, buffer);
      return { backend: 'directory', directoryId: settings.directoryId, fileName };
    }

    const root = await getOpfsRoot();
    if (root) {
      if (!session.usedOpfs) {
        const db = await openDb();
        const transaction = db.transaction('sessions', 'readwrite');
        session.usedOpfs = true;
        transaction.objectStore('sessions').put(session);
        await transactionDone(transaction);
      }
      const directory = await root.getDirectoryHandle(safeName(meta.sessionId), { create: true });
      const handle = await directory.getFileHandle(fileName, { create: true });
      await writeFile(handle, buffer);
      return { backend: 'opfs', fileName };
    }

    const db = await openDb();
    const transaction = db.transaction('binaries', 'readwrite');
    transaction.objectStore('binaries').put({ id: meta.id, sessionId: meta.sessionId, data: new Blob([buffer]) });
    await transactionDone(transaction);
    return { backend: 'idb', fileName: meta.id };
  }

  async function readBinary(meta) {
    if (meta.backend === 'directory') {
      const directory = await getExternalSessionDirectory(meta.directoryId, meta.sessionId, false);
      const handle = await directory.getFileHandle(meta.fileName);
      return (await handle.getFile()).arrayBuffer();
    }
    if (meta.backend === 'opfs') {
      const root = await getOpfsRoot();
      if (!root) throw new Error('OPFS 当前不可用');
      const directory = await root.getDirectoryHandle(safeName(meta.sessionId));
      const handle = await directory.getFileHandle(meta.fileName);
      return (await handle.getFile()).arrayBuffer();
    }
    const db = await openDb();
    const transaction = db.transaction('binaries', 'readonly');
    const record = await requestAsPromise(transaction.objectStore('binaries').get(meta.id));
    return record ? record.data.arrayBuffer() : null;
  }

  function configuredCacheLimitBytes(settings) {
    const gigabytes = Number(settings?.maxCacheSizeGB || 0);
    if (!Number.isFinite(gigabytes) || gigabytes <= 0) return 0;
    return Math.floor(Math.min(100, gigabytes) * (1024 ** 3));
  }

  async function removeStoredBinaries(records) {
    const directories = new Map();
    for (const record of records) {
      if (record.backend === 'idb' || !record.fileName) continue;
      const key = `${record.backend}|${record.directoryId || ''}|${record.sessionId}`;
      if (!directories.has(key)) {
        directories.set(key, (async () => {
          if (record.backend === 'directory') {
            return getExternalSessionDirectory(record.directoryId, record.sessionId, false);
          }
          const root = await getOpfsRoot();
          if (!root) return null;
          try { return await root.getDirectoryHandle(safeName(record.sessionId)); }
          catch (error) {
            if (error?.name === 'NotFoundError') return null;
            throw error;
          }
        })());
      }
      const directory = await directories.get(key);
      if (!directory) continue;
      try { await directory.removeEntry(record.fileName); }
      catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    }
  }

  // 淘汰必须保留 GOP 起点；未知标记不能视作独立帧。
  function selectPrunablePrefix(records, bytesToRemove) {
    let bytes = 0;
    let count = 0;
    let safeBytes = 0;
    for (let index = 1; index <= records.length - 2; index += 1) {
      bytes += Number(records[index - 1].byteLength || 0);
      if (records[index].independent === true) {
        count = index;
        safeBytes = bytes;
        if (bytes >= bytesToRemove) break;
      }
    }
    return { count, bytes: safeBytes };
  }

  async function pruneSessionToLimit(sessionId) {
    const settings = await getSettings();
    const limitBytes = configuredCacheLimitBytes(settings);
    if (!limitBytes) return { removedBytes: 0, removedSegments: 0 };

    const db = await openDb();
    let transaction = db.transaction('sessions', 'readonly');
    const session = await requestAsPromise(transaction.objectStore('sessions').get(sessionId));
    if (!session || Number(session.totalBytes || 0) <= limitBytes) {
      return { removedBytes: 0, removedSegments: 0 };
    }

    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const totalBytes = Number(session.totalBytes || 0);
    const targetBytes = Math.floor(limitBytes * 0.95);
    const bytesToRemove = Math.max(1, totalBytes - targetBytes);
    transaction = db.transaction('segments', 'readonly');
    const records = (await requestAsPromise(transaction.objectStore('segments').index('sessionStart').getAll(range)))
      .filter((record) => record.kind === 'media');
    const plan = selectPrunablePrefix(records, bytesToRemove);
    const removals = records.slice(0, plan.count);
    if (!removals.length) return { removedBytes: 0, removedSegments: 0, blocked: true, remainingBytes: totalBytes };
    const earliestMs = records[plan.count].startMs;

    await removeStoredBinaries(removals);
    const removedBytes = removals.reduce((sum, record) => sum + Number(record.byteLength || 0), 0);
    const remainingBytes = Math.max(0, totalBytes - removedBytes);

    transaction = db.transaction(['sessions', 'segments', 'danmaku', 'binaries'], 'readwrite');
    const segmentStore = transaction.objectStore('segments');
    const binaryStore = transaction.objectStore('binaries');
    for (const record of removals) {
      segmentStore.delete(record.id);
      if (record.backend === 'idb') binaryStore.delete(record.id);
    }
    const sessionStore = transaction.objectStore('sessions');
    // 删除文件期间弹幕仍可提交，禁止用旧快照覆盖新计数。
    const current = await requestAsPromise(sessionStore.get(sessionId));
    if (current) {
      current.totalBytes = Math.max(0, Number(current.totalBytes || 0) - removedBytes);
      current.segmentCount = Math.max(0, Number(current.segmentCount || 0) - removals.length);
      current.firstMediaMs = earliestMs;
      current.prunedBytes = Number(current.prunedBytes || 0) + removedBytes;
      current.updatedAt = Date.now();
      sessionStore.put(current);
    }
    if (earliestMs > 0) {
      const danmakuRange = IDBKeyRange.bound([sessionId, 0], [sessionId, earliestMs], false, true);
      await clearStoreByIndex(transaction.objectStore('danmaku'), 'sessionTime', danmakuRange);
    }
    await transactionDone(transaction);
    return {
      removedBytes,
      removedSegments: removals.filter((record) => record.kind === 'media').length,
      earliestMs,
      remainingBytes,
      blocked: remainingBytes > limitBytes
    };
  }

  async function ensureSession({ session }) {
    const db = await openDb();
    const settings = await getSettings();
    const transaction = db.transaction('sessions', 'readwrite');
    const store = transaction.objectStore('sessions');
    const current = await requestAsPromise(store.get(session.id));
    if (current?.cleanupPending) throw new Error('缓存会话正在清理');
    const next = Object.assign({
      totalBytes: 0,
      segmentCount: 0,
      danmakuCount: 0,
      groupCounter: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, current || {}, session, {
      startedAt: Math.min(current?.startedAt || Infinity, session.startedAt || Date.now()),
      autoClearOnExit: session.autoClearOnExit ?? (settings.autoClearOnExit !== false),
      storageMode: settings.storageMode,
      directoryId: settings.storageMode === 'directory' ? settings.directoryId || '' : '',
      updatedAt: Date.now()
    });
    store.put(next);
    await transactionDone(transaction);
    try { if (global.navigator?.storage?.persist) await global.navigator.storage.persist(); } catch (_) { /* optional */ }
    return next;
  }

  async function putSegment({ meta, buffer }) {
    const db = await openDb();
    const owner = await writableSession(db, meta.sessionId);
    let transaction = db.transaction('segments', 'readonly');
    const existing = await requestAsPromise(transaction.objectStore('segments').get(meta.id));
    if (existing) {
      const pruned = meta.kind === 'media' ? await pruneSessionToLimit(meta.sessionId) : null;
      return { duplicate: true, meta: existing, pruned };
    }

    let location;
    try {
      location = await writeBinary(meta, buffer, owner);
    } catch (error) {
      if (error?.name === 'QuotaExceededError') throw new Error('本地磁盘配额不足，时移录制已停止');
      throw error;
    }

    transaction = db.transaction(['segments', 'sessions'], 'readwrite');
    const segmentStore = transaction.objectStore('segments');
    const sessionStore = transaction.objectStore('sessions');
    const session = await requestAsPromise(sessionStore.get(meta.sessionId));
    const ordinal = meta.kind === 'media' ? Number(session.nextOrdinal ?? session.segmentCount ?? 0) : -1;
    if (meta.kind === 'media') session.nextOrdinal = ordinal + 1;
    const record = Object.assign({}, meta, location, { ordinal, byteLength: buffer.byteLength, committedAt: Date.now() });
    segmentStore.put(record);
    session.totalBytes = Number(session.totalBytes || 0) + buffer.byteLength;
    session.segmentCount = Number(session.segmentCount || 0) + (meta.kind === 'media' ? 1 : 0);
    if (meta.kind === 'media') {
      session.liveEdgeMs = Math.max(Number(session.liveEdgeMs || 0), meta.startMs + meta.durationMs);
      session.firstMediaMs = Math.min(Number(session.firstMediaMs || Infinity), meta.startMs);
      if (Number.isFinite(meta.mediaStartSeconds)) {
        session.lastMediaClock = {
          wallMs: meta.startMs,
          mediaSeconds: meta.mediaStartSeconds,
          endSeconds: meta.mediaStartSeconds + meta.durationMs / 1000,
          discontinuitySequence: meta.sourceDiscontinuitySequence
        };
      }
    }
    session.groupCounter = Math.max(Number(session.groupCounter || 0), Number(meta.groupNumber || 0));
    session.lastGroupId = meta.groupId || session.lastGroupId || '';
    session.lastSequence = meta.kind === 'media' ? meta.sequence : session.lastSequence;
    session.updatedAt = Date.now();
    const directoryIds = new Set(session.directoryIds || []);
    if (location.directoryId) directoryIds.add(location.directoryId);
    session.directoryIds = Array.from(directoryIds);
    sessionStore.put(session);
    await transactionDone(transaction);
    const pruned = meta.kind === 'media' ? await pruneSessionToLimit(meta.sessionId) : null;
    return { duplicate: false, meta: record, pruned };
  }

  function publicSegment(record) {
    const copy = Object.assign({}, record);
    delete copy.backend;
    delete copy.fileName;
    delete copy.directoryId;
    return copy;
  }

  async function listSegments({ sessionId, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER }) {
    const db = await openDb();
    const transaction = db.transaction('segments', 'readonly');
    const safeFrom = Math.max(0, Number(fromMs) - 60000);
    const safeTo = Math.max(safeFrom, Number(toMs));
    const range = IDBKeyRange.bound([sessionId, safeFrom], [sessionId, safeTo]);
    const records = await requestAsPromise(transaction.objectStore('segments').index('sessionStart').getAll(range));
    return records
      .filter((record) => record.kind === 'media' && record.startMs + record.durationMs > Number(fromMs))
      .sort((a, b) => a.startMs - b.startMs || (a.ordinal ?? a.sequence) - (b.ordinal ?? b.sequence))
      .map(publicSegment);
  }

  async function getTimeline({ sessionId }) {
    const db = await openDb();
    const transaction = db.transaction('sessions', 'readonly');
    const session = await requestAsPromise(transaction.objectStore('sessions').get(sessionId));
    return {
      session,
      earliestMs: Number.isFinite(session?.firstMediaMs) ? session.firstMediaMs : session?.startedAt || Date.now(),
      liveEdgeMs: session?.liveEdgeMs || session?.startedAt || Date.now(),
      segmentCount: Number(session?.segmentCount || 0)
    };
  }

  async function getSegment({ id }) {
    const db = await openDb();
    const transaction = db.transaction('segments', 'readonly');
    const meta = await requestAsPromise(transaction.objectStore('segments').get(id));
    if (!meta) throw new Error('缓存分片不存在');
    const buffer = await readBinary(meta);
    if (!buffer) throw new Error('缓存分片文件不存在');
    return { meta, buffer };
  }

  async function putDanmakuBatch({ sessionId, items }) {
    const db = await openDb();
    await writableSession(db, sessionId);
    const transaction = db.transaction(['danmaku', 'sessions'], 'readwrite');
    const store = transaction.objectStore('danmaku');
    const candidates = items.map((item) => ({ item, id: `${sessionId}|${item.id}` }));
    // 直接 add 并忽略主键冲突，减少查询并保留去重计数。
    const additions = await Promise.all(candidates.map(({ item, id }) => addIfAbsent(
      store,
      Object.assign({}, item, { id, sourceId: item.id, sessionId })
    )));
    const inserted = additions.filter(Boolean).length;
    const sessionStore = transaction.objectStore('sessions');
    const session = await requestAsPromise(sessionStore.get(sessionId));
    if (session && inserted) {
      session.danmakuCount = Number(session.danmakuCount || 0) + inserted;
      session.updatedAt = Date.now();
      sessionStore.put(session);
    }
    await transactionDone(transaction);
    return { count: inserted };
  }

  async function getDanmakuRange({ sessionId, fromMs, toMs }) {
    const db = await openDb();
    const transaction = db.transaction('danmaku', 'readonly');
    const range = IDBKeyRange.bound([sessionId, fromMs], [sessionId, toMs]);
    const records = await requestAsPromise(transaction.objectStore('danmaku').index('sessionTime').getAll(range));
    return records.map((record) => {
      const copy = Object.assign({}, record);
      copy.id = copy.sourceId;
      delete copy.sourceId;
      delete copy.sessionId;
      return copy;
    });
  }

  async function getStats({ sessionId }) {
    const db = await openDb();
    const transaction = db.transaction('sessions', 'readonly');
    const session = await requestAsPromise(transaction.objectStore('sessions').get(sessionId));
    const settings = await getSettings();
    const estimate = global.navigator?.storage?.estimate ? await global.navigator.storage.estimate() : {};
    return {
      session,
      usage: estimate.usage || 0,
      quota: settings.storageMode === 'directory' ? 0 : estimate.quota || 0,
      storageMode: settings.storageMode
    };
  }

  async function getStorageStatus() {
    const settings = await getSettings();
    const stored = await global.chrome.storage.local.get('cacheSessionRegistry');
    const pending = Object.values(stored.cacheSessionRegistry || {}).filter((entry) => entry.pending);
    const cleanup = { pending: pending.length, error: pending.find((entry) => entry.lastError)?.lastError || '' };
    if (settings.storageMode !== 'directory') {
      return { mode: 'opfs', name: '浏览器内部存储', permission: 'granted', autoClearOnExit: settings.autoClearOnExit !== false, cleanup };
    }
    const record = await getDirectoryRecord(settings.directoryId);
    return {
      mode: 'directory',
      id: settings.directoryId,
      name: record?.name || settings.directoryName || '未找到目录',
      permission: await directoryPermission(record),
      autoClearOnExit: settings.autoClearOnExit !== false,
      cleanup
    };
  }

  async function collectByIndex(store, indexName, range) {
    return requestAsPromise(store.index(indexName).getAll(range));
  }

  async function removeSessionFiles(sessionId, records, session) {
    const root = await getOpfsRoot();
    if (!root && (session?.usedOpfs || records.some((record) => record.backend === 'opfs'))) {
      throw new Error('浏览器内部缓存暂不可访问，清理任务已保留');
    }
    if (root) {
      try { await root.removeEntry(safeName(sessionId), { recursive: true }); }
      catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    }

    const directoryIds = new Set([...(session?.directoryIds || []),
      session?.storageMode === 'directory' ? session.directoryId : ''].filter(Boolean));
    for (const record of records) if (record.directoryId) directoryIds.add(record.directoryId);
    for (const directoryId of directoryIds) {
      const directoryRecord = await getDirectoryRecord(directoryId);
      if (!directoryRecord?.handle) throw new Error('缓存文件夹记录不存在，清理任务已保留');
      if (await directoryPermission(directoryRecord) !== 'granted') {
        throw new Error(`无法清理“${directoryRecord.name}”中的缓存，请重新授权该文件夹`);
      }
      try {
        const rootDirectory = await directoryRecord.handle.getDirectoryHandle(EXTERNAL_DIRECTORY);
        await rootDirectory.removeEntry(safeName(sessionId), { recursive: true });
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    }
  }

  async function clearStoreByIndex(store, indexName, range, binaryRecords) {
    return new Promise((resolve, reject) => {
      const request = store.index(indexName).openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (binaryRecords) binaryRecords.push(cursor.value);
        cursor.delete();
        cursor.continue();
      };
    });
  }

  async function clearSession({ sessionId }) {
    const db = await openDb();
    const closing = db.transaction('sessions', 'readwrite');
    const store = closing.objectStore('sessions');
    const current = await requestAsPromise(store.get(sessionId));
    if (current) store.put({ ...current, cleanupPending: true });
    await transactionDone(closing);
    let transaction = db.transaction(['sessions', 'segments'], 'readonly');
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const [session, records] = await Promise.all([
      requestAsPromise(transaction.objectStore('sessions').get(sessionId)),
      collectByIndex(transaction.objectStore('segments'), 'sessionStart', range)
    ]);
    await removeSessionFiles(sessionId, records, session);

    transaction = db.transaction(['sessions', 'segments', 'danmaku', 'binaries'], 'readwrite');
    const binaries = [];
    await Promise.all([
      clearStoreByIndex(transaction.objectStore('segments'), 'sessionStart', range, binaries),
      clearStoreByIndex(transaction.objectStore('danmaku'), 'sessionTime', range)
    ]);
    for (const record of binaries) {
      if (record.backend === 'idb') transaction.objectStore('binaries').delete(record.id);
    }
    // 孤立二进制仅扫描元数据，避免把全部视频 Blob 读入内存。
    await new Promise((resolve, reject) => {
      const request = transaction.objectStore('binaries').openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (cursor.value.sessionId === sessionId || (!cursor.value.sessionId
          && [sessionId + '-m-', sessionId + '-i-'].some((prefix) => String(cursor.key).startsWith(prefix)))) cursor.delete();
        cursor.continue();
      };
    });
    transaction.objectStore('sessions').delete(sessionId);
    await transactionDone(transaction);
    return { cleared: true };
  }

  async function listSessions() {
    const db = await openDb();
    const transaction = db.transaction('sessions', 'readonly');
    return requestAsPromise(transaction.objectStore('sessions').getAll());
  }

  async function clearAllSessions() {
    const sessions = await listSessions();
    const errors = [];
    for (const session of sessions) {
      try { await withSessionWrite(session.id, () => clearSession({ sessionId: session.id })); }
      catch (error) { errors.push(`${session.id}: ${error.message}`); }
    }
    // 清空可移除无索引的旧目录，但不得删除快照之后新建的会话。
    const root = await getOpfsRoot();
    if (root) {
      for await (const [id] of root.entries()) {
        if (!/^\d+-\d+-[a-f0-9]{8}$/.test(id)) continue;
        try {
          await withSessionWrite(id, async () => {
            const db = await openDb();
            const transaction = db.transaction('sessions', 'readonly');
            if (!await requestAsPromise(transaction.objectStore('sessions').get(id))) {
              await root.removeEntry(id, { recursive: true });
            }
          });
        } catch (error) { if (error?.name !== 'NotFoundError') errors.push(`${id}: ${error.message}`); }
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { cleared: sessions.length };
  }

  async function setSessionAutoClear({ sessionId, enabled }) {
    const db = await openDb();
    const transaction = db.transaction('sessions', 'readwrite');
    const store = transaction.objectStore('sessions');
    const current = await requestAsPromise(store.get(sessionId));
    if (current && !current.cleanupPending) store.put({ ...current, autoClearOnExit: enabled !== false });
    await transactionDone(transaction);
  }

  global.BiliLiveBarStorageBackend = {
    DB_NAME,
    DB_VERSION,
    DEFAULT_STORAGE_SETTINGS,
    openDb,
    getSettings,
    saveDirectory,
    getDirectoryRecord,
    directoryPermission,
    ensureSession: (payload) => withSessionWrite(payload.session.id, () => ensureSession(payload)),
    putSegment: (payload) => withSessionWrite(payload.meta.sessionId, () => putSegment(payload)),
    listSegments,
    getTimeline,
    getSegment,
    putDanmakuBatch: (payload) => withSessionWrite(payload.sessionId, () => putDanmakuBatch(payload)),
    getDanmakuRange,
    getStats,
    getStorageStatus,
    pruneSessionToLimit: (sessionId) => withSessionWrite(sessionId, () => pruneSessionToLimit(sessionId)),
    selectPrunablePrefix,
    clearSession: (payload) => withSessionWrite(payload.sessionId, () => clearSession(payload)),
    setSessionAutoClear: (payload) => withSessionWrite(payload.sessionId, () => setSessionAutoClear(payload)),
    listSessions,
    clearAllSessions
  };
})(globalThis);
