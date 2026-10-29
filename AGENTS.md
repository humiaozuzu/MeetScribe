# AGENTS.md

Guidance for AI coding agents and human contributors working on this repository.

## Project in one paragraph

MeetScribe is a Manifest V3 Chrome extension. It captures a Google Meet or Microsoft Teams tab plus the microphone and saves both locally (MediaRecorder → IndexedDB). It also streams 16 kHz PCM to Soniox real-time speech-to-text over WebSocket and shows live captions in the side panel. After a meeting, the user can fill transcription gaps or re-transcribe the recording with the Soniox async API. There is no backend: the user brings their own Soniox key. Design rationale is in `docs/architecture.md`.

## Commands

```bash
npm test
```

```bash
npm run check
```

`npm test` runs the unit tests (`node:test`, zero dependencies, Node 20+). `npm run check` runs `node --check` on every file in `extension/src`.

There is no build step, bundler or npm dependency. To try a change, load `extension/` unpacked in `chrome://extensions` and click reload after each edit. Run both commands above before finishing any change.

## Layout

```
extension/
  manifest.json                default_locale en; description strings in _locales/{en,zh_CN,ja}/messages.json
  src/background.js            service worker: start/stop, offscreen lifecycle, auto stop, state in chrome.storage.session
  src/offscreen/               hidden document that owns all audio + WebSockets
    offscreen.js               session orchestration (one meeting at a time)
    track.js                   one audio source: recorder branch + PCM/transcription branch
    pcm-worklet.js             AudioWorklet: downmix, resample to 16 kHz (lib/resampler.js), Int16, levels
  src/content/meeting-watch.js content script: "is the user in a call?" (hang-up button present)
  src/lib/
    soniox-realtime.js         WS client: reconnect, 10 s buffer, gap reporting, rotation, reconfigure
    soniox-async.js            REST: upload → transcribe → poll → fetch → delete
    transcript.js              token → segment assembly (pure, unit-tested)
    retranscribe.js            after-meeting gap fill / full re-transcription
    resampler.js               streaming low-pass + resample (pure, used by the worklet)
    db.js                      IndexedDB stores: meetings, segments, chunks, logs
    log.js                     structured logger (console + IndexedDB), export as JSONL
    messages.js                every message type / status constant
    i18n.js, strings.js        UI language resolution + t(); string tables for zh / ja / en
    settings.js, format.js, exporter.js
  src/popup/ sidepanel/ history/ options/   UI pages (plain HTML + ES modules)
  src/ui/                      shared CSS and DOM helpers
tests/                         node:test unit tests
docs/                          architecture and troubleshooting
```

## Conventions

- **Plain ES modules, no framework, no dependencies.** Keep it that way unless there is a strong reason. The content script is the exception: Chrome loads content scripts as classic scripts, so `meeting-watch.js` cannot `import` and guards against double injection with `window.__meetscribeWatch`.
- **UI strings go through i18n.** Pages support Chinese, Japanese and English (setting `uiLanguage`, `''` = follow the browser, fallback Chinese). Add every new UI string to all three tables in `src/lib/strings.js` and use it via `t('key', { params })` in JS or `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` in HTML (keep the Chinese text in the HTML as fallback). Pages call `await initI18n(log)` from `src/ui/i18n.js` before rendering. `npm test` checks that all languages have the same keys and placeholders. Code comments are mostly Chinese; match the surrounding file. Log messages, identifiers, thrown `Error` messages and other program-level text (status/progress from `src/lib`, the service worker and offscreen) are English, so logs are greppable; pages add a translated prefix when they show them. See "UI language" in `docs/architecture.md`.
- **Message types live in `src/lib/messages.js`.** Add new ones there, never as string literals elsewhere. Commands carry `target: 'sw'` or `target: 'offscreen'`. Every `onMessage` listener must return `false` for messages it does not handle, or it will swallow other listeners' responses.
- **Pure logic goes in `src/lib/` with a unit test.** Anything that can run without Chrome APIs (token assembly, time math, formatting, reconnection/gap logic with a fake WebSocket) should be testable from Node.
- **Recording must never depend on the network.** Any change to the transcription path must keep the MediaRecorder branch independent and unaffected.
- **Timeline.** All segment and gap times are milliseconds from `meeting.startedAt` ("meeting ms"). Real-time token times are relative to the current WebSocket session and converted with the session's first sample index (`samplesToMeetingMs`). Async token times are relative to the recording file, whose zero is `tracks[source].startOffsetMs`.

## Logging (important)

The user debugs by sending exported logs plus a description of the problem, so logs are part of the product.

- Use `createLogger(ctx)` from `src/lib/log.js`. Use `log.child({ meetingId, source })` inside a meeting so every entry can be filtered.
- Log state transitions, external I/O (WebSocket open/close codes, HTTP status, Soniox `error_code`/`error_message`) and every caught error with context. Do not log per-chunk events at `info`; use `debug` or periodic aggregates (see `soniox stats` and `audio level (30s)`).
- Never log secrets. `sanitize()` masks keys named like `api_key`, `sonioxApiKey` or `authorization`. Use `redactSettings()` when logging settings.
- The content script cannot write to the extension's IndexedDB. It reports to the service worker, and the service worker logs (see `meeting presence`).
- When you add a new failure mode, add its log keyword to `docs/troubleshooting.md`.

When you receive an exported `.jsonl` log: the first line is a header with the meeting record and redacted settings. Each later line is `{ ts, t, level, ctx, msg, data, meetingId?, source? }`. Read it as a timeline and compare it against the state machine in `docs/architecture.md`.

## Chrome extension gotchas

- `chrome.tabCapture.getMediaStreamId` only works after the user invokes the extension on that tab (toolbar click or keyboard command). Buttons injected into the page and notifications do not count. That is why auto-start is not possible.
- The stream id expires quickly. Create the offscreen document first, then get the id and hand it over immediately.
- A captured tab is muted for the user. The offscreen document must connect the tab source to `AudioContext.destination`.
- Offscreen documents only have `chrome.runtime`. There is no `chrome.storage`, `tabs` or `downloads`. Settings are passed in by the service worker. Downloads happen from extension pages (side panel or history), which also own Blob URLs.
- The offscreen document cannot show a microphone permission prompt. The user grants it once on the options page.
- `chrome.sidePanel.open` must be called synchronously inside a user gesture, before any `await`.
- The service worker can be suspended at any time. Keep durable state in `chrome.storage.session` or IndexedDB, not module variables. Timers are re-armed on wake (see the auto-stop deadline).
- The `AudioContext` sample rate follows the output device and can be 16 kHz (for example on Bluetooth headsets). The worklet resamples from whatever rate it gets.

## Soniox specifics

- Real-time endpoint: `wss://stt-rt.soniox.com/transcribe-websocket`. Model: `stt-rt-v5`. Async model: `stt-async-v5`.
- Authenticate with WebSocket subprotocols `['soniox-api-key', KEY]`. Never put `api_key` in the config JSON; that is deprecated and will be refused from 2027-01-15.
- A bad key still opens the socket. The error arrives as a JSON frame (`error_code`), then the server closes. Errors 400, 401, 402 and 403 are fatal: stop retrying and keep recording.
- Final tokens are sent once; non-final tokens are replaced on every response. `<end>` marks an endpoint and `<fin>` marks a manual finalize.
- The config cannot be changed mid-stream. `SonioxRealtime.reconfigure()` opens a new session, with audio buffered in between.
- Limits: 300 min per stream (the client rotates at 290), keepalive at least every 20 s when idle, 10 concurrent streams by default.
- Docs: https://soniox.com/docs/stt/get-started

## Do not

- Do not add a backend, analytics or any network call other than Soniox.
- Do not commit API keys, recordings, exported logs, or third-party extension packages (`*.crx`).
- Do not make recording conditional on transcription succeeding.
