# Architecture

## Goals

1. Show live captions of a Meet or Teams call, with "me" and "them" separated.
2. **Never lose the meeting.** The local recording is independent of the network and the speech API.
3. Recover after the fact: fill transcription gaps from the recording.
4. No backend. Everything stays local except the audio sent to Soniox and, only with the user's OpenAI key, the transcript text sent to OpenAI for AI notes.

## Components

| Context | File | Lifetime | Responsibilities |
|---|---|---|---|
| Service worker | `src/background.js` | Event-driven; may be suspended | Start/stop, `tabCapture.getMediaStreamId`, offscreen lifecycle, session state (`chrome.storage.session`), auto stop, recovering stale meetings |
| Offscreen document | `src/offscreen/*` | One meeting | Owns the `MediaStream`s, `AudioContext`, recorders and Soniox WebSockets |
| Content script | `src/content/meeting-watch.js` | Meet/Teams tab | Reports in-call / left-call from the presence of the hang-up button, and the in-meeting mic mute state |
| Content script | `src/content/captions.js` | Recorded tab, injected while floating captions are on | Floating caption bar (Shadow DOM) |
| Popup | `src/popup/*` | While open | Choose languages, start/stop |
| Side panel | `src/sidepanel/*` | While open | Live captions, AI notes tab, floating-caption switch, status, levels, language switch, auto-stop countdown. Reopening it rebuilds everything from IndexedDB plus `offscreen:get-live` |
| History | `src/history/*` | Tab | List, search, synced playback, retranscribe, AI notes (write / rewrite), export, delete |
| Options | `src/options/*` | Tab | UI language, Soniox and OpenAI keys, languages, vocabulary, floating captions, notes model/language, microphone permission/device, auto stop/export, log level and export |

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

- Resampling (`lib/resampler.js`) runs a Blackman-windowed sinc low-pass (7.2 kHz cutoff, about 16 taps per unit of rate ratio, so 49 taps for 48k→16k), then interpolates linearly between filtered samples. This prevents content above 8 kHz from aliasing into the speech band, and it handles non-integer ratios such as 44.1k.
- Mic constraints: echo cancellation and auto gain are always on. Noise suppression is off by default (`micNoiseSuppression`), because browser NS removes speech detail that the recognizer could use.
- Soniox config: `max_endpoint_delay_ms` defaults to 1000. 500 is the minimum: it splits sentences and slightly lowers accuracy (Soniox's own default is 2000). `context.general` carries the meeting title as `topic`, unless the title is only a Meet code. `context.terms` carries the user vocabulary.
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
- **Latency (logs only).** Measured in audio time against `sentUpTo` of the current session: `finalMs` (a word's `end_ms` → it arrives final), `endpointMs` (last word of a sentence → `<end>`, includes `max_endpoint_delay_ms`), and, with translation on, `translationMs` (wall clock from `<end>` to the first final translation token). Each minute `soniox stats` carries `latency: { finalMs, endpointMs, translationMs }` as `{ n, p50, p95, max }`. An `<end>` more than 5 s after the last word logs `soniox slow finalization` (at most once a minute).
- **Timeline.** `onSessionStart(firstSample)` lets the track convert session-relative token times to meeting time: `pcmStartOffsetMs + firstSample / 16`.
- **Recording zero.** `tracks[source].startOffsetMs` is taken in `MediaRecorder.onstart`, not when `start()` is called. Some microphones (iPhone Continuity, Bluetooth) take seconds to deliver audio, and the file starts at the first audio, so the call time made playback run ahead of the captions (measured: 2.7 s). The PCM branch counts silence from the start, so caption times were right. Recordings made before this fix are corrected in History once the real file duration is known: `lastChunk.at − duration` (`correctedStartOffset()` in `timeline.js`), written back to the meeting.

## Transcript assembly (`transcript.js`)

- Final tokens accumulate into the current segment. They are committed on `<end>` or `<fin>`, on a speaker change, or when a new session starts.
- Non-final tokens are only shown as a grey "pending" tail.
- Translation tokens (`translation_status: 'translation'`) attach to the current segment, or, if they arrive late, to the last committed one (`onUpdate`).
- `tokensToSegments()` turns async results into segments. It splits on a speaker change, a pause longer than 1.5 s, or a sentence end once the segment is longer than 15 s. It can optionally keep only tokens that fall inside given gaps.

## Speakers (`speakers.js`)

Soniox speaker numbers are only valid inside one transcription session. A real-time reconnect, rotation or `reconfigure()` starts a new WebSocket session and the numbering starts over, and every async run has its own numbering. Soniox has no session resume and no voiceprints. So a segment stores a speaker key that includes the session, and names live on the meeting:

- `segment.speakerKey`: `rt<sessionNo>:<n>` (real time), `a<run>:<n>` (full re-transcription), `g<run>:<n>` (gap fill), `them` (other side without diarization). `me` segments have none. Segments recorded before this existed get a key derived from `speaker` and `origin` (`segmentKey()`).
- `meeting.speakers = { [key]: { name } | { alias: key } }`. `alias` means "same person as" (a merge). Names hang on the canonical key at the end of the alias chain. Segments are never rewritten.
- `buildSpeakerView()` lists the people in a meeting in order of first appearance. Unnamed people show as `对方 n` / `Speaker n`, where `n` is that order, not the Soniox number, so people from a new session get new numbers instead of reusing someone else's.
- One entry point for rename and merge (like Notta): click a speaker name in History or the side panel. Typing a name renames every line of that person. Typing the name of someone already in the meeting, or picking them from the list, merges the two. A merge always asks for confirmation inside the dialog first. The save itself re-checks names against the stored meeting and refuses an unconfirmed merge, because the dialog's speaker list can be stale (another page renamed someone). The merge button never takes focus, so the Enter that submitted the name cannot also confirm the merge. Pages broadcast `meeting:speakers` so other open pages relabel in place.
- After a full re-transcription, `inheritSpeakerNames()` carries names over by time overlap: a new speaker gets an old name only when they are each other's best match and the overlap covers at least 30 % of the new speaker's talk time. It never gives one name to two new speakers and never merges automatically. Keys that no segment uses any more are pruned. Gap-fill speakers do not overlap real-time segments, so they start unnamed and are merged by hand.

## After-meeting jobs (`retranscribe.js`, `soniox-async.js`)

```
chunks(source) ─► Blob(webm) ─► POST /v1/files ─► POST /v1/transcriptions
   ─► poll GET /v1/transcriptions/{id} ─► GET …/transcript ─► DELETE transcription + file
```

- `gaps`: keep only tokens inside the open gaps, append them as `origin: 'async'` segments, and mark the gaps `filled`.
- `full`: replace every segment of that source.
- Language hints come from the meeting (the initial ones plus every mid-meeting change, from `meeting.transcription`), not from the current default settings. The meeting title is passed as context, the same as in real time.
- Job ids are persisted in `meeting.jobs`, so a closed History tab can resume polling.
- Progress is shown per source in 4 steps: prepare / upload (percentage, via XHR because `fetch` has no upload progress), queued, transcribing (elapsed time; Soniox reports no percentage), save.

## AI notes (`notes.js`, `notes-runner.js`, `offscreen/live-notes.js`)

Optional; on when `settings.openaiApiKey` is set. Only text goes to OpenAI (Chat Completions, JSON mode, `reasoning_effort: low` for gpt-5 / o-series models).

```
offscreen: TrackPipeline hooks.onSaved(seg) ─► LiveNotes.newIds
  every 5 s: notesDue (first after 3 lines or 20 s, then every 60 s, only with new lines)
    └─► updateNotes(incremental): segments with id > notes.lastSegId (≤ 300 lines / 40k chars)
          prompt = current notes + 2 covered lines as context + new lines "L<segId> [mm:ss] Speaker: text"
                   + topic pacing: first update = one topic; current topic < 2 min old = no new topic
          reply → parseNotesReply: evidence ids → meeting ms; old items keep their times
                → keepEarlierTopics: topics the reply dropped are put back (log: notes reply dropped earlier topics)
                → writtenIn(language) check; bad reply / wrong language: retry once, else keep old notes
          meeting.notes = {…, lastSegId, language, model, updatedAt}; broadcast meeting:notes
SW stopRecording (key set) ─► offscreen stays open ─► offscreen:finish-notes
    waits for the running update, then updateNotes(final): whole transcript (≤ 150k chars) rewritten from scratch
    (at most one topic per 3 min of meeting, max 8),
    else incremental until covered; final = true; a meeting titled only by its Meet code takes the notes' title
    heartbeat meeting:notes every 15 s keeps the SW awake; then closeOffscreenIfIdle
```

- Why the guards: the model rewrites the whole notes each time and only sees the compact notes, not the early lines, so long meetings drifted to "only the second half". Prompt pacing keeps the topic count from hitting the cap early; `keepEarlierTopics` makes live notes never lose a topic. The final pass works from the full transcript.
- Segment ids are autoincrement, so "new" means `id > lastSegId`, which works across the two tracks committing out of order.
- Errors map to states (`notesErrorState`): `invalid-key`, `no-quota`, `model` (and `no-key`) stop live updates for this meeting; `rate-limited` / `failed` retry on the next interval. Recording and captions never wait on notes.
- If the SW is suspended during the final pass, the offscreen still finishes and saves. `recoverStaleMeetings` closes an offscreen that pings `{ active: false, busy: false }`; `closeOffscreenIfIdle` never closes one that is still finishing notes (a new meeting can start meanwhile and reuse it).
- After the meeting, the side panel and History can write or rewrite notes with `updateNotes(final)` from the page itself.
- Notes language: `settings.notesLanguage`, or the UI language. Changing it makes the next update start over.

## Floating captions (`captions.js`, `content/captions.js`)

```
offscreen: hooks.onPartial / onCommit / onUpdate ─► CaptionState (one row per source:
           previous committed sentence (≤ 20 s old) + live partial, else the last committed segment for 8 s;
           translation = recent committed translations joined; the bar keeps the last 2 lines, so the
           previous sentence scrolls out as new words arrive instead of vanishing)
           └─ while on: rt:caption {rows}, throttled to 200 ms, re-checked every 1 s for expiry
SW: rt:caption ─► chrome.tabs.sendMessage(active.tabId, cap:rows)
    on start / switch on / tab reload: executeScript(content/captions.js) + cap:show {labels}
content script: Shadow DOM bar, click-through text; grip to drag, A− / A+, × (= sw:set-captions false)
```

- Independent of the side panel: closing it does not affect the bar. It lives inside the meeting tab, so it is not visible from other tabs.
- The switch is `settings.floatingCaptions`, mirrored in `active.captions`; `meeting:captions` keeps the side panel checkbox in sync. When off, the offscreen sends nothing, so the SW is not woken up for captions.
- Position and font size are kept in `chrome.storage.local.captionBox`. Labels come translated from the SW, because content scripts cannot import the string table.

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

## UI language (i18n)

The extension pages (popup, side panel, history, options) are translated into Chinese, Japanese and English with an in-repo string table, not Chrome `_locales`, so the user can pick the language independently of the browser.

- `src/lib/strings.js`: one table per language (`zh`, `ja`, `en`). `zh` is the reference; `tests/i18n.test.mjs` fails if another language is missing a key or has different `{placeholders}`, or if a page uses a key that does not exist.
- `src/lib/i18n.js` (pure): `resolveUiLang(setting, navigator.languages)` picks the setting if supported, else the first supported browser language (base tag only, so `zh-TW` → `zh`), else `zh`. `t(key, params)` looks up the current language, then `zh`, then returns the key.
- `src/ui/i18n.js`: `initI18n()` reads `settings.uiLanguage` (`''` = follow browser), sets `<html lang>`, and fills elements marked `data-i18n` (text), `data-i18n-placeholder` and `data-i18n-title`. Each page awaits it at module top level before rendering. HTML keeps the Chinese text as a fallback; `<html data-i18n-pending>` hides the body until translation is done (CSS reveals it after 1 s regardless).
- Changing the language on the options page reloads that page. Other open pages switch the next time they open (the history page is not reloaded because it may be running a retranscription job).
- Not translated: program-level text is English, like logs. That covers `Error` messages thrown in `src/lib`, the service worker and the offscreen document (pages show them after a translated prefix, e.g. 开始失败：a meeting is already being recorded). Retranscription progress is structured (`{ step, fraction, elapsedMs }`) and translated by the History page. Exported files are English regardless of UI language: `transcript.md` (headings, `Me` / `Others` / `Speaker N`; names the user typed are written as typed) and `them.webm` / `me.webm`. The manifest description and shortcut description are localized separately with Chrome `_locales` (`extension/_locales/{en,zh_CN,ja}/messages.json`, `default_locale: en`, referenced as `__MSG_key__`). Chrome picks them from the browser language, not from the MeetScribe UI language setting. The name `MeetScribe` is not translated.

## Storage (IndexedDB `meetscribe`, v1)

| Store | Key | Fields |
|---|---|---|
| `meetings` | `id` (uuid) | `title, url, startedAt, endedAt, status ('recording'\|'done'\|'interrupted'), stopReason, notes (AI notes, see notes.js), tracks{them,me}{mimeType, chunks, bytes, startOffsetMs, pcmStartOffsetMs, seconds, transcription}, gaps[{source,startMs,endMs,reason,filled}], jobs[], transcription{enabled, model, languageHints, languageChanges[{atMs,from,languageHints}], translationTarget}, micError, exportPending, retranscribed, speakers{[speakerKey]: {name}\|{alias}}` |
| `segments` | auto | `meetingId (idx), source, speaker, speakerKey, language, startMs, endMs, text, translation, origin ('realtime'\|'async')` |
| `chunks` | auto | `meetingId (idx), source, seq, blob, size, at` |
| `logs` | auto | `ts (idx), level, ctx, msg, data, meetingId?, source?` — kept for 14 days, at most 50k entries |

`chrome.storage.local.settings` holds the user settings. `chrome.storage.session` holds `active` (the current recording), `presence` (the latest in-call state per tab) and `micStates` (the latest mic mute state per tab).

## Messages

All constants live in `src/lib/messages.js`.

- Commands to the service worker (`target: 'sw'`): `sw:start`, `sw:stop`, `sw:get-state`, `sw:set-languages`, `sw:cancel-auto-stop`, `sw:set-captions`.
- Commands to the offscreen document (`target: 'offscreen'`): `offscreen:start|stop|ping|get-live|set-languages|set-mic-muted|set-captions|notes-now|finish-notes`.
- SW → recorded tab (`chrome.tabs.sendMessage`): `cap:show`, `cap:rows`, `cap:hide`.
- Broadcasts: `rt:segment`, `rt:segment-update`, `rt:partial`, `rt:status`, `rt:levels`, `rt:languages`, `rt:track-ended`, `meeting:state`, `meeting:ended`, `meeting:auto-stop`, `meeting:speakers`, `meeting:notes`, `meeting:captions`, `rt:caption`, `rt:mic-muted`, `cs:presence`, `cs:mic`.

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
