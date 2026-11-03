// Service Worker：调度中心。只做开始/停止、拿标签页流 ID、管理 offscreen 生命周期，
// 不持有任何音频或连接（SW 随时可能被挂起）。当前会话状态存在 chrome.storage.session。

import { putMeeting, listMeetings, updateMeeting, getChunks, deleteMeeting } from './lib/db.js';
import { createLogger, installGlobalErrorHandlers, pruneOldLogs, flushLogs } from './lib/log.js';
import { EVT, OFFSCREEN, SW, CAPTION, broadcast } from './lib/messages.js';
import { getSettings, saveSettings, redactSettings } from './lib/settings.js';
import { SONIOX_RT_MODEL } from './lib/soniox-realtime.js';
import { cleanTitle } from './lib/format.js';
import { resolveUiLang, setUiLang, t } from './lib/i18n.js';

const log = createLogger('sw');
installGlobalErrorHandlers(log);

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let busy = null; // 防止重复开始/停止

// ---------- 状态 ----------

async function getState() {
  const { active } = await chrome.storage.session.get('active');
  return { active: active || null };
}

// 只更新会话字段，不广播（用于自动停止等内部状态）
async function patchActive(patch) {
  const { active } = await getState();
  if (!active) return null;
  const next = { ...active, ...patch };
  await chrome.storage.session.set({ active: next });
  return next;
}

async function setActive(active) {
  await chrome.storage.session.set({ active });
  await chrome.action.setBadgeText({ text: active ? 'REC' : '' });
  if (active) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  broadcast({ type: EVT.MEETING_STATE, active });
}

// ---------- offscreen ----------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (!(await hasOffscreen())) {
    log.info('creating offscreen document');
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture meeting tab and microphone audio for local recording and live transcription',
    });
  }
  for (let i = 0; i < 40; i++) {
    const res = await sendToOffscreen({ type: OFFSCREEN.PING }, 500).catch(() => null);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('offscreen document did not respond');
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch((e) => log.warn('close offscreen failed', e));
    log.info('offscreen document closed');
  }
}

// 上一场的完整纪要可能还在 offscreen 里整理，不要把它关掉
async function closeOffscreenIfIdle() {
  if (!(await hasOffscreen())) return;
  const res = await sendToOffscreen({ type: OFFSCREEN.PING }, 2000).catch(() => null);
  if (res?.busy || res?.active) {
    log.info('offscreen kept open', { active: res.active, busy: res.busy });
    return;
  }
  await closeOffscreen();
}

function sendToOffscreen(msg, timeoutMs = 15000) {
  return Promise.race([
    chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`offscreen ${msg.type} timeout`)), timeoutMs)),
  ]);
}

// ---------- 开始 / 停止 ----------

async function startRecording(tabId, languageHints) {
  if (busy) throw new Error('previous start/stop still in progress');
  const { active } = await getState();
  if (active) throw new Error('a meeting is already being recorded');
  busy = 'starting';
  let meeting = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const settings = await getSettings();
    if (Array.isArray(languageHints)) settings.languageHints = languageHints;
    log.info('start recording', { tabId, url: tab.url, title: tab.title, settings: redactSettings(settings) });

    await ensureOffscreen();
    // 流 ID 很快会过期，拿到后立刻交给 offscreen 使用
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    log.info('got tab media stream id');

    meeting = {
      id: crypto.randomUUID(),
      title: cleanTitle(tab.title),
      url: tab.url,
      startedAt: Date.now(),
      status: 'recording',
      tracks: {},
      gaps: [],
      jobs: [],
      transcription: {
        enabled: !!settings.sonioxApiKey,
        model: SONIOX_RT_MODEL,
        languageHints: settings.languageHints,
        languageChanges: [],
        translationTarget: settings.translationTarget || null,
      },
    };
    await putMeeting(meeting);

    const micMuted = (await getMicStates())[tabId]?.muted ?? null;
    const res = await sendToOffscreen({ type: OFFSCREEN.START, meeting, streamId, settings, micMuted });
    if (!res?.ok) throw new Error(res?.error || 'offscreen start failed');

    // 内容脚本可能在扩展重载前就打开的页面里不存在，补注入一次（非 Meet/Teams 页面会失败，忽略）
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/meeting-watch.js'] })
      .catch((e) => log.debug('inject meeting watcher skipped', { error: e.message }));
    const presence = (await getPresence())[tabId];
    let host = '';
    try { host = new URL(tab.url).hostname; } catch {}
    await setActive({
      meetingId: meeting.id, tabId, title: meeting.title, startedAt: meeting.startedAt, micError: res.micError || null,
      host, seenInCall: presence?.inCall === true, autoStopDeadline: null, autoStopSuppressed: false,
      captions: !!settings.floatingCaptions,
    });
    if (settings.floatingCaptions) await showCaptions(tabId, meeting.id);
    // 开始期间静音状态可能变了（那时还不算"录制中"，没有转发）
    const latestMuted = (await getMicStates())[tabId]?.muted ?? null;
    if (latestMuted !== micMuted) await sendToOffscreen({ type: OFFSCREEN.SET_MIC_MUTED, muted: latestMuted, signal: 'sync-after-start' }).catch((e) => log.warn('sync mic muted failed', e));
    log.info('recording active', { meetingId: meeting.id, micError: res.micError });
    return { ok: true, meetingId: meeting.id, micError: res.micError || null };
  } catch (e) {
    log.error('start recording failed', { error: e, meetingId: meeting?.id });
    await sendToOffscreen({ type: OFFSCREEN.STOP, reason: 'start-failed' }).catch(() => {});
    await closeOffscreenIfIdle();
    if (meeting) {
      // 没录到任何东西就删掉，录到了就保留
      const chunks = await getChunks(meeting.id).catch(() => []);
      if (!chunks.length) await deleteMeeting(meeting.id).catch(() => {});
      else await updateMeeting(meeting.id, (m) => { m.status = 'interrupted'; m.endedAt = Date.now(); }).catch(() => {});
    }
    throw e;
  } finally {
    busy = null;
    flushLogs();
  }
}

async function stopRecording(reason) {
  const { active } = await getState();
  if (!active) return { ok: true, alreadyStopped: true };
  if (busy === 'stopping') return { ok: true, inProgress: true };
  busy = 'stopping';
  let finalizeNotes = false;
  clearTimeout(autoStopTimer);
  log.info('stop recording', { reason, meetingId: active.meetingId });
  try {
    try {
      const res = await sendToOffscreen({ type: OFFSCREEN.STOP, reason }, 30000);
      if (!res?.ok) log.error('offscreen stop returned error', res);
    } catch (e) {
      log.error('offscreen stop failed', e);
      await updateMeeting(active.meetingId, (m) => {
        if (m.status === 'recording') { m.status = 'interrupted'; m.endedAt = Date.now(); }
      }).catch(() => {});
    }
    if (active.captions) hideCaptions(active.tabId);
    const settings = await getSettings();
    // 填了 OpenAI key：offscreen 还要整理完整纪要，做完再关（见 finishNotesThenClose）
    finalizeNotes = !!settings.openaiApiKey;
    if (!finalizeNotes) await closeOffscreen();
    if (settings.autoExport) {
      await updateMeeting(active.meetingId, (m) => { m.exportPending = true; }).catch((e) => log.warn('mark exportPending failed', e));
    }
    await setActive(null);
    broadcast({ type: EVT.MEETING_ENDED, meetingId: active.meetingId });
    return { ok: true, meetingId: active.meetingId };
  } finally {
    busy = null;
    flushLogs();
    // 不阻塞停止：这期间可以开始下一场会议（offscreen 会被复用，不会被关掉）
    if (finalizeNotes) finishNotesThenClose(active.meetingId);
  }
}

// 会后完整纪要：可能要一两分钟。offscreen 期间每 15 秒广播一次状态，SW 收到消息不会被挂起；
// 万一 SW 还是被挂起了，offscreen 照样做完并保存，下次唤醒时 recoverStaleMeetings 会关掉空闲的 offscreen。
async function finishNotesThenClose(meetingId) {
  try {
    const res = await sendToOffscreen({ type: OFFSCREEN.FINISH_NOTES, meetingId }, 10 * 60_000);
    log.info('final notes finished', { meetingId, ...res });
  } catch (e) {
    log.error('final notes failed', { meetingId, error: e });
  }
  const { active } = await getState();
  if (!active && !busy) await closeOffscreenIfIdle();
  flushLogs();
}

// ---------- 悬浮字幕 ----------
// offscreen 广播 rt:caption（只有开着时才发），这里转发给录制中的标签页里的 content/captions.js。
// 字幕条和侧边栏无关：关掉侧边栏，字幕条照常显示。

let captionTab = null; // { meetingId, tabId }：SW 被挂起后为空，下次从 storage.session 取

async function captionLabels() {
  const settings = await getSettings();
  setUiLang(resolveUiLang(settings.uiLanguage, navigator.languages));
  return {
    me: t('common.me'),
    them: t('common.them'),
    labels: { drag: t('cap.drag'), smaller: t('cap.smaller'), bigger: t('cap.bigger'), close: t('cap.close') },
  };
}

async function showCaptions(tabId, meetingId) {
  captionTab = { meetingId, tabId };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/captions.js'] });
    await chrome.tabs.sendMessage(tabId, { type: CAPTION.SHOW, ...(await captionLabels()) });
    log.info('floating captions shown', { tabId, meetingId });
  } catch (e) {
    log.warn('show floating captions failed', { tabId, error: e.message });
  }
}

function hideCaptions(tabId) {
  chrome.tabs.sendMessage(tabId, { type: CAPTION.HIDE }).catch(() => { /* 标签页已关闭或已跳走 */ });
}

async function relayCaption(msg) {
  if (captionTab?.meetingId !== msg.meetingId) {
    const { active } = await getState();
    if (!active?.captions || active.meetingId !== msg.meetingId) return;
    captionTab = { meetingId: active.meetingId, tabId: active.tabId };
  }
  chrome.tabs.sendMessage(captionTab.tabId, { type: CAPTION.ROWS, rows: msg.rows }).catch(() => { /* 页面跳转中，等重新注入 */ });
}

async function setCaptions(enabled) {
  enabled = !!enabled;
  await saveSettings({ floatingCaptions: enabled });
  const active = await patchActive({ captions: enabled });
  log.info('set floating captions', { enabled, meetingId: active?.meetingId });
  broadcast({ type: EVT.CAPTIONS_STATE, enabled });
  if (!active) return { ok: true, applied: false };
  if (enabled) await showCaptions(active.tabId, active.meetingId);
  else { hideCaptions(active.tabId); captionTab = null; }
  await sendToOffscreen({ type: OFFSCREEN.SET_CAPTIONS, enabled }).catch((e) => log.warn('offscreen set captions failed', e));
  return { ok: true, applied: true };
}

// 会议中修改语言：存为下一场的默认值，并让 offscreen 用新配置重连两路转写。
async function setLanguages(languageHints) {
  if (!Array.isArray(languageHints)) throw new Error('languageHints must be an array');
  await saveSettings({ languageHints });
  const { active } = await getState();
  log.info('set languages', { languageHints, meetingId: active?.meetingId });
  if (!active) return { ok: true, applied: false };
  const res = await sendToOffscreen({ type: OFFSCREEN.SET_LANGUAGES, languageHints });
  if (!res?.ok) throw new Error(res?.error || 'offscreen set languages failed');
  return { ok: true, applied: true };
}

// ---------- 离开会议后自动停止 ----------
// 内容脚本报告"是否在通话中"。只有本次录制中曾经检测到"在通话中"，之后变为"不在"才触发，
// 这样在会前等候页开始录制不会被误停。触发后倒计时，期间可在侧边栏取消。

let autoStopTimer = null;

async function getPresence() {
  const { presence } = await chrome.storage.session.get('presence');
  return presence || {};
}

async function onPresence(msg, tabId) {
  const presence = await getPresence();
  const prev = presence[tabId];
  presence[tabId] = { inCall: msg.inCall, platform: msg.platform, signal: msg.signal, at: Date.now() };
  await chrome.storage.session.set({ presence });
  const { active } = await getState();
  const recordingThisTab = active?.tabId === tabId;
  log.info('meeting presence', { tabId, inCall: msg.inCall, platform: msg.platform, signal: msg.signal, prevInCall: prev?.inCall ?? null, recordingThisTab });
  if (!recordingThisTab) return;
  if (msg.inCall) {
    await patchActive({ seenInCall: true, autoStopSuppressed: false });
    if (active.autoStopDeadline) await cancelAutoStop('back-in-call');
    return;
  }
  if (!active.seenInCall) {
    log.info('not in call yet (pre-join page?) — auto stop not armed');
    return;
  }
  if (active.autoStopSuppressed) {
    log.info('left call detected but auto stop was cancelled by user for this call');
    return;
  }
  await scheduleAutoStop(`left-call (${msg.platform})`);
}

// ---------- 会议内麦克风静音 ----------
// 内容脚本报告 Meet / Teams 里的静音状态（只在变化时报告）。录制中的标签页转发给 offscreen，
// 静音期间暂停"我"这一路的转写（录音照常）。

async function getMicStates() {
  const { micStates } = await chrome.storage.session.get('micStates');
  return micStates || {};
}

async function onMicState(msg, tabId) {
  const micStates = await getMicStates();
  micStates[tabId] = { muted: msg.muted, signal: msg.signal, at: Date.now() };
  await chrome.storage.session.set({ micStates });
  const { active } = await getState();
  const recordingThisTab = active?.tabId === tabId;
  log.info('meeting mic state', { tabId, muted: msg.muted, platform: msg.platform, signal: msg.signal, recordingThisTab });
  if (!recordingThisTab) return;
  const res = await sendToOffscreen({ type: OFFSCREEN.SET_MIC_MUTED, muted: msg.muted, signal: msg.signal });
  if (!res?.ok) log.warn('offscreen set mic muted failed', res);
}

async function scheduleAutoStop(reason) {
  const settings = await getSettings();
  if (!settings.autoStopOnLeave) {
    log.info('left meeting detected, auto stop disabled in settings', { reason });
    return;
  }
  const { active } = await getState();
  if (!active || active.autoStopDeadline) return;
  const delayMs = Math.max(3, settings.autoStopDelaySec || 10) * 1000;
  const deadline = Date.now() + delayMs;
  await patchActive({ autoStopDeadline: deadline });
  log.info('auto stop scheduled', { reason, delayMs, meetingId: active.meetingId });
  broadcast({ type: EVT.AUTO_STOP, meetingId: active.meetingId, pending: true, deadline });
  chrome.action.setBadgeText({ text: 'END' });
  chrome.action.setBadgeBackgroundColor({ color: '#e37400' });
  armAutoStopTimer(active.meetingId, delayMs);
}

function armAutoStopTimer(meetingId, delayMs) {
  clearTimeout(autoStopTimer);
  autoStopTimer = setTimeout(async () => {
    const { active } = await getState();
    if (!active || active.meetingId !== meetingId || !active.autoStopDeadline) return;
    log.info('auto stopping: left meeting', { meetingId });
    await stopRecording('left-meeting').catch((e) => log.error('auto stop failed', e));
  }, Math.max(0, delayMs));
}

async function cancelAutoStop(reason, { suppress = false } = {}) {
  clearTimeout(autoStopTimer);
  const { active } = await getState();
  if (!active) return { ok: true };
  await patchActive({ autoStopDeadline: null, ...(suppress ? { autoStopSuppressed: true } : {}) });
  log.info('auto stop cancelled', { reason, suppress, meetingId: active.meetingId });
  broadcast({ type: EVT.AUTO_STOP, meetingId: active.meetingId, pending: false });
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  return { ok: true };
}

// 浏览器重启 / offscreen 崩溃后，把仍标记为 recording 的会议改为 interrupted。
async function recoverStaleMeetings() {
  if (busy) return; // 正在开始/停止，状态尚未稳定
  const { active } = await getState();
  const offscreenAlive = await hasOffscreen();
  if (active && !offscreenAlive) {
    log.warn('active meeting but offscreen document is gone — marking interrupted', { meetingId: active.meetingId });
    await setActive(null);
  }
  // 没有会议、也没在整理纪要的 offscreen（例如整理纪要时 SW 被挂起，没来得及关）
  if (!active && offscreenAlive && !busy) await closeOffscreenIfIdle();
  const current = active && offscreenAlive ? active.meetingId : null;
  const meetings = await listMeetings();
  for (const m of meetings) {
    if (m.status !== 'recording' || m.id === current) continue;
    if (busy || Date.now() - m.startedAt < 60_000) continue; // 可能是刚开始、尚未 setActive 的会议
    const chunks = await getChunks(m.id);
    const lastAt = chunks.length ? chunks[chunks.length - 1].at : 0;
    await updateMeeting(m.id, (x) => {
      x.status = 'interrupted';
      x.endedAt = x.startedAt + lastAt + 5000;
    });
    log.warn('stale meeting marked interrupted', { meetingId: m.id, chunks: chunks.length });
  }
}

// ---------- 事件 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === EVT.CAPTION) {
    relayCaption(msg).catch((e) => log.warn('relay caption failed', e));
    return false;
  }
  if (msg?.type === EVT.TRACK_ENDED) {
    stopRecording('tab-audio-ended').catch((e) => log.error('auto stop failed', e));
    return false;
  }
  if (msg?.type === EVT.PRESENCE) {
    if (sender.tab?.id != null) onPresence(msg, sender.tab.id).catch((e) => log.error('presence handling failed', e));
    return false;
  }
  if (msg?.type === EVT.MIC_STATE) {
    if (sender.tab?.id != null) onMicState(msg, sender.tab.id).catch((e) => log.error('mic state handling failed', e));
    return false;
  }
  if (msg?.target !== 'sw') return false;
  const run = {
    [SW.START]: () => startRecording(msg.tabId, msg.languageHints),
    [SW.SET_LANGUAGES]: () => setLanguages(msg.languageHints),
    [SW.CANCEL_AUTO_STOP]: () => cancelAutoStop('user', { suppress: true }),
    [SW.SET_CAPTIONS]: () => setCaptions(msg.enabled),
    [SW.STOP]: () => stopRecording(msg.reason || 'user'),
    [SW.GET_STATE]: () => getState(),
  }[msg.type];
  if (!run) return false;
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  log.info('keyboard command', { command, tabId: tab?.id });
  // 侧边栏只能在用户手势内同步打开
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => log.warn('sidePanel.open failed', e));
  try {
    const { active } = await getState();
    if (active) await stopRecording('shortcut');
    else if (tab?.id != null) await startRecording(tab.id);
  } catch (e) {
    log.error('toggle via shortcut failed', e);
    chrome.action.setBadgeText({ text: 'ERR' });
    chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
    setTimeout(() => getState().then(({ active }) => chrome.action.setBadgeText({ text: active ? 'REC' : '' })), 4000);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { active } = await getState();
  if (active?.tabId === tabId) {
    log.info('recorded tab closed');
    stopRecording('tab-closed').catch((e) => log.error('stop on tab close failed', e));
  }
});

// 录制中的标签页跳转到别的网站（例如 Teams 通话结束后跳走），也视为离开会议。
// 页面重新加载后注入的悬浮字幕脚本没了，加载完再注入一次。
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const { active } = await getState();
  if (active?.tabId !== tabId) return;
  if (changeInfo.status === 'complete') {
    if (active.captions) await showCaptions(tabId, active.meetingId);
    if (!changeInfo.url) return;
  }
  let host = '';
  try { host = new URL(changeInfo.url).hostname; } catch {}
  if (active.host && host !== active.host) {
    log.info('recorded tab navigated to another site', { from: active.host, to: host });
    if (active.seenInCall && !active.autoStopSuppressed) await scheduleAutoStop('navigated-away');
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  log.info('installed', { reason, version: chrome.runtime.getManifest().version });
  pruneOldLogs().then((r) => log.info('logs pruned', r)).catch((e) => log.warn('prune logs failed', e));
  await recoverStaleMeetings().catch((e) => log.error('recover failed', e));
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  log.info('browser startup');
  pruneOldLogs().catch((e) => log.warn('prune logs failed', e));
  await recoverStaleMeetings().catch((e) => log.error('recover failed', e));
});

// SW 被唤醒时也检查一次：offscreen 崩溃后状态不应停留在"录制中"
recoverStaleMeetings().catch((e) => log.error('recover on wake failed', e));

// SW 被挂起又唤醒时，恢复尚未执行的自动停止倒计时
getState().then(({ active }) => {
  if (active?.autoStopDeadline) armAutoStopTimer(active.meetingId, active.autoStopDeadline - Date.now());
}).catch(() => {});
