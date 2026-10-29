# Architecture

## Goals

1. Show live captions of a Meet or Teams call, with "me" and "them" separated.
2. **Never lose the meeting.** The local recording is independent of the network and the speech API.
3. Recover after the fact: fill transcription gaps from the recording.
4. No backend. Everything stays local except the audio sent to Soniox.

## Components

| Context | File | Lifetime | Responsibilities |
|---|---|---|---|
| Service worker | `src/background.js` | Event-driven; may be suspended | Start/stop, `tabCapture.getMediaStreamId`, offscreen lifecycle, session state (`chrome.storage.session`), auto stop, recovering stale meetings |
| Offscreen document | `src/offscreen/*` | One meeting | Owns the `MediaStream`s, `AudioContext`, recorders and Soniox WebSockets |
| Content script | `src/content/meeting-watch.js` | Meet/Teams tab | Reports in-call / left-call from the presence of the hang-up button, and the in-meeting mic mute state |
| Popup | `src/popup/*` | While open | Choose languages, start/stop |
| Side panel | `src/sidepanel/*` | While open | Live captions, status, levels, language switch, auto-stop countdown |
| History | `src/history/*` | Tab | List, search, synced playback, retranscribe, export, delete |
| Options | `src/options/*` | Tab | Key, languages, vocabulary, microphone permission/device, auto stop/export, log level and export |

## Start sequence

```
popup click ──► sidePanel.open (sync, inside the user gesture)
           └──► SW: sw:start {tabId, languageHints}
                 1. ensure offscreen document (create + ping)
                 2. tabCapture.getMediaStreamId({targetTabId})
                 3. put meeting {id, startedAt, status:'recording', ...}
                 4. offscreen:start {meeting, streamId, settings}
                      getUserMedia(tab) → AudioContext → tab ► destination (playback)
                      TrackPipeline('them').start()
                      getUserMedia(mic) → TrackPipeline('me').start()  (failure = warn, continue)
                 5. inject content script (in case the tab predates the extension)
                 6. chrome.storage.session.active = {meetingId, tabId, seenInCall, ...}; badge REC
```

## Per-track pipeline (`track.js`)

```
MediaStream ─┬─► MediaRecorder(webm/opus 32 kbps, 5 s timeslice) ─► chunks store
             └─► AudioWorkletNode('pcm-worklet') ─► 100 ms Int16 @ 16 kHz + rms/peak
                    └─► SonioxRealtime.push(buf, startSample)
                           └─► tokens ─► TranscriptAssembler ─► segments store + broadcast
```

- The worklet output goes through a muted `GainNode` into `destination`, which makes sure the audio graph pulls it. The microphone is never played back.
- Levels are aggregated every 30 s into a log entry, plus a warning after 60 s of silence.

## Real-time client (`soniox-realtime.js`)

State machine (`STATUS` in `messages.js`):

```
connecting ──open──► live ──close──► reconnecting ──(backoff 1,2,4,8,15,30 s)──► connecting
     │                 │                                    ▲
     │                 ├─ error 400/401/402/403 ──► failed  │ (recording continues)
     │                 ├─ 290 min or reconfigure ──► rotate (send "", reconnect now)
     │                 ├─ setPaused(true) ──► paused (send silence) ──10 s──► send "", stay closed
     │                 │                         └─ setPaused(false) ──► live / reconnect now
     │                 └─ stop() ──► send "" ── wait finished/close (≤8 s) ──► closed
```

- **Buffer.** While not live, the last 10 s of PCM is kept and flushed on (re)connect.
- **Gaps.** The client tracks `sentUpTo`, the last sample handed to Soniox. When a new session starts after `sentUpTo`, or `stop()` happens with unsent audio, it calls `onGap(fromSample, toSample)`. Audio arriving after `stop()` is ignored, so it is not reported as a gap.
- **Mute.** Soniox bills real-time by stream duration, not by audio sent, so keepalive alone saves nothing. While muted, the client sends zeros in place of the mic audio for a 10 s grace period, which keeps the timeline continuous across short mutes. After that it ends the stream. Unmuting opens a new session, with audio buffered meanwhile. Muted audio is never reported as a gap. The recorder branch is unaffected, so the recording still contains it.
- **Timeline.** `onSessionStart(firstSample)` lets the track convert session-relative token times to meeting time: `pcmStartOffsetMs + firstSample / 16`.

## Transcript assembly (`transcript.js`)

- Final tokens accumulate into the current segment. They are committed on `<end>` or `<fin>`, on a speaker change, or when a new session starts.
- Non-final tokens are only shown as a grey "pending" tail.
- Translation tokens (`translation_status: 'translation'`) attach to the current segment, or, if they arrive late, to the last committed one (`onUpdate`).
- `tokensToSegments()` turns async results into segments. It splits on a speaker change, a pause longer than 1.5 s, or a sentence end once the segment is longer than 15 s. It can optionally keep only tokens that fall inside given gaps.

## After-meeting jobs (`retranscribe.js`, `soniox-async.js`)

```
chunks(source) ─► Blob(webm) ─► POST /v1/files ─► POST /v1/transcriptions
   ─► poll GET /v1/transcriptions/{id} ─► GET …/transcript ─► DELETE transcription + file
```

- `gaps`: keep only tokens inside the open gaps, append them as `origin: 'async'` segments, and mark the gaps `filled`.
- `full`: replace every segment of that source.
- Job ids are persisted in `meeting.jobs`, so a closed History tab can resume polling.

## Auto stop

```
content script: hang-up button present?  (poll 2 s; "left" needs 2 consecutive misses)
   └─► SW cs:presence {inCall}
         inCall=true  → active.seenInCall = true; cancel any countdown
         inCall=false → if seenInCall && !suppressed && settings.autoStopOnLeave:
                          active.autoStopDeadline = now + N s; badge END; broadcast meeting:auto-stop
                          timer → stopRecording('left-meeting')
side panel "继续录制" (continue recording) → sw:cancel-auto-stop → suppressed until the next in-call → left transition
tab navigates to another host → same as left (if seenInCall)
```

The timer is re-armed from `autoStopDeadline` when the service worker wakes up.

## Mic mute

```
content script: mic button state  (poll 500 ms; "unknown" needs ~2 s of misses)
   └─► SW cs:mic {muted: true|false|null}  → chrome.storage.session.micStates[tabId]
         recording this tab → offscreen:set-mic-muted → pipelines.me.setMuted → SonioxRealtime.setPaused
                              broadcast rt:mic-muted → side panel shows 已静音 and greys the "me" level bar
```

`null` (button not found) means "not muted", so transcription keeps going if detection breaks. The state is passed in `offscreen:start` and synced again right after start.

Signals used: Meet, the `[data-is-muted]` element whose icon text is `mic`/`mic_off` or whose `aria-label` names the microphone (the camera button also has `data-is-muted`). Teams, `#microphone-button` `data-state` (`mic` / `mic-off`).

Signals used: Meet `[jsname="CQylAd"]` or a leaf element inside a button whose text is `call_end` (Material icon). Teams `#hangup-button` or `data-tid*="hangup"`. These are language-independent, but they depend on how Meet and Teams build their pages.

## Storage (IndexedDB `meetscribe`, v1)

| Store | Key | Fields |
|---|---|---|
| `meetings` | `id` (uuid) | `title, url, startedAt, endedAt, status ('recording'\|'done'\|'interrupted'), stopReason, tracks{them,me}{mimeType, chunks, bytes, startOffsetMs, pcmStartOffsetMs, seconds, transcription}, gaps[{source,startMs,endMs,reason,filled}], jobs[], transcription{enabled, model, languageHints, languageChanges[{atMs,from,languageHints}], translationTarget}, micError, exportPending, retranscribed` |
| `segments` | auto | `meetingId (idx), source, speaker, language, startMs, endMs, text, translation, origin ('realtime'\|'async')` |
| `chunks` | auto | `meetingId (idx), source, seq, blob, size, at` |
| `logs` | auto | `ts (idx), level, ctx, msg, data, meetingId?, source?` — kept for 14 days, at most 50k entries |

`chrome.storage.local.settings` holds the user settings. `chrome.storage.session` holds `active` (the current recording), `presence` (the latest in-call state per tab) and `micStates` (the latest mic mute state per tab).

## Messages

All constants live in `src/lib/messages.js`.

- Commands to the service worker (`target: 'sw'`): `sw:start`, `sw:stop`, `sw:get-state`, `sw:set-languages`, `sw:cancel-auto-stop`.
- Commands to the offscreen document (`target: 'offscreen'`): `offscreen:start|stop|ping|get-live|set-languages|set-mic-muted`.
- Broadcasts: `rt:segment`, `rt:segment-update`, `rt:partial`, `rt:status`, `rt:levels`, `rt:languages`, `rt:track-ended`, `meeting:state`, `meeting:ended`, `meeting:auto-stop`, `rt:mic-muted`, `cs:presence`, `cs:mic`.

## Failure handling summary

| Failure | Behavior |
|---|---|
| Soniox network drop | Reconnect with backoff; buffer up to 10 s; longer outages become gaps that can be filled later |
| Invalid key or no credit | `failed` status; recording continues; the side panel shows an error |
| No key | Record only; the whole meeting becomes a gap; use full re-transcription later |
| Microphone denied or unavailable | Record the meeting tab only; `meeting.micError` |
| Tab closed or capture ended | Stop automatically |
| User leaves the call | Countdown, then stop (can be cancelled) |
| Offscreen crash or browser restart | The meeting is marked `interrupted`; saved chunks stay playable and can be transcribed |
| Extension uninstalled | **All data is lost.** Mitigation: auto export to Downloads |
