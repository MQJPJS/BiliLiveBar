(async function initOptions() {
  'use strict';
  const backend = globalThis.BiliLiveBarStorageBackend;
  const status = document.querySelector('#storage-status');
  const setupGuide = document.querySelector('#setup-guide');
  const usage = document.querySelector('#usage');
  const message = document.querySelector('#message');
  const autoClear = document.querySelector('#auto-clear');
  const showPanelFullscreen = document.querySelector('#show-panel-fullscreen');
  const showPanelWebFullscreen = document.querySelector('#show-panel-web-fullscreen');
  const maxCacheSize = document.querySelector('#max-cache-size');
  const maxCacheSizeValue = document.querySelector('#max-cache-size-value');
  const chooseButton = document.querySelector('#choose-directory');
  const reauthorizeButton = document.querySelector('#reauthorize');
  const internalButton = document.querySelector('#use-internal');
  const clearButton = document.querySelector('#clear-all');
  let settings;

  function formatCacheLimit(value) {
    const gigabytes = Number(value || 0);
    return gigabytes > 0 ? `${gigabytes} GB` : '不限';
  }

  function notify(text, error = false) {
    message.textContent = text;
    message.classList.toggle('error', error);
  }

  async function save(patch) {
    const result = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'update-settings', patch });
    if (!result?.ok) throw new Error(result?.error || '设置保存失败');
    settings = result.settings;
  }

  async function refresh() {
    const stored = await chrome.storage.local.get('settings');
    settings = Object.assign({}, backend.DEFAULT_STORAGE_SETTINGS, stored.settings || {});
    setupGuide.hidden = settings.cacheSetupDone === true;
    autoClear.checked = settings.autoClearOnExit !== false;
    showPanelFullscreen.checked = settings.showPanelInFullscreen !== false;
    showPanelWebFullscreen.checked = settings.showPanelInWebFullscreen !== false;
    maxCacheSize.value = String(Math.max(0, Math.min(100, Number(settings.maxCacheSizeGB || 0))));
    maxCacheSizeValue.textContent = formatCacheLimit(maxCacheSize.value);
    maxCacheSize.title = `单次直播缓存上限：${formatCacheLimit(maxCacheSize.value)}`;
    const storageState = await backend.getStorageStatus();
    chooseButton.setAttribute('aria-pressed', String(storageState.mode === 'directory'));
    internalButton.setAttribute('aria-pressed', String(storageState.mode !== 'directory'));
    const cleanupStatus = document.querySelector('#cleanup-status');
    cleanupStatus.textContent = storageState.cleanup?.pending
      ? `${storageState.cleanup.pending} 个会话等待清理。${storageState.cleanup.error || '后台将自动重试。'}` : '没有待重试的清理任务。';
    if (storageState.mode === 'directory') {
      const permissionText = storageState.permission === 'granted' ? '已授权' : storageState.permission === 'prompt' ? '需要重新授权' : '没有权限';
      status.textContent = `指定文件夹：${storageState.name}（${permissionText}）`;
      reauthorizeButton.hidden = storageState.permission === 'granted';
    } else {
      status.textContent = '浏览器内部存储 · OPFS';
      reauthorizeButton.hidden = true;
    }
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    const used = Number(estimate.usage || 0) / (1024 ** 2);
    const quota = Number(estimate.quota || 0) / (1024 ** 3);
    usage.textContent = quota ? `内部存储 ${used.toFixed(1)} MB / 配额 ${quota.toFixed(1)} GB，不含指定文件夹。` : '';
  }

  async function chooseDirectory() {
    if (!globalThis.showDirectoryPicker) throw new Error('当前浏览器不支持选择本地文件夹，请使用最新版 Chrome 或 Edge');
    const handle = await globalThis.showDirectoryPicker({ id: 'bililivebar-cache', mode: 'readwrite' });
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('没有获得该文件夹的读写权限');
    const saved = await backend.saveDirectory(handle);
    await save({ storageMode: 'directory', directoryId: saved.id, directoryName: saved.name, cacheSetupDone: true });
    notify(`后续视频缓存将写入“${saved.name}\\BiliLiveBar”。`);
    await refresh();
  }

  chooseButton.addEventListener('click', async () => {
    chooseButton.disabled = true;
    try { await chooseDirectory(); }
    catch (error) { if (error?.name !== 'AbortError') notify(error.message, true); }
    finally { chooseButton.disabled = false; }
  });

  reauthorizeButton.addEventListener('click', async () => {
    reauthorizeButton.disabled = true;
    try {
      const record = await backend.getDirectoryRecord(settings.directoryId);
      if (!record?.handle) throw new Error('原目录记录不存在，请重新选择缓存文件夹');
      const permission = await record.handle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('没有获得该文件夹的读写权限');
      notify('缓存文件夹授权已恢复。');
      await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'retry-cleanup' });
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { reauthorizeButton.disabled = false; }
  });

  document.querySelector('#retry-cleanup').addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'retry-cleanup' });
      if (!result?.ok) throw new Error(result?.error || '清理检查失败');
      await refresh();
    } catch (error) { notify(error.message, true); }
  });

  internalButton.addEventListener('click', async () => {
    internalButton.disabled = true;
    try {
      await save({ storageMode: 'opfs', cacheSetupDone: true });
      notify('已切换为浏览器内部缓存。');
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { internalButton.disabled = false; }
  });

  autoClear.addEventListener('change', async () => {
    try {
      await save({ autoClearOnExit: autoClear.checked });
      notify(autoClear.checked ? '退出网页自动清理已开启。' : '缓存将保留，直到手动清理。');
    } catch (error) { notify(error.message, true); }
  });

  showPanelFullscreen.addEventListener('change', async () => {
    try {
      await save({ showPanelInFullscreen: showPanelFullscreen.checked });
      notify(showPanelFullscreen.checked ? '浏览器全屏时将显示悬浮窗。' : '浏览器全屏时将隐藏悬浮窗。');
    } catch (error) { notify(error.message, true); }
  });

  showPanelWebFullscreen.addEventListener('change', async () => {
    try {
      await save({ showPanelInWebFullscreen: showPanelWebFullscreen.checked });
      notify(showPanelWebFullscreen.checked ? '网页全屏时将显示悬浮窗。' : '网页全屏时将隐藏悬浮窗。');
    } catch (error) { notify(error.message, true); }
  });

  maxCacheSize.addEventListener('input', () => {
    maxCacheSizeValue.textContent = formatCacheLimit(maxCacheSize.value);
    maxCacheSize.title = `单次直播缓存上限：${formatCacheLimit(maxCacheSize.value)}`;
  });

  maxCacheSize.addEventListener('change', async () => {
    try {
      await save({ maxCacheSizeGB: Number(maxCacheSize.value) });
      notify(Number(maxCacheSize.value) > 0
        ? `单次直播缓存上限已设为 ${formatCacheLimit(maxCacheSize.value)}。`
        : '单次直播缓存不限制空间。');
    } catch (error) { notify(error.message, true); }
  });

  clearButton.addEventListener('click', async () => {
    if (!confirm('确定清空全部 BiliLiveBar 视频和弹幕缓存吗？此操作无法撤销。')) return;
    clearButton.disabled = true;
    try {
      const result = await backend.clearAllSessions();
      notify(`已清理 ${result.cleared} 个缓存会话。`);
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { clearButton.disabled = false; }
  });

  try { await refresh(); }
  catch (error) { notify(`读取设置失败：${error.message}`, true); }
})();
