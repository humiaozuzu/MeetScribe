// 页面共用的小工具。

import { STATUS } from '../lib/messages.js';
import { formatClock } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { segmentKey } from '../lib/speakers.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

export function sendToSw(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'sw', type, ...extra });
}

export function sendToOffscreen(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra });
}

// 状态 → [字符串 key, chip 样式]
export const STATUS_TEXT = {
  [STATUS.OFF]: ['status.off', 'warn'],
  [STATUS.CONNECTING]: ['status.connecting', ''],
  [STATUS.LIVE]: ['status.live', 'ok'],
  [STATUS.RECONNECTING]: ['status.reconnecting', 'warn'],
  [STATUS.PAUSED]: ['status.paused', ''],
  [STATUS.FAILED]: ['status.failed', 'err'],
  [STATUS.CLOSED]: ['status.closed', ''],
};

export function statusChip(status, detail) {
  const [key, cls] = STATUS_TEXT[status] || [null, ''];
  const text = key ? t(key) : (status || '—');
  let title = '';
  if (detail?.reason === 'no-api-key') title = t('status.noKey');
  else if (detail?.reason === 'mic-unavailable') title = t('status.micUnavailable', { err: detail.error || '' });
  else if (detail?.message) title = `${detail.code || ''} ${detail.message}`;
  else if (detail?.delayMs) title = t('status.retryIn', { s: Math.round(detail.delayMs / 1000), n: detail.attempt });
  return el('span', { class: `chip ${cls}`, title }, el('span', { class: 'dot' }), text);
}

// 界面上显示的说话人；导出的 Markdown 用 format.js 的 speakerLabel（固定英文）。
export function sourceName(source) {
  return t(source === 'me' ? 'common.me' : 'common.them');
}

// view 来自 lib/speakers.js 的 buildSpeakerView：有名字用名字，否则按本场编号"对方 n"。
// 还不在 view 里的键（侧边栏实时行）用 view.nextN。
export function speakerName(seg, view) {
  if (seg.source === 'me') return t('common.me');
  const key = segmentKey(seg);
  const e = view?.byKey.get(key);
  if (e?.name) return e.name;
  if (key === 'them') return t('common.them');
  const n = e?.n ?? (view ? view.nextN : seg.speaker);
  return n ? t('common.themN', { n }) : t('common.them');
}

// 说话人表变了（改名 / 合并）之后，原地刷新已渲染片段的说话人，不重建列表。
export function relabelSegments(root, view) {
  for (const n of root.querySelectorAll('.seg[data-key]')) {
    const who = n.querySelector('.who');
    if (who) who.textContent = speakerName({ source: 'them', speakerKey: n.dataset.key }, view);
  }
}

// onSpeaker(key)：点击说话人名（改名 / 合并），"我"不可点。
export function renderSegment(seg, { onSeek, view, onSpeaker } = {}) {
  const key = segmentKey(seg);
  const time = el(onSeek ? 'button' : 'span', {
    class: onSeek ? 'link' : '',
    text: formatClock(seg.startMs),
    title: onSeek ? t('common.playFrom') : null,
    onclick: onSeek ? () => onSeek(seg.startMs) : null,
  });
  const who = onSpeaker && key
    ? el('button', { class: 'who', text: speakerName(seg, view), title: t('spk.renameTitle'), onclick: () => onSpeaker(key) })
    : el('span', { class: 'who', text: speakerName(seg, view) });
  const node = el('div', { class: `seg ${seg.source} ${seg.origin === 'async' ? 'async' : ''}`, 'data-id': seg.id ?? '', 'data-start': seg.startMs, 'data-key': key },
    el('div', { class: 'meta' }, who, time),
    el('div', { class: 'text', text: seg.text }),
    seg.translation ? el('div', { class: 'tr', text: seg.translation }) : null,
  );
  return node;
}

export function permissionState(name) {
  return navigator.permissions.query({ name }).then((s) => s.state).catch(() => 'unknown');
}
