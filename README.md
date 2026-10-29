# MeetScribe

**English** · [简体中文](README.zh-CN.md)

A Chrome extension that transcribes **Google Meet** and **Microsoft Teams** (web) calls in real time with [Soniox](https://soniox.com), and keeps a local recording of every meeting, so you still have the audio and can transcribe it later even when the speech API goes down.

- **Live captions in the side panel.** Your microphone ("me") and the meeting tab ("them") are transcribed separately. Remote speakers can be told apart by voice.
- **Local recording first.** Audio is saved to the browser before anything is sent over the network. If Soniox disconnects, the extension reconnects automatically. Any untranscribed stretch is marked as a gap, and you can fill it after the meeting.
- **History page.** Search past meetings and play them back with the transcript highlighted as it plays. Click a timestamp to seek. You can fill gaps or re-transcribe a whole meeting, export Markdown and audio, or delete a meeting.
- **Meeting languages.** Pick them before you start and change them mid-call, for example Chinese, Japanese and English together.
- **Auto stop.** Recording stops a few seconds after you leave the call. The countdown can be cancelled.
- **Bring your own key.** There is no backend. Settings, recordings, transcripts and logs stay on your machine.
- **Built-in diagnostics.** Structured logs can be exported per meeting.

> Status: early, personal-use project. It works for the author's daily meetings, but expect rough edges. The UI is in Chinese.

## How it works

```
Popup (user click) ──► Service worker ──► tabCapture stream id
                                   │
                                   ▼
                     Offscreen document (hidden, holds audio)
      meeting tab ─┬─► speakers (the captured tab is muted otherwise)
                   ├─► MediaRecorder ─► IndexedDB        (always on, offline)
                   └─► AudioWorklet 16 kHz PCM ─► Soniox WebSocket ─► captions
      microphone  ─┬─► MediaRecorder ─► IndexedDB
                   └─► AudioWorklet ─► Soniox WebSocket
                                   │
                                   ▼
                      Side panel (live) · History page (later)
```

See [docs/architecture.md](docs/architecture.md) for the details.

## Requirements

- Chrome 116 or later, desktop.
- A [Soniox API key](https://console.soniox.com). Real-time transcription is about $0.12 per hour per stream, and the extension opens two streams (me and them). Without a key the extension still records, and you can transcribe later.
- Meet or Teams **in the browser**. Desktop clients such as the Teams or Zoom apps cannot be captured by a browser extension.

## Install (from source)

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. The options page opens on first install:
   - Paste your Soniox key and click **测试** (Test).
   - Click **授权麦克风** (Grant microphone). The hidden recording page cannot show a permission prompt, so you grant access once here.
5. Pin the extension to the toolbar.

There is no build step: the `extension/` folder is the extension.

## Usage

1. Join a Meet or Teams call in a tab.
2. Click the extension icon, check the meeting languages, then click **开始录音转写** (Start). The keyboard shortcut is <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>.
3. Captions appear in the side panel. You can change languages there during the call.
4. Leave the call. Recording stops automatically after a 10 s countdown, or you can click **停止** (Stop).
5. Open **历史记录** (History) to replay, search, fill gaps, re-transcribe or export.

Wear headphones. Otherwise your microphone picks up the other side's audio from your speakers, and it gets transcribed twice.

## Privacy and data

| Data | Where it lives |
|---|---|
| Settings and Soniox key | `chrome.storage.local`, not encrypted, readable only by this extension |
| Meetings, transcripts, audio (webm/opus, about 15 MB per hour per stream), logs | IndexedDB in the extension's origin |
| Audio sent to Soniox | Live streams during the meeting. After-meeting jobs upload the recording and delete it from Soniox once the job finishes. |

- **Uninstalling the extension deletes all local data.** Turn on **会议结束后自动导出** (auto-export after each meeting), or export regularly. Files go to `Downloads/meetscribe/`.
- Your Soniox key is used directly from the browser. That is fine for personal use. Do not ship this build to other people with your key in it.
- Recording and transcribing a conversation may require the consent of the other participants where you live. Telling them is your responsibility.

## Troubleshooting

Set the log level to `debug` in the options page, reproduce the problem, then export the logs. Use **导出本场日志** (Export this meeting's logs) on the History page, or **导出最近 24 小时日志** (Export last 24 hours of logs) on the options page. See [docs/troubleshooting.md](docs/troubleshooting.md) for log keywords and common issues.

## Development

```bash
npm test
```

```bash
npm run check
```

`npm test` runs the unit tests with `node:test`, with no dependencies. `npm run check` syntax-checks every source file. After you edit code, click the reload icon on `chrome://extensions`.

Contributor and coding-agent guidelines are in [AGENTS.md](AGENTS.md).

## Acknowledgements

Design notes drew on these open-source projects:
- [recallai/chrome-recording-transcription-extension](https://github.com/recallai/chrome-recording-transcription-extension)
- [qduc/whisper_client_extension](https://github.com/qduc/whisper_client_extension)
- [pas1ko/meeper](https://github.com/pas1ko/meeper)

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, research, educational and other noncommercial use; commercial use is not permitted. Note: this is a source-available license, not an OSI-approved open-source license.
