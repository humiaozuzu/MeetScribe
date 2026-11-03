// 历史页：会议列表、搜索、回放（字幕跟随）、补转 / 整场重转、说话人改名 / 合并、导出、删除。

import { $, el, renderSegment, sourceName, relabelSegments } from '../ui/common.js';
import { listMeetings, getMeeting, getSegments, getChunks, updateMeeting, deleteMeeting } from '../lib/db.js';
import { correctedStartOffset } from '../lib/timeline.js';
import { formatClock, formatDateTime, formatBytes } from '../lib/format.js';
import { createLogger, installGlobalErrorHandlers } from '../lib/log.js';
import { exportMeeting, exportLogs, buildTrackBlob, runPendingExports } from '../lib/exporter.js';
import { runRetranscribe, openGaps } from '../lib/retranscribe.js';
import { getSettings, redactSettings } from '../lib/settings.js';
import { EVT } from '../lib/messages.js';
import { langPicker, langNames } from '../ui/langs.js';
import { initI18n, t } from '../ui/i18n.js';
import { openSpeakerDialog, entryLabel } from '../ui/speakers.js';
import { buildSpeakerView } from '../lib/speakers.js';
import { createNotesPanel } from '../ui/notes.js';

const log = createLogger('history');
installGlobalErrorHandlers(log);
await initI18n(log);

let meetings = [];
let selectedId = null;
let player = null;
const textCache = new Map(); // meetingId -> 全文（搜索用）
const runningJobs = new Map(); // `${meetingId}:${source}` -> 进度 { step, fraction?, elapsedMs?, at }
const speakerUpdaters = new Map(); // meetingId -> 重新读取说话人表并刷新（别的页面改名后）
let notesPanel = null; // 当前详情页的纪要面板（接收 meeting:notes 广播）

// ---------- 列表 ----------

function meetingDuration(m) {
  return m.endedAt ? m.endedAt - m.startedAt : null;
}

function meetingChips(m) {
  const chips = [];
  if (m.status === 'recording') chips.push(el('span', { class: 'chip err', text: t('hist.recording') }));
  if (m.status === 'interrupted') chips.push(el('span', { class: 'chip warn', text: t('hist.interruptedChip') }));
  const gaps = openGaps(m).length;
  if (gaps) chips.push(el('span', { class: 'chip warn', text: t('hist.gapsChip', { n: gaps }) }));
  if (m.retranscribed) chips.push(el('span', { class: 'chip ok', text: t('hist.retranscribedChip') }));
  if (m.transcription && !m.transcription.enabled) chips.push(el('span', { class: 'chip', text: t('status.off') }));
  return chips;
}

async function loadList() {
  meetings = await listMeetings();
  renderList();
}

async function ensureSearchText() {
  for (const m of meetings) {
    if (textCache.has(m.id)) continue;
    const segs = await getSegments(m.id);
    textCache.set(m.id, `${m.title}\n${segs.map((s) => s.text).join('\n')}`.toLowerCase());
  }
}

async function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  if (q) await ensureSearchText();
  const box = $('#meetings');
  box.replaceChildren();
  const shown = meetings.filter((m) => !q || (textCache.get(m.id) || m.title.toLowerCase()).includes(q));
  if (!shown.length) box.append(el('div', { class: 'empty', text: q ? t('hist.noMatch') : t('hist.noMeetings') }));
  for (const m of shown) {
    const d = meetingDuration(m);
    box.append(el('div', { class: `m-item ${m.id === selectedId ? 'sel' : ''}`, onclick: () => select(m.id) },
      el('div', { class: 't', text: m.title || t('common.meeting') }),
      el('div', { class: 's' },
        el('span', { class: 'faint', text: `${formatDateTime(m.startedAt)}${d ? ` · ${formatClock(d)}` : ''}` }),
        ...meetingChips(m))));
  }
}

$('#q').addEventListener('input', () => renderList());

// ---------- 播放器：两路录音（对方 / 我）按会议时间轴同步播放 ----------

class SyncedPlayer {
  constructor(tracks, durationMs, onTime) {
    this.items = tracks.map((t) => {
      const url = URL.createObjectURL(t.blob);
      const audio = new Audio(url);
      audio.preload = 'auto';
      return { ...t, url, audio };
    });
    this.durationMs = durationMs;
    this.onTime = onTime;
    this.playing = false;
    this.items[0]?.audio.addEventListener('timeupdate', () => this.onTime(this.time()));
    this.items[0]?.audio.addEventListener('ended', () => { this.pause(); });
    this.syncTimer = setInterval(() => this._resync(), 1000);
  }

  // MediaRecorder 生成的 webm 没有时长信息，先跳到末尾让浏览器算出时长，seek 才可靠
  async ready() {
    await Promise.all(this.items.map(({ audio }) => new Promise((resolve) => {
      const done = () => { audio.currentTime = 0; resolve(); };
      audio.addEventListener('loadedmetadata', () => {
        if (audio.duration !== Infinity && !Number.isNaN(audio.duration)) return done();
        audio.addEventListener('durationchange', function h() {
          if (audio.duration === Infinity) return;
          audio.removeEventListener('durationchange', h);
          done();
        });
        audio.currentTime = 1e101;
      }, { once: true });
      audio.addEventListener('error', () => { log.warn('audio load error', { error: audio.error?.message }); resolve(); }, { once: true });
      setTimeout(resolve, 8000);
    })));
  }

  time() {
    const m = this.items[0];
    return m ? m.audio.currentTime * 1000 + m.offsetMs : 0;
  }

  seek(ms) {
    for (const it of this.items) it.audio.currentTime = Math.max(0, (ms - it.offsetMs) / 1000);
    this.onTime(ms);
  }

  async play() {
    this.playing = true;
    const t = this.time();
    this.seek(t);
    await Promise.all(this.items.map((it) => it.audio.play().catch((e) => log.warn('play failed', { source: it.source, error: e }))));
  }

  pause() {
    this.playing = false;
    for (const it of this.items) it.audio.pause();
  }

  _resync() {
    if (!this.playing || this.items.length < 2) return;
    const t = this.time();
    for (const it of this.items.slice(1)) {
      const want = (t - it.offsetMs) / 1000;
      if (want >= 0 && Math.abs(it.audio.currentTime - want) > 0.25) it.audio.currentTime = want;
    }
  }

  destroy() {
    this.pause();
    clearInterval(this.syncTimer);
    for (const it of this.items) { it.audio.src = ''; URL.revokeObjectURL(it.url); }
  }
}

// ---------- 详情 ----------

async function select(id) {
  selectedId = id;
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
  renderList();
  await renderDetail();
}

async function renderDetail() {
  player?.destroy();
  player = null;
  speakerUpdaters.clear();
  const box = $('#detail');
  const meeting = await getMeeting(selectedId);
  if (!meeting) { box.replaceChildren(el('div', { class: 'empty', text: t('hist.notFound') })); return; }
  const segs = await getSegments(meeting.id);
  const live = meeting.status === 'recording';

  const title = el('input', { class: 'title', value: meeting.title || '' });
  title.addEventListener('change', async () => {
    await updateMeeting(meeting.id, (m) => { m.title = title.value.trim() || m.title; });
    await loadList();
  });

  const tracks = meeting.tracks || {};
  const trackInfo = Object.entries(tracks).map(([k, track]) => `${sourceName(k)} ${formatBytes(track.bytes)}`).join(' · ');
  const meta = el('div', { class: 'faint', text: [
    formatDateTime(meeting.startedAt),
    meetingDuration(meeting) ? t('hist.duration', { d: formatClock(meetingDuration(meeting)) }) : null,
    trackInfo || null,
    meeting.transcription?.enabled ? t('hist.rtModel', { model: meeting.transcription.model }) : t('hist.noRealtime'),
  ].filter(Boolean).join(' · ') });

  const tr = meeting.transcription || {};
  const changes = tr.languageChanges || [];
  const initialLangs = changes.length ? changes[0].from : tr.languageHints;
  const langInfo = el('div', { class: 'faint', text: t('hist.langInfo', { langs: langNames(initialLangs) })
    + changes.map((c) => t('hist.langChange', { time: formatClock(c.atMs), langs: langNames(c.languageHints) })).join('') });
  let retransLangs = tr.languageHints || (await getSettings()).languageHints;
  const retransPicker = el('div', { class: 'row-inline' }, el('span', { class: 'faint', text: t('hist.retransLangs') }),
    langPicker(retransLangs, (next) => { retransLangs = next; }, { disabled: live }));

  const notices = el('div', { class: 'gaps' });
  if (live) notices.append(el('div', { class: 'notice info', text: t('hist.liveNotice') }));
  if (meeting.status === 'interrupted') notices.append(el('div', { class: 'notice warn', text: t('hist.interrupted') }));
  if (meeting.micError) notices.append(el('div', { class: 'notice warn', text: t('hist.micErrorThen', { err: meeting.micError }) }));
  const gaps = openGaps(meeting);
  if (gaps.length) {
    notices.append(el('div', { class: 'notice warn', text: t('hist.gaps', { list: gaps.map((g) => `${sourceName(g.source)} ${formatClock(g.startMs)}–${formatClock(g.endMs)}`).join(t('hist.listSep')) }) }));
  }
  // 正在跑的任务：第一次重转时 meeting.jobs 里还没有这条，所以按 runningJobs 显示
  for (const source of ['them', 'me']) {
    const key = `${meeting.id}:${source}`;
    if (runningJobs.has(key)) notices.append(renderJobProgress(el('div', { class: 'notice info job', 'data-job': key }), source, runningJobs.get(key), tracks[source]));
  }
  for (const j of meeting.jobs || []) {
    const key = `${meeting.id}:${j.source}`;
    if (runningJobs.has(key)) continue;
    if (j.status === 'running') notices.append(el('div', { class: 'notice warn' }, t('hist.jobUnfinished', { src: sourceName(j.source) }),
      el('button', { class: 'link', text: t('hist.continue'), onclick: () => startJob(meeting.id, j.source, j.mode) })));
    else if (j.status === 'error') notices.append(el('div', { class: 'notice err', text: t('hist.jobFailed', { src: sourceName(j.source), err: j.error }) }));
  }

  const busy = [...runningJobs.keys()].some((k) => k.startsWith(meeting.id));
  const hasTrack = (s) => !!tracks[s]?.chunks;
  const actions = el('div', { class: 'actions' },
    gaps.length ? el('button', { class: 'primary', disabled: live || busy, text: t('hist.fillGaps'), title: t('hist.fillGapsTitle'),
      onclick: () => runForSources(meeting, [...new Set(gaps.map((g) => g.source))], 'gaps', retransLangs) }) : null,
    el('button', { disabled: live || busy, text: t('hist.retranscribe'), title: t('hist.retranscribeTitle'),
      onclick: () => {
        if (!confirm(t('hist.retranscribeConfirm'))) return;
        runForSources(meeting, ['them', 'me'].filter(hasTrack), 'full', retransLangs);
      } }),
    el('button', { disabled: live, text: t('hist.exportMd'), onclick: () => doExport(meeting.id, { audio: false }) }),
    el('button', { disabled: live, text: t('hist.exportAudio'), onclick: () => doExport(meeting.id, { markdown: false }) }),
    el('button', { text: t('hist.exportMeetingLogs'), onclick: () => exportMeetingLogs(meeting) }),
    el('button', { class: 'danger', disabled: live || busy, text: t('hist.delete'), onclick: () => removeMeeting(meeting) }),
  );

  // 播放器
  const playBtn = el('button', { text: t('hist.play'), disabled: true });
  const range = el('input', { type: 'range', min: 0, max: Math.max(1, meetingDuration(meeting) || 1), value: 0, step: 100, disabled: true });
  const time = el('span', { class: 'time', text: t('hist.loadingAudio') });
  const playerRow = el('div', { class: 'player' }, playBtn, range, time);

  // 说话人：点名字改名 / 合并，改完原地刷新，不重建列表（播放器不中断）
  let view = buildSpeakerView(meeting.speakers, segs);
  const speakerBar = el('div', { class: 'spk-bar' });
  const onSpeaker = (key) => openSpeakerDialog({
    meetingId: meeting.id, key, view, log,
    onChanged: (m) => applySpeakers(m.speakers),
  });
  function applySpeakers(speakers) {
    view = buildSpeakerView(speakers, segs);
    relabelSegments(segBox, view);
    renderSpeakerBar();
  }
  function renderSpeakerBar() {
    speakerBar.replaceChildren();
    if (!view.list.length) return;
    speakerBar.append(el('span', { class: 'faint', text: t('hist.speakers') }),
      ...view.list.map((e) => el('button', { class: 'chip', text: entryLabel(e, view), title: t('spk.renameTitle'),
        onclick: () => onSpeaker(e.key) })));
  }
  speakerUpdaters.set(meeting.id, async () => applySpeakers((await getMeeting(meeting.id))?.speakers));

  const segBox = el('div', { id: 'segs' });
  if (!segs.length) segBox.append(el('div', { class: 'empty', text: meeting.transcription?.enabled ? t('hist.noTranscript') : t('hist.audioOnly') }));
  for (const s of segs) segBox.append(renderSegment(s, { view, onSpeaker, onSeek: (ms) => { player?.seek(ms); if (!player?.playing) player?.play().then(updatePlayBtn); } }));
  renderSpeakerBar();

  // 字幕 / 纪要 标签。纪要里点时间：切回字幕，从那句话开始播放
  const notesBox = el('div', { id: 'notesBox', class: 'hidden' });
  const tabBtns = [['segs', 'notes.tabCaptions'], ['notesBox', 'notes.tabNotes']].map(([id, key]) => el('button', {
    class: `tab${id === 'segs' ? ' sel' : ''}`, 'data-tab': id, text: t(key), onclick: () => showTab(id),
  }));
  function showTab(id) {
    for (const b of tabBtns) b.classList.toggle('sel', b.dataset.tab === id);
    segBox.classList.toggle('hidden', id !== 'segs');
    notesBox.classList.toggle('hidden', id !== 'notesBox');
  }
  notesPanel = createNotesPanel({
    log,
    onJump: (ms) => {
      showTab('segs');
      let target = null;
      for (const n of segBox.querySelectorAll('.seg')) { if (Number(n.dataset.start) <= ms) target = n; else break; }
      target?.scrollIntoView({ block: 'center' });
      if (player) { player.seek(ms); if (!player.playing) player.play().then(updatePlayBtn); }
    },
  });
  notesPanel.set({ meetingId: meeting.id, notes: meeting.notes || null, state: 'idle', error: null, live, hasKey: !!(await getSettings()).openaiApiKey });
  notesBox.append(notesPanel.root);

  box.replaceChildren(el('div', { class: 'd-head' }, title, meta, langInfo, notices, retransPicker, actions, speakerBar, playerRow,
    el('div', { class: 'tabs' }, tabBtns)), segBox, notesBox);

  function updatePlayBtn() { playBtn.textContent = player?.playing ? t('hist.pause') : t('hist.play'); }

  if (live) { time.textContent = t('hist.recording'); return; }
  const trackList = [];
  for (const source of ['them', 'me']) {
    const blob = await buildTrackBlob(meeting.id, source);
    if (blob) trackList.push({ source, blob, offsetMs: tracks[source]?.startOffsetMs ?? 0 });
  }
  if (selectedId !== meeting.id) return; // 加载过程中切换了会议
  if (!trackList.length) { time.textContent = t('hist.noAudio'); return; }
  let lastActive = null;
  player = new SyncedPlayer(trackList, meetingDuration(meeting), (ms) => {
    range.value = ms;
    time.textContent = `${formatClock(ms)} / ${formatClock(meetingDuration(meeting) || 0)}`;
    // 高亮当前片段
    const nodes = segBox.querySelectorAll('.seg');
    let cur = null;
    for (const n of nodes) { if (Number(n.dataset.start) <= ms) cur = n; else break; }
    if (cur !== lastActive) {
      lastActive?.classList.remove('playing');
      cur?.classList.add('playing');
      if (cur && player?.playing) cur.scrollIntoView({ block: 'nearest' });
      lastActive = cur;
    }
  });
  await player.ready();
  if (selectedId !== meeting.id) return;
  await fixRecordingOffsets(meeting, player.items);
  playBtn.disabled = false;
  range.disabled = false;
  time.textContent = `00:00 / ${formatClock(meetingDuration(meeting) || 0)}`;
  playBtn.onclick = async () => { if (player.playing) player.pause(); else await player.play(); updatePlayBtn(); };
  range.oninput = () => player.seek(Number(range.value));
}

// 旧录音的起点可能记早了（见 lib/timeline.js），拿到真实时长后校正并写回，补转 / 重转也会用到。
async function fixRecordingOffsets(meeting, items) {
  for (const it of items) {
    const durationMs = it.audio.duration * 1000;
    const chunks = await getChunks(meeting.id, it.source).catch(() => []);
    const fixed = correctedStartOffset({ startOffsetMs: it.offsetMs, lastChunkAtMs: chunks.at(-1)?.at, durationMs });
    if (fixed == null) continue;
    log.info('recording offset corrected', { meetingId: meeting.id, source: it.source, from: it.offsetMs, to: fixed, durationMs: Math.round(durationMs) });
    it.offsetMs = fixed;
    await updateMeeting(meeting.id, (m) => {
      if (m.tracks?.[it.source]) m.tracks[it.source].startOffsetMs = fixed;
    }).catch((e) => log.warn('save corrected offset failed', { meetingId: meeting.id, source: it.source, error: e }));
  }
}

async function runForSources(meeting, sources, mode, languageHints) {
  const settings = { ...(await getSettings()), ...(languageHints ? { languageHints } : {}) };
  if (!settings.sonioxApiKey) { alert(t('hist.needKey')); return; }
  await Promise.all(sources.map((s) => startJob(meeting.id, s, mode, settings)));
}

// 进度分 4 步：准备 / 上传（百分比）→ 排队 → 转写（已用时间）→ 保存结果
const JOB_STEP_NO = { prepare: 1, upload: 1, queued: 2, transcribing: 3, download: 4, save: 4 };

function jobStepText(p) {
  if (p.step === 'upload') return t('hist.step.upload', { pct: Math.round((p.fraction || 0) * 100) });
  if (p.step === 'transcribing') return t('hist.step.transcribing', { elapsed: formatClock((p.elapsedMs || 0) + Date.now() - p.at) });
  return t(`hist.step.${p.step === 'download' ? 'save' : p.step}`);
}

// node.dataset.audio：音频时长说明，渲染一次后保存在节点上，进度更新时不必再读会议
function jobLine(node, source, p) {
  return t('hist.jobStep', { src: sourceName(source), n: JOB_STEP_NO[p.step] || 1, step: jobStepText(p) }) + (node.dataset.audio || '');
}

function renderJobProgress(node, source, p, track) {
  if (track?.seconds) node.dataset.audio = t('hist.jobAudio', { d: formatClock(track.seconds * 1000) });
  const bar = el('progress', { max: 1 });
  if (p.step === 'upload') bar.value = p.fraction || 0; // 其他步骤没有百分比，显示为滚动条
  node.replaceChildren(el('span', { class: 'job-text', text: jobLine(node, source, p) }), bar);
  return node;
}

function updateJobProgress(node, source, p) {
  const bar = node.querySelector('progress');
  const text = node.querySelector('.job-text');
  if (!bar || !text) return;
  text.textContent = jobLine(node, source, p);
  if (p.step === 'upload') bar.value = p.fraction || 0;
  else bar.removeAttribute('value');
}

// 转写中的已用时间每秒刷新（Soniox 轮询间隔最长 10 秒）
setInterval(() => {
  for (const node of document.querySelectorAll('.notice[data-job]')) {
    const p = runningJobs.get(node.dataset.job);
    if (p?.step === 'transcribing') updateJobProgress(node, node.dataset.job.split(':').pop(), p);
  }
}, 1000);

async function startJob(meetingId, source, mode, settings) {
  settings = settings || await getSettings();
  const key = `${meetingId}:${source}`;
  if (runningJobs.has(key)) return;
  runningJobs.set(key, { step: 'prepare', at: Date.now() });
  const rerender = () => { if (selectedId === meetingId) renderDetail(); };
  rerender();
  log.info('retranscribe requested', { meetingId, source, mode, settings: redactSettings(settings) });
  try {
    const res = await runRetranscribe({
      meetingId, source, mode, settings, log,
      onProgress: (p) => {
        runningJobs.set(key, { ...p, at: Date.now() });
        const node = document.querySelector(`.notice[data-job="${key}"]`);
        if (node) updateJobProgress(node, source, runningJobs.get(key));
      },
    });
    log.info('retranscribe finished', { meetingId, source, mode, ...res });
  } catch (e) {
    log.error('retranscribe failed', { meetingId, source, mode, error: e });
    alert(t('hist.jobFailed', { src: sourceName(source), err: e.message }));
  } finally {
    runningJobs.delete(key);
    textCache.delete(meetingId);
    await loadList();
    rerender();
  }
}

async function doExport(meetingId, opts) {
  try {
    const res = await exportMeeting(meetingId, { ...opts, log });
    alert(t('hist.exported', { folder: res.folder }));
  } catch (e) {
    log.error('export failed', { meetingId, error: e });
    alert(t('common.exportFailed', { msg: e.message }));
  }
}

async function exportMeetingLogs(meeting) {
  const from = meeting.startedAt - 2 * 60_000;
  const to = (meeting.endedAt || Date.now()) + 5 * 60_000;
  try {
    const settings = await getSettings();
    await exportLogs({
      label: `meeting-${meeting.id.slice(0, 8)}`,
      filter: (e) => e.meetingId === meeting.id || (e.ts >= from && e.ts <= to),
      meta: { meeting, settings: redactSettings(settings) },
    });
  } catch (e) {
    log.error('export meeting logs failed', e);
    alert(t('hist.exportLogsFailed', { msg: e.message }));
  }
}

async function removeMeeting(meeting) {
  if (!confirm(t('hist.deleteConfirm', { title: meeting.title }))) return;
  await deleteMeeting(meeting.id);
  log.info('meeting deleted', { meetingId: meeting.id });
  selectedId = null;
  player?.destroy();
  player = null;
  $('#detail').replaceChildren(el('div', { class: 'empty', text: t('hist.deleted') }));
  await loadList();
  showStorage();
}

// ---------- 顶部工具栏 ----------

$('#exportAll').addEventListener('click', async () => {
  if (!confirm(t('hist.exportAllConfirm', { n: meetings.length }))) return;
  for (const m of meetings) {
    if (m.status === 'recording') continue;
    try { await exportMeeting(m.id, { log }); } catch (e) { log.error('export failed', { meetingId: m.id, error: e }); }
  }
  alert(t('hist.exportAllDone'));
});

$('#exportLogs').addEventListener('click', async () => {
  const settings = await getSettings();
  await exportLogs({ label: 'all', meta: { settings: redactSettings(settings), meetings: meetings.length } })
    .catch((e) => alert(t('hist.exportLogsFailed', { msg: e.message })));
});

$('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function showStorage() {
  const est = await navigator.storage.estimate().catch(() => null);
  if (est) $('#storage').textContent = t('common.storageUsage', { size: formatBytes(est.usage) });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === EVT.MEETING_ENDED || msg?.type === EVT.MEETING_STATE) {
    loadList().then(() => { if (selectedId) renderDetail(); });
  }
  if (msg?.type === EVT.SPEAKERS) {
    speakerUpdaters.get(msg.meetingId)?.().catch((e) => log.warn('refresh speakers failed', e));
  }
  if (msg?.type === EVT.NOTES) {
    notesPanel?.onMessage(msg);
    if (msg.notes) loadList().catch(() => {}); // 会后的纪要可能给会议起了名字
  }
  return false;
});

window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && id !== selectedId) select(id); });

(async () => {
  await loadList();
  showStorage();
  const id = location.hash.slice(1) || meetings[0]?.id;
  if (id) await select(id);
  runPendingExports(log).catch((e) => log.error('pending export failed', e));
})().catch((e) => log.error('history init failed', e));
