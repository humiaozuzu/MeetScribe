// Offscreen 文档：一场会议期间常驻，负责抓音频、回放、录音、实时转写。
// 只有 chrome.runtime 可用（没有 chrome.storage / tabs），设置由 SW 在 start 时传入。

import { updateMeeting } from '../lib/db.js';
import { createLogger, installGlobalErrorHandlers, setLogLevel, flushLogs } from '../lib/log.js';
import { EVT, OFFSCREEN, STATUS, broadcast } from '../lib/messages.js';
import { mergeGaps } from '../lib/transcript.js';
import { TrackPipeline } from './track.js';
import { LiveNotes } from './live-notes.js';
import { CaptionState } from '../lib/captions.js';

const baseLog = createLogger('offscreen');
installGlobalErrorHandlers(baseLog);
baseLog.info('offscreen document loaded');

let session = null; // { meeting, ctx, pipelines: { them, me }, gaps, log, levelTimer, captions }
// 会议结束后 AI 纪要还要再整理一次，比 session 活得久：meetingId → LiveNotes
const notesByMeeting = new Map();
let finishingNotes = 0;

const CAPTION_THROTTLE_MS = 200;
const CAPTION_EXPIRE_CHECK_MS = 1000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const handlers = {
    [OFFSCREEN.PING]: async () => ({ ok: true, active: !!session, busy: finishingNotes > 0 }),
    [OFFSCREEN.START]: () => start(msg),
    [OFFSCREEN.STOP]: () => stop(msg.reason),
    [OFFSCREEN.GET_LIVE]: async () => getLive(),
    [OFFSCREEN.SET_LANGUAGES]: () => setLanguages(msg.languageHints),
    [OFFSCREEN.SET_MIC_MUTED]: async () => setMicMuted(msg.muted, msg.signal),
    [OFFSCREEN.SET_CAPTIONS]: async () => setCaptions(msg.enabled),
    [OFFSCREEN.NOTES_NOW]: async () => notesNow(),
    [OFFSCREEN.FINISH_NOTES]: () => finishNotes(msg.meetingId),
  };
  const h = handlers[msg.type];
  if (!h) return false;
  h().then(sendResponse, (e) => {
    baseLog.error(`handler ${msg.type} failed`, e);
    sendResponse({ ok: false, error: String(e?.message || e) });
  });
  return true;
});

async function start({ meeting, streamId, settings, micMuted }) {
  if (session) throw new Error('already recording');
  setLogLevel(settings.logLevel);
  const log = baseLog.child({ meetingId: meeting.id });
  log.info('start requested', { title: meeting.title, url: meeting.url, recordMic: settings.recordMic, hasKey: !!settings.sonioxApiKey });

  // 1. 会议标签页音频
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (e) {
    log.error('tab audio capture failed', { name: e.name, message: e.message });
    throw new Error(`tab audio capture failed: ${e.name} ${e.message}`);
  }

  const ctx = new AudioContext();
  ctx.onstatechange = () => log.info('AudioContext state', { state: ctx.state });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch (e) { log.warn('AudioContext resume failed', e); }
  }
  log.info('AudioContext ready', { sampleRate: ctx.sampleRate, state: ctx.state, baseLatency: ctx.baseLatency });

  // 2. 把会议声音放回扬声器（被捕获的标签页默认会静音）
  const playback = ctx.createMediaStreamSource(tabStream);
  playback.connect(ctx.destination);

  session = { meeting, ctx, playback, pipelines: {}, gaps: [], log, settings, micMuted: micMuted ?? null };

  // AI 纪要：填了 OpenAI key 才有。只读写文字，和录音、转写互不影响。
  if (settings.openaiApiKey) {
    session.notes = new LiveNotes({ meetingId: meeting.id, settings, log, notes: null });
    notesByMeeting.set(meeting.id, session.notes);
    session.notes.start();
  }
  setCaptions(!!settings.floatingCaptions);
  const hooks = trackHooks(session);

  const onGap = (gap) => {
    log.warn('transcription gap recorded', gap);
    session.gaps.push(gap);
    persistGaps();
  };

  const tabTrack = tabStream.getAudioTracks()[0];
  tabTrack.addEventListener('ended', () => {
    log.warn('tab audio track ended (tab closed or capture revoked)');
    broadcast({ type: EVT.TRACK_ENDED, meetingId: meeting.id, source: 'them' });
  });

  session.pipelines.them = new TrackPipeline({ source: 'them', stream: tabStream, ctx, meeting, settings, log, onGap, hooks: hooks('them') });
  await session.pipelines.them.start();

  // 3. 麦克风（失败不影响对方那一路）
  let micError = null;
  if (settings.recordMic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: !!settings.micNoiseSuppression,
          autoGainControl: true,
        },
      });
      session.pipelines.me = new TrackPipeline({ source: 'me', stream: micStream, ctx, meeting, settings, log, onGap, hooks: hooks('me') });
      session.pipelines.me.setMuted(session.micMuted === true);
      await session.pipelines.me.start();
    } catch (e) {
      micError = `${e.name}: ${e.message}`;
      log.warn('microphone unavailable — only the meeting tab will be recorded', { name: e.name, message: e.message });
      broadcast({ type: EVT.STATUS, meetingId: meeting.id, source: 'me', status: STATUS.OFF, detail: { reason: 'mic-unavailable', error: micError } });
    }
  }

  session.levelTimer = setInterval(() => {
    broadcast({ type: EVT.LEVELS, meetingId: meeting.id, levels: levels() });
  }, 500);

  await updateMeeting(meeting.id, (m) => {
    m.micError = micError;
    m.tracks = trackSummaries();
  }).catch((e) => log.error('update meeting failed', e));

  log.info('recording started', { tracks: Object.keys(session.pipelines), micError, micMuted: session.micMuted });
  return { ok: true, micError };
}

function levels() {
  const out = {};
  for (const [k, p] of Object.entries(session?.pipelines || {})) out[k] = p.level;
  return out;
}

function trackSummaries() {
  const out = {};
  for (const [k, p] of Object.entries(session.pipelines)) out[k] = p.summary();
  return out;
}

let gapSaveChain = Promise.resolve();
function persistGaps() {
  const s = session;
  if (!s) return;
  gapSaveChain = gapSaveChain.then(() => updateMeeting(s.meeting.id, (m) => {
    m.gaps = mergeGaps(s.gaps);
  })).catch((e) => s.log.error('persist gaps failed', e));
}

async function stop(reason = 'user') {
  if (!session) return { ok: true, alreadyStopped: true };
  const s = session;
  const { log } = s;
  log.info('stop requested', { reason });
  clearInterval(s.levelTimer);
  s.notes?.stopTimer();
  stopCaptionFeed(s);

  const results = await Promise.allSettled(Object.values(s.pipelines).map((p) => p.stop()));
  results.forEach((r) => { if (r.status === 'rejected') log.error('pipeline stop failed', r.reason); });

  try { s.playback.disconnect(); } catch {}
  try { await s.ctx.close(); } catch (e) { log.warn('AudioContext close failed', e); }

  await gapSaveChain;
  const endedAt = Date.now();
  const meeting = await updateMeeting(s.meeting.id, (m) => {
    m.endedAt = endedAt;
    m.status = 'done';
    m.stopReason = reason;
    m.tracks = trackSummaries();
    m.gaps = mergeGaps(s.gaps);
  }).catch((e) => { log.error('finalize meeting failed', e); return null; });

  log.info('recording stopped', {
    durationMs: endedAt - s.meeting.startedAt,
    tracks: meeting?.tracks,
    gaps: meeting?.gaps,
  });
  session = null;
  await flushLogs();
  return { ok: true };
}

async function setLanguages(languageHints) {
  if (!session) return { ok: false, error: 'not recording' };
  const s = session;
  const atMs = Date.now() - s.meeting.startedAt;
  const from = s.settings.languageHints;
  s.log.info('languages changed during meeting', { languageHints, atMs, from });
  s.settings = { ...s.settings, languageHints };
  for (const p of Object.values(s.pipelines)) p.setLanguages(languageHints);
  await updateMeeting(s.meeting.id, (m) => {
    m.transcription = { ...(m.transcription || {}), languageHints };
    m.transcription.languageChanges = [...(m.transcription.languageChanges || []), { atMs, from, languageHints }];
  }).catch((e) => s.log.error('save language change failed', e));
  broadcast({ type: EVT.LANGUAGES, meetingId: s.meeting.id, languageHints });
  return { ok: true };
}

// 内容脚本检测到的会议内麦克风静音状态（经 SW 转发）。null = 检测不到，按未静音处理。
function setMicMuted(muted, signal) {
  if (!session) return { ok: false, error: 'not recording' };
  const s = session;
  if (s.micMuted === muted) return { ok: true };
  s.micMuted = muted;
  s.log.info('mic mute state', { muted, signal, atMs: Date.now() - s.meeting.startedAt });
  s.pipelines.me?.setMuted(muted === true);
  broadcast({ type: EVT.MIC_MUTED, meetingId: s.meeting.id, muted });
  return { ok: true };
}

// ---------- 悬浮字幕 ----------
// 每路音频的实时行 / 刚定稿的片段 → CaptionState → 节流后广播 rt:caption，SW 转发给会议标签页。
// 关着的时候什么都不发（不然 SW 会被每 200ms 一条消息一直叫醒）。

function trackHooks(s) {
  return (source) => ({
    onPartial: (p) => captionChanged(s, () => s.captionState.partial(source, p, Date.now())),
    onCommit: (seg) => captionChanged(s, () => s.captionState.commit(source, seg, Date.now())),
    onUpdate: (seg) => captionChanged(s, () => s.captionState.update(source, seg, Date.now())),
    onSaved: (seg) => s.notes?.onSaved(seg),
  });
}

function captionChanged(s, apply) {
  apply();
  if (!s.captionsOn || s.captionTimer) return;
  s.captionTimer = setTimeout(() => { s.captionTimer = null; sendCaptions(s); }, CAPTION_THROTTLE_MS);
}

function sendCaptions(s) {
  const rows = s.captionState.rows(Date.now());
  const key = JSON.stringify(rows);
  if (key === s.captionSent) return;
  s.captionSent = key;
  broadcast({ type: EVT.CAPTION, meetingId: s.meeting.id, rows });
}

function setCaptions(enabled) {
  const s = session;
  if (!s) return { ok: false, error: 'not recording' };
  s.captionState ||= new CaptionState();
  if (enabled === !!s.captionsOn) return { ok: true };
  s.log.info('floating captions', { enabled });
  stopCaptionFeed(s);
  s.captionsOn = enabled;
  if (enabled) {
    s.captionSent = null;
    // 定稿片段过一会儿要从字幕条上消失，没有新消息时也得检查
    s.captionExpire = setInterval(() => sendCaptions(s), CAPTION_EXPIRE_CHECK_MS);
    sendCaptions(s);
  }
  return { ok: true };
}

function stopCaptionFeed(s) {
  s.captionsOn = false;
  clearTimeout(s.captionTimer);
  clearInterval(s.captionExpire);
  s.captionTimer = null;
  s.captionExpire = null;
}

// ---------- AI 纪要 ----------

function notesNow() {
  if (!session?.notes) return { ok: false, error: session ? 'notes not enabled (no OpenAI key)' : 'not recording' };
  return session.notes.updateNow();
}

// 会议结束后（session 已经清掉）整理完整纪要。SW 等这个返回后才关 offscreen。
async function finishNotes(meetingId) {
  const notes = notesByMeeting.get(meetingId);
  if (!notes) return { ok: true, skipped: 'no-notes' };
  finishingNotes++;
  try {
    return await notes.finish();
  } finally {
    finishingNotes--;
    notesByMeeting.delete(meetingId);
    await flushLogs();
  }
}

function getLive() {
  if (!session) return { ok: true, active: false };
  const live = {
    ok: true, active: true, meetingId: session.meeting.id, languageHints: session.settings.languageHints, micMuted: session.micMuted, sources: {},
    notes: session.notes ? { state: session.notes.state, error: session.notes.error } : null,
    captions: !!session.captionsOn,
  };
  for (const [k, p] of Object.entries(session.pipelines)) {
    live.sources[k] = { status: p.status, detail: p.statusDetail, partial: p.partial, level: p.level };
  }
  return live;
}
