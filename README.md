# BiliLiveBar · B站直播进度条

用GPT搓出来的，不保证后续维护。

为 Bilibili 直播增加可回看的进度条，方便进行时间轴对轴以及直播回看。

适用于桌面 Chrome / Edge 116+。

## 功能

- 为直播增加进度条，实现暂停回看、快进回退，方便时间轴对轴。
- 同步回放弹幕，支持调整弹幕样式、防重叠和屏蔽设置。
- 可拖动、缩放、折叠的悬浮窗，支持全屏、音量和画质控制。
- 可指定缓存文件夹、限制缓存空间，默认开启退出清理。

## 安装与使用

1. 下载并解压，或克隆仓库，无需构建。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。
4. 完成缓存位置设置，打开 B 站直播间。

拖动进度条回看，点击 LIVE 返回直播，其余选项在设置中调整。升级后重新加载扩展并重新进入直播间。

## 许可与参考

项目采用 [MIT](LICENSE)。内置 [Shaka Player 5.2.6](https://github.com/shaka-project/shaka-player/tree/v5.2.6)，保留其 [Apache-2.0 许可及附带声明](vendor/LICENSE-Shaka-Player)。

参考项目：[dmMiniPlayer](https://github.com/apades/dmMiniPlayer)、[bilibili-live-seeker-script](https://github.com/c-basalt/bilibili-live-seeker-script)、[bliveproxy](https://github.com/xfgryujk/bliveproxy)、[bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)、[blive-message-listener](https://github.com/ddiu8081/blive-message-listener)、[bili-shadowreplay](https://github.com/Xinrea/bili-shadowreplay)、[bilibili-vup-stream-enhancer](https://github.com/eric2788/bilibili-vup-stream-enhancer)、[flv.js](https://github.com/bilibili/flv.js)、[hls.js](https://github.com/video-dev/hls.js)。
