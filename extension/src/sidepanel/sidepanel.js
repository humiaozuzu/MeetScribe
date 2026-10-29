// 侧边栏：会议进行中的实时字幕与状态。
// 数据来源：打开时从 IndexedDB 读已定稿片段 + 向 offscreen 取当前状态；之后监听广播。

import { $, el, sendToSw, sendToOffscreen, statusChip, renderSegment, sourceName, relabelSegments } from '../ui/common.js';
import { SW, OFFSCREEN, EVT, STATUS } from '../lib/messages.js';
import { getSegments, getMeeting } from '../lib/db.js';
import { formatClock } from '../lib/format.js';
import { createLogger, installGlobalErrorHandlers } from '../lib/log.js';
import { runPendingExports } from '../lib/exporter.js';
import { langPicker } from '../ui/langs.js';
import { initI18n, t } from '../ui/i18n.js';
import { openSpeakerDialog } from '../ui/speakers.js';
import { buildSpeakerView } from '../lib/speakers.js';

const log = createLogger('sidepanel');
installGlobalErrorHandlers(log);
await initI18n(log);

const SOURCES = ['them', 'me'];
let meetingId = null;
let active = null;
let timer = null;
const sourceState = {};   // source -> { status, detail, level }
const partials = {};      // source -> partial
let micMuted = null;      // 会议里是否静音：true / false / null（检测不到）
let stickToBottom = true;
let autoStopDeadline = null;
let autoStopTicker = null;
// 说话人表：会议中也能改名 / 合并（重连后编号会变，新出现的人显示为下一个编号，可合并回已有的人）
let segs = [];
let speakers = {};
let view = buildSpeakerView(speakers, segs);

// 会议语言：点击后稍等再提交，连续点几个语言只重连一次
const LANG_DEBOUNCE_MS = 800;
let langTimer = null;
const picker = langPicker([], (next) => {
  clearTimeout(langTimer);
  $('#langNote').textContent = '';
  langTimer = setTimeout(async () => {
    $('#langNote').textContent = t('sp.switching');
    try {
      const res = await sendToSw(SW.SET_LANGUAGES, { languageHints: next });
      if (!res?.ok) throw new Error(res?.error || 'failed');
      log.info('languages changed from side panel', { languageHints: next });
      $('#langNote').textContent = t('sp.switched');
      setTimeout(() => { $('#langNote').textContent = ''; }, 2000);
    } catch (e) {
      log.error('change languages failed', e);
      $('#langNote').textContent = t('sp.switchFailed', { msg: e.message });
    }
  }, LANG_DEBOUNCE_MS);
});
$('#langs').append(picker);

const list = $('#list');
const liveBox = $('#live'); // 实时行容器，会被移进列表底部，保留引用

list.addEventListener('scroll', () => {
  stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  $('#jump').classList.toggle('hidden', stickToBottom);
});
$('#jump').addEventListener('click', () => { stickToBottom = true; scrollDown(); $('#jump').classList.add('hidden'); });

function scrollDown() {
  if (stickToBottom) list.scrollTop = list.scrollHeight;
}

function renderSources() {
  const box = $('#sources');
  box.replaceChildren();
  for (const src of SOURCES) {
    const st = sourceState[src];
    if (!st) continue;
    const bar = el('i');
    bar.style.width = `${Math.min(100, Math.round(Math.sqrt(st.level || 0) * 300))}%`;
    const muted = src === 'me' && micMuted === true;
    box.append(el('span', { class: `src ${src}` },
      el('span', { class: 'name', text: sourceName(src) }),
      el('span', { class: `level${muted ? ' muted' : ''}`, 'data-src': src, title: muted ? t('sp.mutedLevelTitle') : null }, bar),
      // 静音时只显示一个"已静音"，代替状态标签（否则一行放不下）
      muted ? el('span', { class: 'chip muted', title: t('sp.mutedChipTitle') }, el('span', { class: 'dot' }), t('sp.muted')) : statusChip(st.status, st.detail)));
  }
  renderNotices();
}

function renderNotices() {
  const box = $('#notices');
  box.replaceChildren();
  if (!active) return;
  const failed = Object.entries(sourceState).filter(([, s]) => s.status === STATUS.FAILED);
  if (failed.length) {
    const d = failed[0][1].detail;
    box.append(el('div', { class: 'notice err', text: t('sp.failedNotice', { code: d?.code || '', msg: d?.message || '' }) }));
  }
  if (Object.values(sourceState).some((s) => s.status === STATUS.RECONNECTING)) {
    box.append(el('div', { class: 'notice warn', text: t('sp.reconnectNotice') }));
  }
  if (autoStopDeadline) {
    const left = Math.max(0, Math.ceil((autoStopDeadline - Date.now()) / 1000));
    box.append(el('div', { class: 'notice warn' },
      t('sp.autoStop', { n: left }),
      el('button', { class: 'link', text: t('sp.keepRecording'), onclick: cancelAutoStop })));
  }
  if (active.micError) box.append(el('div', { class: 'notice warn', text: t('common.micUnavailableThemOnly', { err: active.micError }) }));
}

function setAutoStop(deadline) {
  autoStopDeadline = deadline || null;
  clearInterval(autoStopTicker);
  if (autoStopDeadline) autoStopTicker = setInterval(renderNotices, 1000);
  renderNotices();
}

async function cancelAutoStop() {
  try {
    const res = await sendToSw(SW.CANCEL_AUTO_STOP);
    if (!res?.ok) throw new Error(res?.error || 'failed');
    log.info('auto stop cancelled from side panel');
  } catch (e) {
    log.error('cancel auto stop failed', e);
  }
}

function updateLevels(levels) {
  for (const [src, v] of Object.entries(levels || {})) {
    if (sourceState[src]) sourceState[src].level = v;
    const bar = document.querySelector(`.level[data-src="${src}"] > i`);
    if (bar) bar.style.width = `${Math.min(100, Math.round(Math.sqrt(v) * 300))}%`;
  }
}

function renderPartials() {
  const box = liveBox;
  box.replaceChildren();
  for (const src of SOURCES) {
    const p = partials[src];
    if (!p || (!p.finalText && !p.pendingText)) continue;
    const node = renderSegment({ source: src, speaker: p.speaker, speakerKey: p.speakerKey, startMs: null, text: '' }, { view });
    node.querySelector('.meta span:last-child')?.remove();
    const text = node.querySelector('.text');
    text.replaceChildren(p.finalText, el('span', { class: 'pending', text: p.pendingText }));
    box.append(node);
  }
  // 实时行放在列表底部
  list.append(box);
  scrollDown();
}

function onSpeaker(key) {
  openSpeakerDialog({ meetingId, key, view, log, onChanged: (m) => applySpeakers(m.speakers) });
}

function applySpeakers(next) {
  speakers = next || {};
  view = buildSpeakerView(speakers, segs);
  relabelSegments(list, view);
  renderPartials();
}

function appendSegment(seg) {
  $('#empty')?.remove();
  const idx = segs.findIndex((s) => s.id === seg.id);
  if (idx >= 0) segs[idx] = seg; else segs.push(seg);
  view = buildSpeakerView(speakers, segs);
  const existing = list.querySelector(`.seg[data-id="${seg.id}"]`);
  const node = renderSegment(seg, { view, onSpeaker });
  if (existing) existing.replaceWith(node);
  else list.insertBefore(node, liveBox.parentNode === list ? liveBox : null);
  scrollDown();
}

async function loadMeeting(id) {
  meetingId = id;
  const [meeting, loaded] = await Promise.all([getMeeting(id), getSegments(id)]);
  segs = loaded;
  speakers = meeting?.speakers || {};
  view = buildSpeakerView(speakers, segs);
  $('#title').textContent = meeting?.title || 'MeetScribe';
  list.replaceChildren();
  if (!segs.length) list.append(el('div', { class: 'empty', id: 'empty', text: active ? t('sp.waiting') : t('sp.noTranscript') }));
  for (const s of segs) list.append(renderSegment(s, { view, onSpeaker }));
  list.append(liveBox);
  stickToBottom = true;
  scrollDown();
}

async function refresh() {
  const state = await sendToSw(SW.GET_STATE);
  active = state?.active || null;
  clearInterval(timer);
  $('#stop').classList.toggle('hidden', !active);
  $('#langRow').classList.toggle('hidden', !active);
  setAutoStop(active?.autoStopDeadline);
  if (!active) {
    $('#timer').textContent = meetingId ? t('status.closed') : '';
    for (const k of Object.keys(sourceState)) delete sourceState[k];
    for (const k of Object.keys(partials)) delete partials[k];
    micMuted = null;
    renderSources();
    renderPartials();
    return;
  }
  const tick = () => { $('#timer').textContent = formatClock(Date.now() - active.startedAt); };
  tick();
  timer = setInterval(tick, 1000);
  if (meetingId !== active.meetingId) await loadMeeting(active.meetingId);
  const live = await sendToOffscreen(OFFSCREEN.GET_LIVE).catch(() => null);
  if (live?.active) {
    picker.setValue(live.languageHints);
    micMuted = live.micMuted ?? null;
    for (const [src, s] of Object.entries(live.sources)) {
      sourceState[src] = { status: s.status, detail: s.detail, level: s.level };
      if (s.partial) partials[src] = s.partial;
    }
  }
  renderSources();
  renderPartials();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return false;
  if (msg.type === EVT.MEETING_STATE) { refresh().catch((e) => log.error('refresh failed', e)); return false; }
  if (msg.type === EVT.MEETING_ENDED) {
    runPendingExports(log).catch((e) => log.error('pending export failed', e));
    return false;
  }
  if (msg.meetingId == null || msg.meetingId !== meetingId) return false;
  if (msg.type === EVT.AUTO_STOP) { setAutoStop(msg.pending ? msg.deadline : null); return false; }
  if (msg.type === EVT.SPEAKERS) {
    getMeeting(meetingId).then((m) => applySpeakers(m?.speakers)).catch((e) => log.warn('refresh speakers failed', e));
    return false;
  }
  switch (msg.type) {
    case EVT.SEGMENT:
    case EVT.SEGMENT_UPDATE:
      appendSegment(msg.segment);
      break;
    case EVT.PARTIAL:
      partials[msg.source] = msg;
      renderPartials();
      break;
    case EVT.STATUS:
      sourceState[msg.source] = { ...(sourceState[msg.source] || {}), status: msg.status, detail: msg.detail };
      renderSources();
      break;
    case EVT.MIC_MUTED:
      micMuted = msg.muted;
      renderSources();
      break;
    case EVT.LANGUAGES:
      picker.setValue(msg.languageHints);
      break;
    case EVT.LEVELS:
      updateLevels(msg.levels);
      break;
  }
  return false;
});

$('#stop').addEventListener('click', async () => {
  $('#stop').disabled = true;
  try {
    const res = await sendToSw(SW.STOP);
    if (!res?.ok) throw new Error(res?.error || 'stop failed');
  } catch (e) {
    log.error('stop from side panel failed', e);
    alert(t('common.stopFailed', { msg: e.message }));
  } finally {
    $('#stop').disabled = false;
  }
});
$('#history').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') + (meetingId ? `#${meetingId}` : '') }));
$('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh().catch((e) => log.error('side panel init failed', e));
runPendingExports(log).catch((e) => log.error('pending export failed', e));
