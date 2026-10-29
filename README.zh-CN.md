# MeetScribe

[English](README.md) · **简体中文**

一个 Chrome 扩展：在 **Google Meet** 和 **Microsoft Teams**（网页版）开会时，用 [Soniox](https://soniox.com) 实时转写，并把每场会议的录音保存在本机。转写服务出问题时会议照开，录音也还在，事后可以补转。

- **侧边栏实时字幕**：「我」（麦克风）和「对方」（会议标签页）分开转写，对方的多个人能按声音区分（对方 1 / 对方 2）。
- **录音优先**：音频先存到本地，再走网络转写。Soniox 断线会自动重连，没转上的部分标为「转写缺口」，会后可以补转。
- **历史页**：搜索会议；回放时字幕跟着高亮，点时间可以跳转。还能补转缺口、整场重转、导出 Markdown / 录音、删除。
- **会议语言**：开始前选，会议中也能改，比如中 / 日 / 英混说。
- **自动停止**：离开通话后倒计时几秒自动停止，倒计时期间可以取消。
- **自带 key**：没有后端服务。设置、录音、字幕、日志都只存在本机。
- **便于排查**：日志是结构化的，可以按单场会议导出。

> 状态：个人项目，早期版本。作者日常开会在用，但难免有粗糙的地方。

## 原理

```
弹窗（用户点击）──► Service Worker ──► 拿到标签页音频的流 ID
                                │
                                ▼
                 Offscreen 隐藏页面（持有音频和连接）
   会议标签页 ─┬─► 扬声器（被捕获的标签页默认会静音，所以要重新播放出来）
               ├─► MediaRecorder ─► IndexedDB        （一直在录，不依赖网络）
               └─► AudioWorklet 16kHz PCM ─► Soniox WebSocket ─► 字幕
   麦克风     ─┬─► MediaRecorder ─► IndexedDB
               └─► AudioWorklet ─► Soniox WebSocket
                                │
                                ▼
                    侧边栏（实时）· 历史页（会后）
```

详见 [docs/architecture.md](docs/architecture.md)。

## 环境要求

- 桌面版 Chrome 116 及以上。
- 一个 [Soniox API key](https://console.soniox.com)：
  - 实时转写约 $0.12 / 小时 / 路。这个扩展同时开两路（我 / 对方）。
  - 不填 key 也能用，只录音，会后再补转。
- Meet / Teams 必须在**浏览器里**打开。Teams、Zoom 等桌面客户端无法被浏览器扩展抓到声音。

## 安装（从源码）

1. 克隆本仓库。
2. 打开 `chrome://extensions`，开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择 `extension/` 目录。
4. 首次安装会自动打开设置页：
   - 填 Soniox key，点「测试」。
   - 点「授权麦克风」。后台录音页面没法弹出授权框，所以要先在这里授权一次。
5. 把扩展固定到工具栏。

不需要构建：`extension/` 目录本身就是扩展。

## 使用

1. 在标签页里加入 Meet / Teams 通话。
2. 点扩展图标，确认会议语言，点「开始录音转写」。快捷键是 <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>。
3. 字幕显示在侧边栏，会议中也能在侧边栏改语言。
4. 离开通话后会倒计时 10 秒自动停止，也可以直接点「停止」。
5. 在「历史记录」里回放、搜索、补转、重转、导出。

建议戴耳机。否则麦克风会把扬声器里对方的声音再录一遍，同一句话会被转写两次。

## 隐私与数据

| 数据 | 存放位置 |
|---|---|
| 设置、Soniox key | `chrome.storage.local`（未加密，只有本扩展能读） |
| 会议、字幕、录音（webm/opus，约 15MB / 小时 / 路）、日志 | 扩展自己的 IndexedDB |
| 发给 Soniox 的音频 | 会议中是实时音频流；会后补转时上传录音文件，补转完成后立即从 Soniox 删除 |

- **卸载扩展会清空所有本地数据。** 建议开启「会议结束后自动导出」，或者定期导出。文件保存在 `下载/meetscribe/`。
- Soniox key 直接在浏览器里使用，自用没问题。不要把填了自己 key 的版本分发给别人。
- 很多地区录音和转写需要征得参会者同意，这需要你自己告知对方。

## 排查问题

1. 在设置页把日志级别改为 `debug`。
2. 复现问题。
3. 在历史页点「导出本场日志」，或者在设置页点「导出最近 24 小时日志」。

日志关键词和常见问题见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 开发

```bash
npm test
```

```bash
npm run check
```

`npm test` 运行单元测试（用 Node 自带的 `node:test`，不需要安装依赖）。`npm run check` 对所有源文件做语法检查。改完代码后，在 `chrome://extensions` 点扩展的刷新按钮即可生效。

贡献者与 AI 编码助手的约定见 [AGENTS.md](AGENTS.md)。

## 致谢

设计时参考了这些开源项目：
- [recallai/chrome-recording-transcription-extension](https://github.com/recallai/chrome-recording-transcription-extension)
- [qduc/whisper_client_extension](https://github.com/qduc/whisper_client_extension)
- [pas1ko/meeper](https://github.com/pas1ko/meeper)

## 许可证

[PolyForm Noncommercial 1.0.0](LICENSE)。可免费用于个人、研究、教育等非商业用途，禁止商用。注意：这是"源码可见"许可证，不属于 OSI 认可的开源许可证。
