(function initBiliLiveBarUi(global) {
  'use strict';
  const BLB = global.BiliLiveBar;
  const REWIND_OPTIONS = [1, 5, 10, 30, 60, 120, 300];
  const RATE_OPTIONS = [1, 1.2, 1.5, 2];
  const DANMAKU_FONT_OPTIONS = [
    ['sans', '系统默认'],
    ['yahei', '微软雅黑'],
    ['simhei', '黑体'],
    ['simsun', '宋体'],
    ['kaiti', '楷体']
  ];

  function element(tag, className, text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function settingNumber(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
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

  class BiliLiveBarUi {
    constructor({ replay, recorder, renderer, danmaku = null, storage, settings = {}, onDanmakuToggle = null, onExit = null }) {
      this.settingsBaseline = JSON.parse(JSON.stringify(settings));
      this.replay = replay;
      this.recorder = recorder;
      this.renderer = renderer;
      this.danmaku = danmaku;
      this.storage = storage;
      this.settings = settings;
      this.onDanmakuToggle = onDanmakuToggle;
      this.onExit = onExit;
      this.portals = [];
      this.fullscreen = false;
      this.webFullscreen = false;
      this.dragging = false;
      this.scrubbing = false;
      this.scrubValue = 0;
      this.scrubTicket = 0;
      this.suppressCollapseClick = false;
      this.saveTimer = 0;
      this.downloadRate = 0;
      this.qualityOptions = [];
      this.selectedQualityLabel = '画质';

      if (Number(settings.panelLayoutVersion || 0) < 4) {
        settings.panelLayoutVersion = 4;
        settings.panelSize = { width: 800, height: 90 };
        settings.rewindSeconds = 30;
      }
      if (Number(settings.qualityPreferenceVersion || 0) < 2) {
        settings.qualityPreferenceVersion = 2;
        settings.quality = 'auto';
      }
      settings.rewindSeconds = BLB.normalizeSeekSeconds(settings.rewindSeconds);
      settings.forwardSeconds = BLB.normalizeSeekSeconds(settings.forwardSeconds, 10);
      settings.seekDirection = Number(settings.seekDirection) === 1 ? 1 : -1;
      settings.liveBufferSeconds = Math.round(settingNumber(settings.liveBufferSeconds, 5, 0, 10) * 2) / 2;
      if (settings.adaptiveBuffer == null) settings.adaptiveBuffer = true;
      settings.stallRecovery = settings.stallRecovery === 'live' ? 'live' : 'resume';
      Object.assign(settings, BLB.normalizeQualitySettings(settings));
      if (settings.danmakuAvoidOverlap == null) settings.danmakuAvoidOverlap = true;
      Object.assign(settings, BLB.normalizeDanmakuScaleSettings(settings));
      if (settings.danmakuEnabled == null) settings.danmakuEnabled = true;
      if (settings.keepBackgroundQuality == null) settings.keepBackgroundQuality = true;
      delete settings.prioritizeLivePlayback;
      delete settings.edgeBufferSeconds;
      delete settings.liveLatencyMode;
      settings.danmakuOpacity = settingNumber(settings.danmakuOpacity, 0.9, 0.1, 1);
      if (!DANMAKU_FONT_OPTIONS.some(([value]) => value === settings.danmakuFontFamily)) {
        settings.danmakuFontFamily = 'sans';
      }
      settings.danmakuFontScale = settingNumber(settings.danmakuFontScale, 1, 0.4, 1.6);
      settings.danmakuEmoteScale = settingNumber(settings.danmakuEmoteScale, 1, 0.4, 1.6);
      settings.danmakuFontWeight = Math.round(settingNumber(settings.danmakuFontWeight, 600, 100, 900) / 100) * 100;
      settings.danmakuSpeed = settingNumber(settings.danmakuSpeed, 1, 0.4, 1.6);
      settings.danmakuArea = [0, 0.25, 0.5, 0.75, 1].includes(Number(settings.danmakuArea))
        ? Number(settings.danmakuArea)
        : 0.75;
      settings.danmakuFontBorder = [0, 1, 2].includes(Number(settings.danmakuFontBorder))
        ? Number(settings.danmakuFontBorder)
        : 1;
      settings.danmakuSettingsVersion = 2;
      settings.maxCacheSizeGB = Math.round(settingNumber(settings.maxCacheSizeGB, 0, 0, 100) * 2) / 2;
      delete settings.followNativeDanmakuStyle;
      delete settings.danmakuFontSize;
      delete settings.danmakuShadow;

      this.root = element('section', 'bililivebar-controls');
      if (typeof this.root.showPopover === 'function') this.root.setAttribute('popover', 'manual');
      this.root.dataset.state = 'starting';
      this.root.setAttribute('aria-label', 'BiliLiveBar 直播时移');
      this.buildHeader();
      this.buildControls();
      this.buildPopovers();
      this.bind();
      this.applySavedGeometry();
      this.setCollapsed(Boolean(settings.panelCollapsed), false);
      this.updateRewindButton();
      this.updateTimeline();
      this.saveSettingsSoon();

      this.resizeObserver = new ResizeObserver(() => this.saveGeometry());
      this.resizeObserver.observe(this.root);
      this.clock = global.setInterval(() => this.updateTimeline(), 250);
    }

    buildHeader() {
      this.header = element('header', 'bililivebar-header');
      this.collapseButton = element('button', 'bililivebar-button bililivebar-collapse-button');
      this.collapseButton.type = 'button';
      this.collapseButton.title = '折叠 BiliLiveBar';
      this.collapseButton.append(element('span', 'bililivebar-collapse-glyph'));
      const status = element('span', 'bililivebar-status-pill');
      status.title = '缓存连接状态';
      this.dot = element('i', 'bililivebar-dot');
      this.statusLabel = element('span', 'bililivebar-status-label', '正在启动');
      status.append(this.dot, this.statusLabel);
      this.speedLabel = element('span', 'bililivebar-speed', BLB.formatRate(0));
      this.speedLabel.title = '缓存下载速率';
      this.cacheLabel = element('span', 'bililivebar-cache-size', '缓存 0 B');
      this.cacheLabel.title = '本次直播缓存用量';
      this.headerSpacer = element('span', 'bililivebar-header-spacer');
      this.liveButton = element('button', 'bililivebar-button bililivebar-live-button is-live', 'LIVE');
      this.liveButton.type = 'button';
      this.liveButton.title = '回到实时直播';
      this.danmakuButton = element('button', 'bililivebar-button bililivebar-danmaku-button', '弹幕');
      this.danmakuButton.type = 'button';
      this.settingsButton = element('button', 'bililivebar-button bililivebar-settings-button', '设置');
      this.settingsButton.type = 'button';
      this.settingsButton.title = '打开 BiliLiveBar 设置';
      this.headerFoldButton = element('button', 'bililivebar-button bililivebar-fold-button', '×');
      this.headerFoldButton.type = 'button';
      this.headerFoldButton.title = '折叠悬浮窗';
      this.headerFoldButton.setAttribute('aria-label', '折叠悬浮窗');
      this.header.append(
        this.collapseButton,
        status,
        this.cacheLabel,
        this.speedLabel,
        this.headerSpacer,
        this.liveButton,
        this.danmakuButton,
        this.settingsButton,
        this.headerFoldButton
      );
      this.root.append(this.header);
      this.syncDanmakuButton();
    }

    buildControls() {
      this.body = element('div', 'bililivebar-body');
      this.controlRow = element('div', 'bililivebar-control-row');

      this.rewindGroup = element('div', 'bililivebar-split-button');
      this.rewindButton = element('button', 'bililivebar-button bililivebar-rewind-button', '−30');
      this.rewindButton.type = 'button';
      this.rewindMenuButton = element('button', 'bililivebar-button bililivebar-split-arrow', '⌄');
      this.rewindMenuButton.type = 'button';
      this.rewindMenuButton.title = '快进 / 回退；再次点击关闭';
      this.rewindGroup.append(this.rewindButton, this.rewindMenuButton);

      this.pauseButton = element('button', 'bililivebar-button bililivebar-pause-button', '暂停');
      this.pauseButton.type = 'button';
      this.pauseButton.title = '暂停当前画面';
      this.currentTime = element('span', 'bililivebar-time bililivebar-current-time', '0:00');
      this.currentTime.title = '当前播放时刻';
      this.timelineTrack = element('div', 'bililivebar-timeline-track');
      this.range = element('input', 'bililivebar-range');
      this.range.type = 'range';
      this.range.min = '0';
      this.range.max = '0';
      this.range.step = '0.1';
      this.range.value = '0';
      this.range.setAttribute('aria-label', '直播缓存进度');
      this.timelineTrack.append(this.range);
      this.liveTime = element('span', 'bililivebar-time bililivebar-live-time', '0:00');
      this.liveTime.title = '已完整缓存的末端；分片写入完成后更新';
      this.rateButton = element('button', 'bililivebar-button bililivebar-menu-button bililivebar-rate-button', '1×');
      this.rateButton.type = 'button';
      this.rateButton.title = '选择播放倍速';
      this.qualityButton = element('button', 'bililivebar-button bililivebar-menu-button bililivebar-quality-button', '画质');
      this.qualityButton.type = 'button';
      this.qualityButton.title = '选择观看与缓存画质';
      this.volumeButton = element('button', 'bililivebar-button bililivebar-volume-button', '音量');
      this.volumeButton.type = 'button';
      this.volumeButton.title = '悬停调节音量；点击切换静音';
      this.volumeButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4Z"/><path class="bililivebar-volume-waves" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="bililivebar-volume-cross" d="m16 9 5 6m0-6-5 6"/></svg>';

      this.controlRow.append(
        this.rewindGroup,
        this.pauseButton,
        this.currentTime,
        this.timelineTrack,
        this.liveTime,
        this.rateButton,
        this.qualityButton,
        this.volumeButton
      );
      this.body.append(this.controlRow);
      this.root.append(this.body);
    }

    createPopover(className) {
      const popup = element('div', `bililivebar-popover ${className}`);
      popup.setAttribute('popover', 'auto');
      popup.style.setProperty('visibility', 'visible', 'important');
      this.portals.push(popup);
      return popup;
    }

    buildPopovers() {
      this.rewindPopup = this.createPopover('bililivebar-seek-popup');
      this.ratePopup = this.createPopover('bililivebar-choice-popup');
      this.qualityPopup = this.createPopover('bililivebar-choice-popup bililivebar-quality-popup');
      this.settingsPanel = this.createPopover('bililivebar-settings-panel');
      this.contextMenu = this.createPopover('bililivebar-context-menu');
      this.volumePopup = this.createPopover('bililivebar-volume-popup');
      const volumeLabel = element('label', 'bililivebar-volume-label');
      volumeLabel.append(element('span', '', '音量'));
      this.volumeOutput = element('output', '', '100%');
      volumeLabel.append(this.volumeOutput);
      this.volumeRange = element('input', 'bililivebar-volume-range');
      this.volumeRange.type = 'range';
      this.volumeRange.min = '0';
      this.volumeRange.max = '100';
      this.volumeRange.step = '1';
      this.volumeRange.setAttribute('aria-label', '播放音量');
      this.volumeRange.addEventListener('input', () => this.replay.setVolume(Number(this.volumeRange.value) / 100));
      this.volumePopup.append(volumeLabel, this.volumeRange);

      this.buildSeekPopup();
      this.populateChoices(
        this.ratePopup,
        RATE_OPTIONS.map((value) => ({ value, label: `${value}×` })),
        () => Number(this.replay.rate || 1),
        (value) => this.replay.setRate(Number(value))
      );
      this.buildSettingsPanel();
      this.buildContextMenu();
    }

    buildSeekPopup() {
      const heading = element('div', 'bililivebar-seek-heading', '快进 / 回退');
      const close = element('button', 'bililivebar-button', '×');
      close.type = 'button';
      close.title = '关闭快进 / 回退菜单';
      close.setAttribute('aria-label', close.title);
      close.addEventListener('click', () => this.hidePopup(this.rewindPopup));
      heading.append(close);
      this.rewindPopup.append(heading);
      this.seekInputs = {};
      for (const direction of [-1, 1]) {
        const key = direction < 0 ? 'rewindSeconds' : 'forwardSeconds';
        const label = direction < 0 ? '回退' : '快进';
        const row = element('div', 'bililivebar-seek-editor');
        const field = element('label', '', label);
        const input = element('input', 'bililivebar-seek-number');
        input.type = 'number'; input.min = '0.1'; input.max = '3600'; input.step = '0.1';
        input.value = String(this.settings[key]);
        input.title = `${label}秒数：0.1–3600；修改后自动保存`;
        input.setAttribute('aria-label', `${label}秒数`);
        this.seekInputs[key] = input;
        const apply = () => {
          const value = BLB.normalizeSeekSeconds(input.value, null);
          if (value == null) {
            input.setCustomValidity?.('请输入 0.1–3600 秒');
            input.reportValidity?.();
            return false;
          }
          input.setCustomValidity?.('');
          input.value = String(value);
          this.settings[key] = value;
          this.updateRewindButton();
          this.saveSettingsSoon();
          return true;
        };
        const execute = () => {
          if (!apply()) return;
          this.executeStep(direction, this.settings[key]);
        };
        input.addEventListener('input', () => input.setCustomValidity?.(''));
        input.addEventListener('change', apply);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); execute(); }
        });
        field.append(input, element('span', '', '秒'));
        const button = element('button', 'bililivebar-button', label);
        button.type = 'button'; button.title = `按左侧秒数${label}，保留暂停状态`;
        button.addEventListener('click', execute);
        row.append(field, button);
        const presets = element('div', 'bililivebar-seek-presets');
        for (const seconds of REWIND_OPTIONS) {
          const preset = element('button', 'bililivebar-button', `${direction < 0 ? '−' : '+'}${seconds < 60 ? seconds : seconds / 60 + 'm'}`);
          preset.type = 'button'; preset.title = `${label} ${seconds} 秒，并设为默认`;
          preset.addEventListener('click', () => {
            input.value = String(seconds);
            execute();
          });
          presets.append(preset);
        }
        this.rewindPopup.append(row, presets);
      }
    }

    executeStep(direction, seconds) {
      this.settings.seekDirection = direction < 0 ? -1 : 1;
      this.settings[direction < 0 ? 'rewindSeconds' : 'forwardSeconds'] = seconds;
      this.updateRewindButton();
      this.saveSettingsSoon();
      this.hidePopup(this.rewindPopup);
      this.safeSeek(this.settings.seekDirection * seconds);
    }

    buildContextMenu() {
      const action = (label, handler, className = '') => {
        const button = element('button', `bililivebar-context-action ${className}`.trim(), label);
        button.type = 'button';
        button.title = label;
        button.addEventListener('click', () => {
          this.hidePopup(this.contextMenu);
          handler();
        });
        this.contextMenu.append(button);
        return button;
      };
      this.contextFoldButton = action(
        this.root.classList.contains('is-collapsed') ? '展开' : '折叠',
        () => this.setCollapsed(!this.root.classList.contains('is-collapsed'))
      );
      action('设置', () => {
        if (this.root.classList.contains('is-collapsed')) this.setCollapsed(false);
        this.showPopup(this.settingsPanel, this.settingsButton, 'right');
      });
      action('关闭悬浮栏', () => this.close(), 'is-danger');
    }

    populateChoices(popup, choices, activeValue, onSelect) {
      popup.replaceChildren();
      for (const choice of choices) {
        const button = element('button', 'bililivebar-choice', choice.label);
        button.type = 'button';
        button.title = choice.title || choice.label;
        button.dataset.value = String(choice.value);
        button.addEventListener('click', () => {
          onSelect(choice.value, choice);
          this.hidePopup(popup);
          this.refreshChoiceState(popup, activeValue);
        });
        popup.append(button);
      }
      popup._activeValue = activeValue;
      this.refreshChoiceState(popup, activeValue);
    }

    refreshChoiceState(popup, activeValue = popup._activeValue) {
      const value = String(typeof activeValue === 'function' ? activeValue() : activeValue);
      for (const button of popup.querySelectorAll('.bililivebar-choice')) {
        button.classList.toggle('is-active', button.dataset.value === value);
      }
    }

    settingSection(title) {
      const section = element('section', 'bililivebar-setting-section');
      section.append(element('h3', '', title));
      this.settingsPanel.append(section);
      return section;
    }

    settingToggle(section, label, key, help = '') {
      const row = element('label', 'bililivebar-setting-toggle');
      row.title = help || label;
      const copy = element('span', 'bililivebar-setting-copy');
      copy.append(element('strong', '', label));
      if (help) copy.append(element('small', '', help));
      const input = element('input');
      input.type = 'checkbox';
      input.checked = this.settings[key] !== false;
      input.dataset.setting = key;
      input.title = help || label;
      input.addEventListener('change', () => {
        this.settings[key] = input.checked;
        this.applySettingsChange(key);
      });
      row.append(copy, input);
      section.append(row);
      return input;
    }

    settingRange(section, label, key, min, max, step, suffix = '', formatter = null) {
      const block = element('label', 'bililivebar-setting-range');
      block.title = label;
      const head = element('span', 'bililivebar-setting-range-head');
      head.append(element('span', '', label));
      const format = (value) => formatter ? formatter(Number(value)) : `${value}${suffix}`;
      const output = element('output', '', format(this.settings[key]));
      head.append(output);
      const input = element('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(this.settings[key]);
      input.dataset.setting = key;
      input.title = `${label}：${format(this.settings[key])}`;
      input.addEventListener('input', () => {
        this.settings[key] = Number(input.value);
        output.textContent = format(input.value);
        input.title = `${label}：${format(input.value)}`;
        this.applySettingsChange(key);
      });
      block.append(head, input);
      section.append(block);
      return input;
    }

    settingSelect(section, label, key, choices) {
      const row = element('label', 'bililivebar-setting-row');
      row.title = label;
      row.append(element('span', '', label));
      const select = element('select', 'bililivebar-setting-select');
      select.dataset.setting = key;
      select.title = label;
      for (const [value, text] of choices) {
        const option = element('option', '', text);
        option.value = value;
        option.selected = String(this.settings[key]) === String(value);
        select.append(option);
      }
      select.addEventListener('change', () => {
        this.settings[key] = select.value;
        this.applySettingsChange(key);
      });
      row.append(select);
      section.append(row);
      return select;
    }

    settingChoices(section, label, key, choices) {
      const row = element('div', 'bililivebar-setting-row bililivebar-setting-choice-row');
      row.title = label;
      row.append(element('span', '', label));
      const group = element('div', 'bililivebar-segmented');
      group.dataset.setting = key;
      for (const [value, text] of choices) {
        const button = element('button', '', text);
        button.type = 'button';
        button.title = `${label}：${text}`;
        button.dataset.value = String(value);
        button.classList.toggle('is-active', String(this.settings[key]) === String(value));
        button.addEventListener('click', () => {
          this.settings[key] = typeof value === 'number' ? Number(value) : value;
          for (const sibling of group.children) sibling.classList.toggle('is-active', sibling === button);
          this.applySettingsChange(key);
        });
        group.append(button);
      }
      row.append(group);
      section.append(row);
      return group;
    }

    buildSettingsPanel() {
      const head = element('header', 'bililivebar-settings-head');
      head.append(element('strong', '', 'BiliLiveBar 设置'));
      const close = element('button', 'bililivebar-icon-button', '×');
      close.type = 'button';
      close.title = '关闭设置';
      close.setAttribute('aria-label', '关闭设置');
      close.addEventListener('click', () => this.hidePopup(this.settingsPanel));
      head.append(close);
      this.settingsPanel.append(head);

      const live = this.settingSection('播放');
      live.classList.add('bililivebar-playback-settings');
      const buffer = element('div', 'bililivebar-setting-group');
      live.append(buffer);
      this.bufferModeChoices = this.settingChoices(buffer, '播放缓冲', 'adaptiveBuffer', [[true, '自动'], [false, '手动']]);
      this.liveBufferRange = this.settingRange(buffer, '缓冲时长', 'liveBufferSeconds', 0, 10, 0.5, ' s');
      this.bufferHelp = element('p', 'bililivebar-setting-note', '缓冲越短，延迟越低，也越容易卡顿。');
      buffer.append(this.bufferHelp);
      this.stallRecoveryChoices = this.settingChoices(live, '卡顿恢复', 'stallRecovery', [['resume', '原位续播'], ['live', '回到 LIVE']]);
      this.syncBufferSettings();
      this.settingToggle(live, '后台保持当前画质', 'keepBackgroundQuality');
      this.playbackInfoPanel = element('details', 'bililivebar-playback-info');
      this.playbackInfoPanel.append(element('summary', '', '画面信息'));
      const information = element('dl');
      this.playbackInfoFields = {};
      for (const [key, label] of [['quality', '当前画质'], ['resolution', '分辨率'], ['bitrate', '媒体码率'],
        ['codecs', '编码'], ['source', '缓存画质'], ['download', '下载速度']]) {
        const value = element('dd', '', '—');
        this.playbackInfoFields[key] = value;
        information.append(element('dt', '', label), value);
      }
      this.playbackInfoFields.bitrate.title = '当前画面附近分片的平均码率，含音频和封装';
      this.playbackInfoPanel.append(information);
      this.playbackInfoPanel.addEventListener('toggle', () => this.updatePlaybackInfo());
      live.append(this.playbackInfoPanel);

      const danmaku = this.settingSection('弹幕');
      this.danmakuEnabledToggle = this.settingToggle(
        danmaku,
        '显示直播与历史弹幕',
        'danmakuEnabled'
      );
      this.manualDanmaku = element('div', 'bililivebar-manual-danmaku');
      danmaku.append(this.manualDanmaku);
      this.fontFamilySelect = this.settingSelect(this.manualDanmaku, '字体', 'danmakuFontFamily', DANMAKU_FONT_OPTIONS);
      this.opacityRange = this.settingRange(this.manualDanmaku, '透明度', 'danmakuOpacity', 0.1, 1, 0.05);
      this.fontSizeRange = this.settingRange(this.manualDanmaku, '文字字号', 'danmakuFontScale', 0.4, 1.6, 0.1, '×');
      this.emoteSizeRange = this.settingRange(this.manualDanmaku, '表情字号', 'danmakuEmoteScale', 0.4, 1.6, 0.1, '×');
      this.fontWeightRange = this.settingRange(this.manualDanmaku, '字体粗细', 'danmakuFontWeight', 100, 900, 100);
      this.speedRange = this.settingRange(this.manualDanmaku, '滚动速度', 'danmakuSpeed', 0.4, 1.6, 0.1, '×');
      this.settingChoices(this.manualDanmaku, '显示区域', 'danmakuArea', [
        [0, '不限'], [0.25, '1/4'], [0.5, '半屏'], [0.75, '3/4'], [1, '全屏']
      ]);
      this.settingChoices(this.manualDanmaku, '描边类型', 'danmakuFontBorder', [
        [0, '重墨'], [1, '描边'], [2, '投影']
      ]);
      this.settingToggle(this.manualDanmaku, '跟随屏幕缩放', 'danmakuScreenSync');
      this.settingToggle(this.manualDanmaku, '跟随播放倍速', 'danmakuSpeedSync');
      this.settingToggle(this.manualDanmaku, '防挡弹幕（底部 15%）', 'danmakuPreventShade');
      this.settingToggle(this.manualDanmaku, '弹幕防重叠', 'danmakuAvoidOverlap');

      const filters = this.settingSection('弹幕屏蔽');
      this.settingToggle(filters, '屏蔽滚动弹幕', 'danmakuBlockScroll');
      this.settingToggle(filters, '屏蔽顶部弹幕', 'danmakuBlockTop');
      this.settingToggle(filters, '屏蔽底部弹幕', 'danmakuBlockBottom');
      this.settingToggle(filters, '屏蔽彩色弹幕', 'danmakuBlockColor');
      this.settingToggle(filters, '屏蔽表情弹幕', 'danmakuBlockEmoji');
      this.settingToggle(filters, '屏蔽抽奖弹幕', 'danmakuBlockLottery');

      const display = this.settingSection('悬浮窗');
      this.settingToggle(display, '浏览器全屏时显示', 'showPanelInFullscreen');
      this.settingToggle(display, '网页全屏时显示', 'showPanelInWebFullscreen');
      const cache = this.settingSection('缓存');
      this.settingToggle(cache, '退出网页后清空本次缓存', 'autoClearOnExit');
      this.maxCacheRange = this.settingRange(
        cache,
        '本次缓存空间上限',
        'maxCacheSizeGB',
        0,
        100,
        0.5,
        ' GB',
        (value) => value === 0 ? '不限' : `${value} GB`
      );
      cache.append(element('p', 'bililivebar-setting-note', '满额清理旧缓存；无法安全清理时停止录制。'));
      this.storageDescription = element('p', 'bililivebar-storage-description', '正在读取缓存位置…');
      cache.append(this.storageDescription);
      const storageActions = element('div', 'bililivebar-setting-actions');
      this.chooseDirectoryButton = element('button', 'bililivebar-settings-action', '选择缓存文件夹');
      this.chooseDirectoryButton.type = 'button';
      this.chooseDirectoryButton.title = '打开缓存设置，授权文件夹';
      this.internalStorageButton = element('button', 'bililivebar-settings-action', '浏览器内部存储');
      this.internalStorageButton.type = 'button';
      this.internalStorageButton.title = '将后续视频分片写入扩展 OPFS';
      storageActions.append(this.chooseDirectoryButton, this.internalStorageButton);
      cache.append(storageActions);
      const tools = this.settingSection('排障');
      const toolActions = element('div', 'bililivebar-setting-actions');
      this.diagnosticsButton = element('button', 'bililivebar-settings-action', '复制诊断报告');
      this.diagnosticsButton.type = 'button';
      this.diagnosticsButton.title = '复制播放与缓存诊断；发送前检查隐私';
      this.diagnosticsButton.addEventListener('click', () => this.copyDiagnostics());
      const retryButton = element('button', 'bililivebar-settings-action', '重试连接与播放');
      retryButton.type = 'button';
      retryButton.title = '重连并恢复播放；保留缓存与暂停状态';
      retryButton.addEventListener('click', () => {
        this.recorder.reconnect({ retryStorage: true });
        this.danmaku?.retryPersistence();
        this.replay.recoverPlayback({ force: true, reason: 'user-retry' });
      });
      toolActions.append(retryButton, this.diagnosticsButton);
      tools.append(toolActions);

      const plugin = this.settingSection('本页插件');
      const pluginActions = element('div', 'bililivebar-setting-actions');
      const hideButton = element('button', 'bililivebar-settings-action', '关闭悬浮窗');
      hideButton.type = 'button';
      hideButton.title = '仅隐藏界面，播放与缓存继续；刷新页面恢复';
      hideButton.addEventListener('click', () => this.close());
      const exitButton = element('button', 'bililivebar-settings-action', '退出本页插件');
      exitButton.type = 'button';
      exitButton.title = '停止本页缓存并恢复 B 站播放器；刷新页面重新启用';
      exitButton.addEventListener('click', async () => {
        const cleanup = this.settings.autoClearOnExit !== false ? '本次缓存将被清空。' : '本次缓存保留。';
        if (!global.confirm(`退出本页插件并恢复 B 站播放器？${cleanup}刷新页面可重新启用。`)) return;
        exitButton.disabled = true;
        try { await this.saveSettings(); await this.onExit?.(); }
        catch (error) { this.setStatus('error', error.message || '退出失败'); }
        finally { exitButton.disabled = false; }
      });
      pluginActions.append(hideButton, exitButton);
      plugin.append(pluginActions);
    }

    applySettingsChange(key) {
      this.renderer?.applySettings?.(this.settings);
      if (key === 'adaptiveBuffer') this.replay.setAdaptiveBuffer(this.settings.adaptiveBuffer !== false);
      if (key === 'liveBufferSeconds') this.replay.setLiveBuffer(this.settings.liveBufferSeconds);
      if (key === 'stallRecovery') this.replay.setStallRecovery(this.settings.stallRecovery);
      if (['adaptiveBuffer', 'liveBufferSeconds', 'stallRecovery'].includes(key)) this.syncBufferSettings();
      if (key === 'danmakuEnabled') {
        this.syncDanmakuButton();
        this.onDanmakuToggle?.(this.settings.danmakuEnabled !== false, true);
      }
      this.applyContextVisibility();
      this.saveSettingsSoon();
      if (key === 'autoClearOnExit') {
        chrome.runtime.sendMessage({
          source: 'bililivebar',
          type: 'session-settings',
          sessionId: this.replay.session.id,
          autoClearOnExit: this.settings.autoClearOnExit !== false
        }).catch(() => {});
      }
    }

    syncBufferSettings() {
      const automatic = this.settings.adaptiveBuffer !== false;
      for (const [group, value] of [[this.bufferModeChoices, String(automatic)],
        [this.stallRecoveryChoices, this.settings.stallRecovery === 'live' ? 'live' : 'resume']]) {
        for (const button of group?.children || []) {
          const selected = button.dataset.value === value;
          button.classList.toggle('is-active', selected);
          button.setAttribute('aria-pressed', String(selected));
        }
      }
      if (this.liveBufferRange) {
        const value = this.settings.liveBufferSeconds;
        this.liveBufferRange.value = String(value);
        this.liveBufferRange.title = value === 0 ? '低延迟；数据不足时等待' : `缓冲时长：${value} s`;
        const row = this.liveBufferRange.parentElement;
        row.hidden = automatic;
        row.querySelector('output').textContent = value === 0 ? '低延迟' : `${value} s`;
      }
    }

    bind() {
      this.rewindButton.addEventListener('click', () => {
        const direction = this.settings.seekDirection === 1 ? 1 : -1;
        this.safeSeek(direction * this.settings[direction < 0 ? 'rewindSeconds' : 'forwardSeconds']);
      });
      // 记录 pointerdown 状态，防止原生轻关闭后被同次 click 重开。
      for (const [trigger, popup] of [[this.rewindMenuButton, this.rewindPopup], [this.rateButton, this.ratePopup],
        [this.qualityButton, this.qualityPopup], [this.settingsButton, this.settingsPanel]]) {
        this.bindPopupTrigger(trigger, popup);
      }
      this.rewindMenuButton.addEventListener('click', () => this.showPopup(this.rewindPopup, this.rewindGroup));
      this.rateButton.addEventListener('click', () => {
        this.refreshChoiceState(this.ratePopup);
        this.showPopup(this.ratePopup, this.rateButton, 'right');
      });
      this.qualityButton.addEventListener('click', () => this.showPopup(this.qualityPopup, this.qualityButton, 'right'));
      this.bindVolumeControl();
      this.replay.addEventListener('volume', () => this.syncVolume());
      this.replay.addEventListener('audio-preference', (event) => {
        const muteChanged = this.settings.playbackMuted !== event.detail.muted;
        this.settings.playbackVolume = event.detail.volume;
        this.settings.playbackMuted = event.detail.muted;
        if (muteChanged) this.saveSettings().catch(() => {});
        else this.saveSettingsSoon();
      });
      this.settingsButton.addEventListener('click', () => this.showPopup(this.settingsPanel, this.settingsButton, 'right'));
      this.collapseButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.suppressCollapseClick) {
          this.suppressCollapseClick = false;
          return;
        }
        this.setCollapsed(!this.root.classList.contains('is-collapsed'));
      });
      this.headerFoldButton.addEventListener('click', () => this.setCollapsed(true));
      this.danmakuButton.addEventListener('click', () => {
        this.settings.danmakuEnabled = this.settings.danmakuEnabled === false;
        if (this.danmakuEnabledToggle) {
          this.danmakuEnabledToggle.checked = this.settings.danmakuEnabled !== false;
        }
        this.applySettingsChange('danmakuEnabled');
      });
      const goLive = () => this.replay.goLive().catch((error) => this.setStatus('warning', error.message));
      this.liveButton.addEventListener('click', goLive);
      this.pauseButton.addEventListener('click', () => this.replay.togglePause());
      this.range.addEventListener('pointerdown', (event) => {
        this.scrubbing = true;
        this.scrubTicket += 1;
        this.scrubMin = Number(this.range.min);
        this.scrubMax = Number(this.range.max);
        this.scrubValue = Number(this.range.value);
        this.replay.holdForScrub();
        this.range.setPointerCapture?.(event.pointerId);
      });
      this.range.addEventListener('input', () => {
        if (!this.scrubbing) {
          this.scrubTicket += 1;
          this.scrubMin = Number(this.range.min);
          this.scrubMax = Number(this.range.max);
          this.replay.holdForScrub();
        }
        this.scrubbing = true;
        this.scrubValue = Number(this.range.value);
        this.currentTime.textContent = BLB.formatDuration(this.scrubValue * 1000);
        const min = Number(this.range.min || 0);
        const max = Number(this.range.max || min);
        const progress = max > min ? ((this.scrubValue - min) / (max - min)) * 100 : 100;
        this.range.style.setProperty('--bs-progress', `${progress}%`);
      });
      const commitSeek = () => {
        if (!this.scrubbing) return;
        const ticket = this.scrubTicket;
        const value = this.scrubValue;
        const maximum = this.scrubMax;
        this.scrubbing = false;
        const target = this.replay.session.startedAt + value * 1000;
        const atEnd = value >= maximum - 0.1;
        const operation = atEnd
          ? this.replay.seekEdge(this.replay.session.startedAt + maximum * 1000)
          : this.replay.seek(target, { mode: 'history' });
        operation.catch((error) => this.setStatus('warning', error.message || String(error)))
          .finally(() => { if (ticket === this.scrubTicket) this.replay.releaseScrub(); });
      };
      this.range.addEventListener('change', commitSeek);
      this.range.addEventListener('pointerup', commitSeek);
      this.range.addEventListener('pointercancel', () => {
        this.scrubbing = false;
        this.scrubTicket += 1;
        this.replay.releaseScrub();
        this.updateTimeline();
      });
      this.range.addEventListener('keydown', (event) => {
        if (this.scrubbing || event.altKey || event.ctrlKey || event.metaKey) return;
        const offsets = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 };
        if (!Object.hasOwn(offsets, event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = offsets[event.key] * (event.shiftKey && event.key.startsWith('Arrow') ? 0.1 : 1);
        const position = this.replay.pendingSeekWallMs || this.replay.currentWallMs();
        const target = Math.max(this.replay.earliestMs, Math.min(this.replay.liveEdgeMs - 100, position + step * 1000));
        this.replay.seek(target, { mode: 'history' }).catch((error) => this.setStatus('warning', error.message));
      });

      this.replay.addEventListener('timeline', () => this.updateTimeline());
      this.replay.addEventListener('time', () => this.updateTimeline());
      this.replay.addEventListener('mode', (event) => {
        const live = Boolean(event.detail.live);
        this.liveButton.classList.toggle('is-live', live);
        this.updateTimeline();
      });
      this.replay.addEventListener('rate', (event) => {
        this.rateButton.textContent = `${Number(event.detail.rate || 1)}×`;
        this.rateButton.title = `播放倍速：${Number(event.detail.rate || 1)}×`;
        this.refreshChoiceState(this.ratePopup);
      });
      this.replay.addEventListener('pause', (event) => {
        const paused = Boolean(event.detail.paused);
        this.pauseButton.textContent = paused ? '播放' : '暂停';
        this.pauseButton.title = paused ? '从暂停时刻播放' : '暂停当前画面';
        this.pauseButton.classList.toggle('is-paused', paused);
        this.updateTimeline();
      });
      this.replay.addEventListener('status', (event) => this.setStatus(event.detail.state, event.detail.text));
      this.recorder.addEventListener('throughput', (event) => {
        this.downloadRate = Number(event.detail.bytesPerSecond || 0);
        this.speedLabel.textContent = BLB.formatRate(this.downloadRate);
      });
      this.recorder.addEventListener('qualities', (event) => this.setQualities(event.detail));
      this.recorder.addEventListener('stream', (event) => {
        if (event.detail.label) {
          this.selectedQualityLabel = event.detail.label;
          this.updateQualityLabel();
        }
      });

      this.chooseDirectoryButton.addEventListener('click', () => this.chooseDirectory());
      this.internalStorageButton.addEventListener('click', () => this.useInternalStorage());
      this.root.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.showPopupAt(this.contextMenu, event.clientX, event.clientY);
      });
      this.bindDrag();
    }

    bindDrag() {
      let startX = 0;
      let startY = 0;
      let left = 0;
      let top = 0;
      let moved = false;
      let collapsedGesture = false;
      const move = (event) => {
        if (!this.dragging) return;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) moved = true;
        const view = this.viewport();
        const width = this.root.offsetWidth;
        const height = this.root.offsetHeight;
        const nextLeft = clamp(left + event.clientX - startX, 4, Math.max(4, view.innerWidth - width - 4));
        const nextTop = clamp(top + event.clientY - startY, 4, Math.max(4, view.innerHeight - height - 4));
        this.root.style.left = `${nextLeft}px`;
        this.root.style.top = `${nextTop}px`;
        this.root.style.right = 'auto';
        this.root.style.bottom = 'auto';
      };
      const up = (event) => {
        if (!this.dragging) return;
        const shouldExpand = event.type === 'pointerup' && collapsedGesture && !moved;
        this.dragging = false;
        if (collapsedGesture) {
          // 捕获指针时在 pointerup 展开，并抑制本次重复 click。
          this.suppressCollapseClick = true;
          global.setTimeout(() => { this.suppressCollapseClick = false; }, 0);
        }
        this.root.classList.remove('is-dragging');
        collapsedGesture = false;
        if (shouldExpand) this.setCollapsed(false);
        this.saveGeometry();
      };
      this.header.addEventListener('pointerdown', (event) => {
        const collapsedHandle = this.root.classList.contains('is-collapsed')
          && event.target.closest('.bililivebar-collapse-button');
        if (event.button !== 0 || (event.target.closest('button,input') && !collapsedHandle)) return;
        const rect = this.root.getBoundingClientRect();
        this.dragging = true;
        moved = false;
        collapsedGesture = Boolean(collapsedHandle);
        startX = event.clientX;
        startY = event.clientY;
        left = rect.left;
        top = rect.top;
        this.root.classList.add('is-dragging');
        this.header.setPointerCapture?.(event.pointerId);
        if (!collapsedHandle) event.preventDefault();
      });
      this.header.addEventListener('pointermove', move);
      this.header.addEventListener('pointerup', up);
      this.header.addEventListener('pointercancel', up);
    }

    setQualities(detail = {}) {
      this.qualityOptions = Array.isArray(detail.options) ? detail.options : [];
      this.roomQuality = detail.fallback ? detail.selectedQn
        : detail.preference ?? this.roomQuality ?? this.recorder.quality ?? this.settings.quality;
      if (this.roomQuality !== 'auto' && this.qualityOptions.length
        && !this.qualityOptions.some((item) => item.qn === Number(this.roomQuality))) {
        this.roomQuality = detail.selectedQn || this.qualityOptions[0].qn;
      }
      this.selectedQualityLabel = detail.selectedLabel || this.selectedQualityLabel;
      if (detail.fallback) {
        if (this.replay.pendingQuality?.sourceGeneration <= detail.sourceGeneration) this.replay.pendingQuality = null;
        this.setStatus('warning', `所选画质不可用，直播源返回${this.selectedQualityLabel}`);
      }
      this.updateQualityLabel();
      const highest = this.qualityOptions[0];
      const autoLabel = '自动最高';
      const choices = [{
        value: 'auto',
        label: highest ? `${autoLabel} · ${highest.label}` : autoLabel
      }].concat(this.qualityOptions.map((item) => ({ value: item.qn, label: item.label })));
      this.populateChoices(
        this.qualityPopup,
        choices,
        () => String(this.roomQuality),
        (value) => this.selectQuality(value)
      );
    }

    updateRewindButton() {
      const forward = this.settings.seekDirection === 1;
      const seconds = this.settings[forward ? 'forwardSeconds' : 'rewindSeconds'];
      const text = seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
      this.rewindButton.textContent = `${forward ? '+' : '−'}${text}`;
      this.rewindButton.title = `${forward ? '快进' : '回退'} ${seconds} 秒；下拉可切换方向和编辑秒数`;
    }

    syncDanmakuButton() {
      if (!this.danmakuButton) return;
      const enabled = this.settings.danmakuEnabled !== false;
      this.danmakuButton.classList.toggle('is-off', !enabled);
      this.danmakuButton.setAttribute('aria-pressed', String(enabled));
      this.danmakuButton.textContent = enabled ? '弹幕' : '弹幕关';
      this.danmakuButton.title = enabled ? '关闭直播与历史弹幕' : '开启直播与历史弹幕';
    }

    selectQuality(value) {
      this.settings.quality = value === 'auto' ? 'auto' : Number(value);
      this.roomQuality = this.settings.quality;
      this.settings.qualityPreferenceVersion = 2;
      this.saveSettingsSoon();
      this.recorder.setQuality(this.settings.quality).catch((error) => this.setStatus('warning', error.message));
    }

    updateQualityLabel() {
      const record = this.replay.findRecord(this.replay.windowSegments, this.replay.currentWallMs());
      const actual = record?.qualityLabel || '未知';
      this.qualityButton.textContent = this.replay.pendingQuality ? '切换中' : record?.qualityLabel || '画质';
      this.qualityButton.title = `当前画面：${actual}；缓存画质：${this.selectedQualityLabel || '未知'}`;
    }

    updatePlaybackInfo() {
      if (!this.playbackInfoPanel?.open) return;
      const info = this.replay.playbackInfo();
      const values = {
        quality: (info.qualityLabel || '未知') + (info.switching ? ' · 切换中' : ''),
        resolution: info.width && info.height ? `${info.width} × ${info.height}` : '—',
        bitrate: info.bitrate == null ? '—' : `${(info.bitrate / 1000000).toFixed(2)} Mbps`,
        codecs: info.codecs || '—', source: this.recorder.selectedLabel || '—',
        download: BLB.formatRate(Date.now() - this.recorder.lastThroughputAt < 5000 ? this.recorder.downloadRate : 0)
      };
      for (const [key, value] of Object.entries(values)) this.playbackInfoFields[key].textContent = value;
    }

    updateTimeline() {
      this.syncVolume();
      const startedAt = this.replay.session.startedAt;
      const earliest = Math.max(startedAt, this.replay.earliestMs);
      const edge = this.replay.timelineEndWallMs();
      const actual = this.replay.currentWallMs();
      const liveTarget = this.replay.liveTarget();
      const ready = this.replay.active;
      this.range.disabled = !ready;
      this.rewindButton.disabled = !ready;
      this.pauseButton.disabled = !ready;
      this.pauseButton.title = !ready ? '播放器准备中'
        : this.replay.isPaused() ? '从暂停时刻播放' : '暂停当前画面';
      this.liveButton.disabled = !ready;
      if (!this.scrubbing) {
        this.range.min = String(Math.max(0, (earliest - startedAt) / 1000));
        this.range.max = String(Math.max(Number(this.range.min), (edge - startedAt) / 1000));
        this.range.value = String((actual - startedAt) / 1000);
      }
      const min = Number(this.range.min);
      const max = Number(this.range.max);
      const displayed = this.scrubbing ? this.scrubValue : Math.max(0, (actual - startedAt) / 1000);
      this.currentTime.textContent = ready ? BLB.formatDuration(displayed * 1000) : '--:--';
      const pending = this.replay.pendingSeekWallMs;
      this.currentTime.title = ready ? (this.scrubbing ? '预览目标 ' : '播放位置 ') + displayed.toFixed(3) + ' s'
        + (pending ? '；正在定位 ' + ((pending - startedAt) / 1000).toFixed(3) + ' s' : '')
        : '播放器准备中';
      this.liveTime.textContent = BLB.formatDuration(Math.max(0, edge - startedAt));
      this.liveTime.title = '磁盘缓存末端 ' + ((edge - startedAt) / 1000).toFixed(3) + ' s；中间可能有断流缺口';
      const isLive = this.replay.isLive();
      const buffering = this.replay.engineBuffering || this.replay.bufferingSince || this.replay.recoveryPending;
      const liveAvailable = this.replay.liveDataAvailable();
      const targetLag = Math.max(0, (liveTarget - actual) / 1000);
      const lowDelay = this.replay.mode === 'edge' || (isLive && this.replay.targetLiveBuffer() === 0);
      this.liveButton.classList.toggle('is-live', isLive && !buffering && liveAvailable && targetLag < 2);
      this.liveButton.title = !liveAvailable ? '等待新的直播数据；仍可暂停和回看缓存'
        : '按当前缓冲设置返回 LIVE';
      this.range.style.setProperty('--bs-progress', (max > min ? clamp((displayed - min) / (max - min), 0, 1) * 100 : 0) + '%');
      const state = !ready ? '播放器准备中' : !liveAvailable ? '等待直播更新'
        : buffering ? '缓冲中' : lowDelay ? '低延迟 LIVE，1× 播放' : '当前播放位置';
      this.range.title = state + '；最右端为低延迟；←/→ 1 s，Shift+←/→ 0.1 s';
      this.rateButton.textContent = `${this.replay.rate}×`;
      this.rateButton.title = '选择播放倍速';
      this.root.dataset.playbackMode = this.replay.mode;
      this.updateQualityLabel();
      this.updatePlaybackInfo();
    }

    bindVolumeControl() {
      const open = () => {
        clearTimeout(this.volumeHideTimer);
        this.syncVolume();
        if (!this.volumePopup.matches(':popover-open')) this.showPopup(this.volumePopup, this.volumeButton, 'right');
      };
      const leave = () => {
        clearTimeout(this.volumeHideTimer);
        this.volumeHideTimer = global.setTimeout(() => {
          if (this.volumePopup.matches(':hover') || this.volumeButton.matches(':hover')
            || this.volumePopup.matches(':focus-within') || this.volumeDragging) return;
          if (this.volumePopup.matches(':popover-open')) this.volumePopup.hidePopover();
        }, 240);
      };
      this.volumeButton.addEventListener('pointerenter', open);
      this.volumeButton.addEventListener('focus', open);
      this.volumeButton.addEventListener('click', () => {
        this.replay.setMuted(!this.replay.audioState().muted);
        open();
      });
      this.volumePopup.addEventListener('pointerenter', () => clearTimeout(this.volumeHideTimer));
      for (const target of [this.volumeButton, this.volumePopup]) {
        target.addEventListener('pointerleave', leave);
        target.addEventListener('focusout', leave);
      }
      this.volumeRange.addEventListener('pointerdown', () => { this.volumeDragging = true; });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        this.volumeRange.addEventListener(event, () => { this.volumeDragging = false; leave(); });
      }
    }

    syncVolume() {
      if (!this.volumeRange) return;
      const { volume, muted } = this.replay.audioState();
      const percentage = Math.round(volume * 100);
      this.volumeRange.value = String(percentage);
      this.volumeOutput.textContent = `${percentage}%`;
      this.volumeButton.classList.toggle('is-muted', muted || percentage === 0);
      this.volumeButton.setAttribute('aria-pressed', String(muted));
      this.volumeButton.setAttribute('aria-label', muted ? '取消静音' : '静音');
      this.volumeButton.title = `音量 ${percentage}%${muted ? '（已静音）' : ''}；点击${muted ? '取消静音' : '静音'}，悬停调节`;
      this.volumeRange.title = `音量 ${percentage}%`;
    }

    async copyDiagnostics() {
      const report = {
        ...this.replay.diagnostics(),
        recording: {
          requestedQuality: this.recorder.quality, actualQuality: this.recorder.selectedQn,
          actualLabel: this.recorder.selectedLabel, sourceGeneration: this.recorder.sourceGeneration,
          bytesPerSecond: this.recorder.downloadRate, lastSegmentAt: this.recorder.lastSegmentAt,
          lastStoredEdgeMs: this.recorder.lastStoredEdgeMs - this.replay.session.startedAt,
          lastDownloadMs: this.recorder.lastDownloadMs, lastCommitMs: this.recorder.lastCommitMs,
          segmentDurationMs: this.recorder.lastSegmentDurationMs, retries: this.recorder.fetchRetries,
          commitIntervalMs: this.recorder.lastCommitIntervalMs, playlistTargetMs: this.recorder.playlistTargetMs,
          errorCount: this.recorder.errorCount,
          skippedSegments: this.recorder.skippedSegments,
          cacheLimitBlocked: this.recorder.cacheLimitBlocked || false,
          storageFault: this.recorder.storageFault || null
        },
        danmaku: {
          source: this.root.dataset.danmakuSource, captured: this.root.dataset.danmakuCaptured,
          rendering: this.renderer?.diagnostics(),
          persistence: this.danmaku?.diagnostics(),
          stored: this.root.dataset.danmakuStored,
          storedStatsAt: Number(this.root.dataset.statsAt || 0)
        }
      };
      const json = JSON.stringify(report, null, 2);
      try {
        await navigator.clipboard.writeText(json);
        this.diagnosticsButton.textContent = '已复制诊断报告';
        global.setTimeout(() => { this.diagnosticsButton.textContent = '复制诊断报告'; }, 2000);
      } catch (_) {
        if (!this.diagnosticOutput) {
          this.diagnosticOutput = element('textarea', 'bililivebar-diagnostic-output');
          this.diagnosticOutput.readOnly = true;
          this.diagnosticOutput.title = '诊断报告 JSON';
          this.settingsPanel.append(this.diagnosticOutput);
        }
        this.diagnosticOutput.value = json;
        this.diagnosticOutput.focus();
        this.diagnosticOutput.select();
      }
    }

    async safeSeek(deltaSeconds) {
      try { await this.replay.seekRelative(deltaSeconds); }
      catch (error) { this.setStatus('error', error.message || String(error)); }
    }

    setStatus(state, text) {
      this.root.dataset.state = state || '';
      this.statusLabel.textContent = text || '';
      this.statusLabel.title = text || '';
    }

    setStats(stats) {
      const sessionBytes = Number(stats?.session?.totalBytes || 0);
      this.root.dataset.danmakuStored = String(Number(stats?.session?.danmakuCount || 0));
      this.root.dataset.statsAt = String(Date.now());
      this.cacheLabel.textContent = `缓存 ${BLB.formatBytes(sessionBytes)}`;
      const maxBytes = Number(this.settings.maxCacheSizeGB || 0) * (1024 ** 3);
      this.cacheLabel.title = maxBytes > 0
        ? `本次缓存 ${BLB.formatBytes(sessionBytes)} / ${BLB.formatBytes(maxBytes)}`
        : `本次直播已缓存 ${BLB.formatBytes(sessionBytes)}；空间不限`;
      const remaining = Number(stats?.quota || 0) - Number(stats?.usage || 0);
      if (Number(stats?.quota || 0) > 0 && remaining >= 0 && remaining < 1024 ** 3) {
        this.setStatus('warning', `缓存空间不足 ${BLB.formatBytes(remaining)}`);
      }
    }

    setStorageStatus(state) {
      if (!this.storageDescription) return;
      this.internalStorageButton?.setAttribute('aria-pressed', String(state?.mode !== 'directory'));
      this.chooseDirectoryButton?.setAttribute('aria-pressed', String(state?.mode === 'directory'));
      if (state?.mode === 'directory') {
        const permission = state.permission === 'granted' ? '已授权' : '需要重新选择或授权';
        this.storageDescription.textContent = `缓存位置：${state.name || '指定文件夹'}（${permission}）`;
      } else {
        this.storageDescription.textContent = '缓存位置：浏览器内部 OPFS 私有空间';
      }
      if (state?.cleanup?.pending) this.storageDescription.textContent += `；${state.cleanup.pending} 个会话待清理${state.cleanup.error ? '：' + state.cleanup.error : ''}`;
    }

    async chooseDirectory() {
      this.chooseDirectoryButton.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'open-options' });
        if (!result?.ok) throw new Error(result?.error || '无法打开缓存管理页');
      } catch (error) {
        if (error?.name !== 'AbortError') this.setStatus('warning', `选择缓存文件夹失败：${error.message}`);
      } finally {
        this.chooseDirectoryButton.disabled = false;
      }
    }

    async useInternalStorage() {
      this.internalStorageButton.disabled = true;
      try {
        this.settings.storageMode = 'opfs';
        this.settings.cacheSetupDone = true;
        await this.saveSettings();
        this.setStorageStatus(await this.storage.getStorageStatus());
      } catch (error) {
        this.setStatus('warning', `切换内部存储失败：${error.message}`);
      } finally {
        this.internalStorageButton.disabled = false;
      }
    }

    showPopup(popup, anchor, align = 'left') {
      if (!popup || !anchor) return;
      const close = popup._triggerWasOpen || this.popupOpen(popup);
      popup._triggerWasOpen = false;
      if (close) { this.hidePopup(popup); return; }
      this.mountPortals(this.root.parentElement || document.body);
      this.hideAllPopups();
      if (popup === this.rewindPopup) {
        for (const [key, input] of Object.entries(this.seekInputs || {})) {
          input.value = String(this.settings[key]);
          input.setCustomValidity?.('');
        }
      }
      this.refreshChoiceState(popup);
      try { popup.showPopover(); }
      catch (_) { popup.classList.add('is-open'); }
      requestAnimationFrame(() => this.positionPopup(popup, anchor, align));
    }

    showPopupAt(popup, x, y) {
      if (!popup) return;
      this.mountPortals(this.root.parentElement || document.body);
      this.hideAllPopups();
      try { popup.showPopover(); }
      catch (_) { popup.classList.add('is-open'); }
      requestAnimationFrame(() => {
        const view = this.viewport();
        const rect = popup.getBoundingClientRect();
        popup.style.left = `${clamp(x, 8, Math.max(8, view.innerWidth - rect.width - 8))}px`;
        popup.style.top = `${clamp(y, 8, Math.max(8, view.innerHeight - rect.height - 8))}px`;
      });
    }

    positionPopup(popup, anchor, align = 'left') {
      const view = this.viewport();
      const anchorRect = anchor.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      let left = align === 'right' ? anchorRect.right - popupRect.width : anchorRect.left;
      left = clamp(left, 8, Math.max(8, view.innerWidth - popupRect.width - 8));
      let top = anchorRect.bottom + 7;
      if (top + popupRect.height > view.innerHeight - 8) top = anchorRect.top - popupRect.height - 7;
      top = clamp(top, 8, Math.max(8, view.innerHeight - popupRect.height - 8));
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    }

    hidePopup(popup) {
      try {
        if (popup.matches(':popover-open')) popup.hidePopover();
      } catch (_) { /* Popover API not available */ }
      popup.classList.remove('is-open');
    }

    popupOpen(popup) {
      try { if (popup.matches(':popover-open')) return true; } catch (_) { /* fallback */ }
      return popup.classList.contains('is-open');
    }

    bindPopupTrigger(trigger, popup) {
      trigger.addEventListener('pointerdown', () => { popup._triggerWasOpen = this.popupOpen(popup); });
      trigger.addEventListener('pointercancel', () => { popup._triggerWasOpen = false; });
      trigger.addEventListener('keydown', () => { popup._triggerWasOpen = false; });
    }

    hideAllPopups() {
      for (const popup of this.portals) this.hidePopup(popup);
    }

    mountPortals(parent) {
      if (!parent) return;
      for (const popup of this.portals) {
        if (popup.parentElement !== parent) {
          this.hidePopup(popup);
          parent.append(popup);
        }
      }
    }

    mount(parent, context = {}) {
      if (!parent) return;
      ensureExtensionStyles(parent);
      // 覆盖活动页 iframe 全屏时继承的 visibility:hidden。
      this.root.style.setProperty('visibility', 'visible', 'important');
      if (this.root.parentElement !== parent) {
        this.hideAllPopups();
        try { if (this.root.matches(':popover-open')) this.root.hidePopover(); } catch (_) { /* not open */ }
        parent.append(this.root);
      }
      if (this.root.hasAttribute('popover')) {
        try {
          if (!this.root.matches(':popover-open')) this.root.showPopover();
        } catch (_) { /* fullscreen transition may briefly reject top-layer changes */ }
      }
      this.mountPortals(parent);
      this.fullscreen = Boolean(context.fullscreen);
      this.webFullscreen = Boolean(context.webFullscreen);
      this.applyContextVisibility();
      this.keepInsideViewport();
    }

    applyContextVisibility() {
      const hidden = (this.fullscreen && this.settings.showPanelInFullscreen === false)
        || (this.webFullscreen && this.settings.showPanelInWebFullscreen === false);
      this.root.classList.toggle('is-context-hidden', hidden);
      if (hidden) this.hideAllPopups();
    }

    setCollapsed(collapsed, save = true) {
      this.root.classList.toggle('is-collapsed', collapsed);
      this.collapseButton.title = collapsed ? '展开 BiliLiveBar' : '折叠 BiliLiveBar';
      this.collapseButton.setAttribute('aria-label', this.collapseButton.title);
      this.collapseButton.setAttribute('aria-expanded', String(!collapsed));
      if (this.contextFoldButton) {
        this.contextFoldButton.textContent = collapsed ? '展开' : '折叠';
        this.contextFoldButton.title = collapsed ? '展开' : '折叠';
      }
      this.settings.panelCollapsed = collapsed;
      if (collapsed) this.hideAllPopups();
      this.keepInsideViewport();
      if (save) this.saveSettingsSoon();
    }

    close() {
      this.hideAllPopups();
      this.root.classList.add('is-closed');
    }

    viewport() {
      return this.root.ownerDocument?.defaultView || global;
    }

    applySavedGeometry() {
      const maximum = Math.max(304, this.viewport().innerWidth - 8);
      const minimum = Math.min(520, maximum);
      const width = clamp(this.settings.panelSize?.width || 760, minimum, maximum);
      this.root.style.width = `${width}px`;
      const position = this.settings.panelPosition;
      if (position && Number.isFinite(Number(position.left)) && Number.isFinite(Number(position.top))) {
        this.root.style.left = `${Number(position.left)}px`;
        this.root.style.top = `${Number(position.top)}px`;
        this.root.style.right = 'auto';
        this.root.style.bottom = 'auto';
      }
    }

    keepInsideViewport() {
      if (!this.root.isConnected || !this.root.style.left) return;
      const view = this.viewport();
      const rect = this.root.getBoundingClientRect();
      const left = clamp(rect.left, 4, Math.max(4, view.innerWidth - rect.width - 4));
      const top = clamp(rect.top, 4, Math.max(4, view.innerHeight - rect.height - 4));
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    }

    saveGeometry() {
      if (!this.root.isConnected) return;
      const rect = this.root.getBoundingClientRect();
      if (!this.root.classList.contains('is-collapsed')) {
        this.settings.panelSize = { width: Math.round(rect.width), height: 90 };
      }
      this.settings.panelPosition = { left: Math.round(rect.left), top: Math.round(rect.top) };
      this.saveSettingsSoon();
    }

    saveSettingsSoon() {
      clearTimeout(this.saveTimer);
      this.saveTimer = global.setTimeout(() => this.saveSettings().catch(() => {}), 180);
    }

    async saveSettings() {
      clearTimeout(this.saveTimer);
      const patch = BLB.settingsPatch(this.settingsBaseline, this.settings);
      if (!Object.keys(patch).length) return;
      const result = await chrome.runtime.sendMessage({ source: 'bililivebar', type: 'update-settings', patch });
      if (!result?.ok) throw new Error(result?.error || '设置保存失败');
    }

    acceptStoredSettings(settings) {
      // 保留防抖期间的本地编辑；跨页变更只合并字段，避免覆盖。
      const dirty = BLB.settingsPatch(this.settingsBaseline, this.settings);
      this.settingsBaseline = JSON.parse(JSON.stringify(settings));
      Object.assign(this.settings, settings, dirty);
    }

    destroy() {
      clearInterval(this.clock);
      clearTimeout(this.saveTimer);
      clearTimeout(this.volumeHideTimer);
      this.resizeObserver?.disconnect();
      this.hideAllPopups();
      try { if (this.root.matches(':popover-open')) this.root.hidePopover(); } catch (_) { /* already detached */ }
      for (const popup of this.portals) popup.remove();
      this.root.remove();
    }
  }

  BLB.BiliLiveBarUi = BiliLiveBarUi;
})(globalThis);
