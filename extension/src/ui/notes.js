// AI 纪要面板（侧边栏和历史页共用）：状态行 + 一个操作按钮 + 纪要内容。
// 会议中：纪要由 offscreen 定时更新（live-notes.js），这里只显示，按钮是"立即更新"。
// 会议结束后：按钮是"生成 / 重新生成纪要"，在本页直接调用 updateNotes（页面要开着）。

import { el, sendToOffscreen } from './common.js';
import { t } from './i18n.js';
import { formatClock } from '../lib/format.js';
import { OFFSCREEN } from '../lib/messages.js';
import { notesEmpty } from '../lib/notes.js';
import { updateNotes, notesErrorState } from '../lib/notes-runner.js';
import { getSettings } from '../lib/settings.js';

const STATE_KEYS = {
  updating: 'notes.state.updating',
  finalizing: 'notes.state.finalizing',
  'no-key': 'notes.state.noKey',
  'invalid-key': 'notes.state.invalidKey',
  'no-quota': 'notes.state.noQuota',
  'rate-limited': 'notes.state.rateLimited',
  model: 'notes.state.model',
  failed: 'notes.state.failed',
};

// 跟随界面语言（initI18n 设置了 <html lang>），不跟浏览器
const clockOfDay = (ts) => new Date(ts).toLocaleTimeString(document.documentElement.lang || [], { hour: '2-digit', minute: '2-digit' });

// 模型写的负责人是导出用的英文标签（Me / Speaker 2 / Others）或名字，换成界面上的叫法
function ownerName(owner) {
  if (!owner) return null;
  if (/^me$/i.test(owner)) return t('common.me');
  if (/^others$/i.test(owner)) return t('common.them');
  const m = /^speaker\s*(\d+)$/i.exec(owner);
  return m ? t('common.themN', { n: m[1] }) : owner;
}

function timeLink(ms, onJump) {
  if (ms == null) return null;
  return onJump
    ? el('button', { class: 'link n-time', text: formatClock(ms), title: t('notes.jump'), onclick: () => onJump(ms) })
    : el('span', { class: 'n-time faint', text: formatClock(ms) });
}

export function renderNotes(notes, { onJump } = {}) {
  const box = el('div', { class: 'notes' });
  if (notesEmpty(notes)) return box;
  if (notes.summary) box.append(el('p', { class: 'n-summary', text: notes.summary }));
  if (notes.topics?.length) {
    box.append(el('h3', { text: t('notes.topics') }), ...notes.topics.map((tp) => el('div', { class: 'n-topic' },
      el('div', { class: 'n-topic-head' }, timeLink(tp.startMs, onJump), el('strong', { text: tp.title })),
      tp.summary ? el('div', { class: 'faint', text: tp.summary }) : null,
      tp.points.length ? el('ul', {}, tp.points.map((p) => el('li', {}, p.text, ' ', timeLink(p.t, onJump)))) : null)));
  }
  if (notes.conclusions?.length) {
    box.append(el('h3', { text: t('notes.conclusions') }),
      el('ul', {}, notes.conclusions.map((c) => el('li', {}, c.text, ' ', timeLink(c.t, onJump)))));
  }
  if (notes.todos?.length) {
    box.append(el('h3', { text: t('notes.todos') }), el('ul', { class: 'n-todos' }, notes.todos.map((td) => el('li', {},
      ownerName(td.owner) ? el('span', { class: 'chip', text: ownerName(td.owner) }) : null, ' ', td.text, ' ', timeLink(td.t, onJump)))));
  }
  if (notes.terms?.length) {
    box.append(el('h3', { text: t('notes.terms') }), el('ul', { class: 'n-terms' }, notes.terms.map((tm) => el('li', {},
      el('strong', { text: tm.name }), tm.note ? ` — ${tm.note}` : '',
      tm.heard.length ? el('span', { class: 'faint', text: ` ${t('notes.heard', { list: tm.heard.join(t('hist.listSep')) })}` }) : null))));
  }
  return box;
}

// onJump(ms)：点纪要里的时间，跳到对应原话
export function createNotesPanel({ log, onJump }) {
  const stateEl = el('span', { class: 'faint n-state' });
  const action = el('button', { class: 'hidden' });
  const body = el('div', { class: 'notes-body' });
  const root = el('div', { class: 'notes-panel' }, el('div', { class: 'notes-bar' }, stateEl, action), body);
  const cur = { meetingId: null, notes: null, state: 'idle', error: null, live: false, hasKey: true };
  let generating = false;

  function stateText() {
    if (generating) return t('notes.generating');
    if (!cur.hasKey) return '';
    const key = STATE_KEYS[cur.state];
    if (key) return t(key, { msg: cur.error || '' });
    if (cur.notes?.updatedAt) return t(cur.notes.final ? 'notes.updatedFinal' : 'notes.updated', { time: clockOfDay(cur.notes.updatedAt) });
    return '';
  }

  function render() {
    stateEl.textContent = stateText();
    const busy = generating || cur.state === 'updating' || cur.state === 'finalizing';
    action.onclick = null;
    if (!cur.meetingId) {
      action.className = 'hidden';
    } else if (!cur.hasKey) {
      action.className = 'link';
      action.textContent = t('common.options');
      action.onclick = () => chrome.runtime.openOptionsPage();
    } else if (cur.live) {
      action.className = '';
      action.textContent = t('notes.updateNow');
      action.disabled = busy;
      action.onclick = updateNow;
    } else {
      action.className = notesEmpty(cur.notes) ? 'primary' : '';
      action.textContent = t(notesEmpty(cur.notes) ? 'notes.generate' : 'notes.regenerate');
      action.disabled = busy;
      action.onclick = generate;
    }
    if (!notesEmpty(cur.notes)) {
      body.replaceChildren(renderNotes(cur.notes, { onJump }));
    } else {
      const hint = !cur.hasKey ? 'notes.noKeyHint' : cur.live ? 'notes.emptyLive' : 'notes.empty';
      body.replaceChildren(el('div', { class: 'empty', text: t(hint) }));
    }
  }

  async function updateNow() {
    try {
      const res = await sendToOffscreen(OFFSCREEN.NOTES_NOW);
      if (!res?.ok) throw new Error(res?.error || 'failed');
      log.info('notes update requested');
    } catch (e) {
      log.error('notes update request failed', e);
    }
  }

  async function generate() {
    if (!notesEmpty(cur.notes) && !confirm(t('notes.regenerateConfirm'))) return;
    const meetingId = cur.meetingId;
    generating = true;
    render();
    log.info('notes generation requested', { meetingId });
    try {
      const settings = await getSettings();
      const { notes } = await updateNotes({ meetingId, settings, final: true, log: log.child({ meetingId }) });
      if (cur.meetingId === meetingId) Object.assign(cur, { notes, state: 'done', error: null });
    } catch (e) {
      log.error('notes generation failed', { meetingId, status: e.status, code: e.code, message: e.message });
      if (cur.meetingId === meetingId) Object.assign(cur, { state: notesErrorState(e), error: e.message });
    } finally {
      generating = false;
      render();
    }
  }

  return {
    root,
    // patch：{ meetingId, notes, state, error, live, hasKey }，换会议时传全
    set(patch) {
      if (patch.meetingId !== undefined && patch.meetingId !== cur.meetingId) generating = false;
      Object.assign(cur, patch);
      render();
    },
    // meeting:notes 广播
    onMessage(msg) {
      if (msg.meetingId !== cur.meetingId) return;
      Object.assign(cur, { state: msg.state, error: msg.error || null }, msg.notes ? { notes: msg.notes } : {});
      render();
    },
  };
}
