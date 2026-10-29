# Troubleshooting

## Collect logs

1. On the options page (设置), set **日志级别** (log level) to `debug`. `info` is usually enough.
2. Reproduce the problem.
3. Export the logs:
   - About a specific meeting: History (历史记录), select the meeting, then **导出本场日志** (Export this meeting's logs). This covers the meeting window plus anything tagged with its id.
   - Anything else: options page, then **导出最近 24 小时日志** (Export last 24 hours of logs).
4. The file is saved to `Downloads/meetscribe/logs/*.jsonl`. When you report the problem, attach it and say what you did, what you expected, and roughly when it happened.

Logs never contain your API key.

You can also watch the live console. On `chrome://extensions`, under this extension, click **service worker** or **offscreen.html** (the latter only while recording).

## Reading a log

The first line is a header with the extension version, user agent, redacted settings and, for per-meeting exports, the full meeting record. Every following line is one log entry:

```json
{"ts":1793235643574,"t":"2026-10-29T01:00:43.574Z","level":"info","ctx":"offscreen","msg":"soniox ws open","data":{...},"meetingId":"…","source":"them"}
```

`ctx` tells you which part of the extension wrote the entry: `sw`, `offscreen`, `sidepanel`, `history`, `popup` or `options`. `source` is `them` (the meeting tab) or `me` (the microphone).

## Keywords

| Symptom | Search for |
|---|---|
| Start fails | `start recording failed`, `tab audio capture failed`, `offscreen document did not respond` |
| No captions at all | `transcription status`, `soniox error message`, `soniox closed`, `no audio from` |
| Captions stop mid-meeting | `soniox closed unexpectedly`, `soniox reconnect scheduled`, `transcription gap recorded` |
| Key or billing problems | `soniox error message` with `code` 401/402/403, `api key test failed` |
| Missing audio in the recording | `MediaRecorder error`, `save audio chunk failed`, `recorder stop timed out` |
| Volume / silence | `audio level (30s)` (`avgRms` 0 means silence), `track muted` |
| Microphone missing | `microphone unavailable` |
| Muted in the meeting but still transcribed, or never transcribed | `meeting mic state` (see `muted`, `signal`), `mic mute state`, `soniox paused`, `soniox resumed`, `soniox closing session while muted` |
| Language switch | `languages changed during meeting`, `soniox reconfigure` |
| Auto stop did not fire, or fired wrongly | `meeting presence` (see `signal`), `auto stop scheduled`, `auto stop cancelled`, `not in call yet` |
| Gap fill / re-transcription | `retranscribe`, `soniox async transcription failed`, `soniox file uploaded` |
| Export | `meeting exported`, `export failed`, `auto export failed` |

## Common issues

**The other side is silent in the recording (`them` `avgRms: 0`).**
Either nobody else spoke, the meeting tab itself was muted, or the wrong tab was captured. Check the warning `no audio from meeting tab for 60s`.

**Everything I say appears twice: as "me", and again as "them".**
Your speakers are feeding the microphone. Wear headphones.

**Captions are chopped into tiny pieces.**
Increase **断句等待** (endpoint delay) in options, for example to 1500–2000 ms. The default is 1000. Settings saved before that default existed and still at the old 500 are migrated to 1000 once.

**Recording does not stop after leaving the call.**
Look at the `meeting presence` lines. If `inCall` never became `true`, the hang-up button detection did not match. Meet or Teams may have changed their page, so open an issue with the log. As a workaround, stop manually.

**I muted myself in the meeting, but my speech is still transcribed (or I am not transcribed after unmuting).**
Look at the `meeting mic state` lines. `muted: null` means the mic button was not found, so MeetScribe treats you as unmuted. Meet or Teams may have changed their page; open an issue with the log. Muting only pauses live transcription: the "me" recording still contains everything, so a full re-transcription will include speech made while muted.

**My own speech is recognized poorly in a noisy room.**
Turn on **麦克风降噪** (mic noise suppression) in options. It is off by default because it can strip speech detail. It takes effect from the next meeting. The `track starting` log line shows the applied `settings.noiseSuppression`.

**"转写缺口" (gap) shown although nothing seemed missing.**
Gaps are stretches of audio that never reached Soniox (network drop, or no key). Click **补转缺口** (fill gaps) to transcribe them from the recording. Versions before the stop-race fix could report a 1–2 s gap at the very end; that one is harmless.

**Duplicate files such as `对方 (1).webm` in Downloads.**
That happened in older versions when exporting the same meeting twice. Exports now overwrite.

**All history disappeared.**
Uninstalling or removing the extension deletes its IndexedDB. Reloading it does not. Enable auto export to keep copies in Downloads.
