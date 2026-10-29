// 页面共用的小工具。

import { STATUS } from '../lib/messages.js';
import { formatClock, speakerLabel } from '../lib/format.js';

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

export const STATUS_TEXT = {
  [STATUS.OFF]: ['仅录音', 'warn'],
  [STATUS.CONNECTING]: ['连接中', ''],
  [STATUS.LIVE]: ['转写中', 'ok'],
  [STATUS.RECONNECTING]: ['重连中，录音继续', 'warn'],
  [STATUS.FAILED]: ['转写失败，录音继续', 'err'],
  [STATUS.CLOSED]: ['已结束', ''],
};

export function statusChip(status, detail) {
  const [text, cls] = STATUS_TEXT[status] || [status || '—', ''];
  let title = '';
  if (detail?.reason === 'no-api-key') title = '未填写 Soniox API key';
  else if (detail?.reason === 'mic-unavailable') title = `麦克风不可用：${detail.error || ''}`;
  else if (detail?.message) title = `${detail.code || ''} ${detail.message}`;
  else if (detail?.delayMs) title = `${Math.round(detail.delayMs / 1000)}s 后第 ${detail.attempt} 次重连`;
  return el('span', { class: `chip ${cls}`, title }, el('span', { class: 'dot' }), text);
}

export function renderSegment(seg, { onSeek } = {}) {
  const time = el(onSeek ? 'button' : 'span', {
    class: onSeek ? 'link' : '',
    text: formatClock(seg.startMs),
    title: onSeek ? '从这里播放' : null,
    onclick: onSeek ? () => onSeek(seg.startMs) : null,
  });
  const node = el('div', { class: `seg ${seg.source} ${seg.origin === 'async' ? 'async' : ''}`, 'data-id': seg.id ?? '', 'data-start': seg.startMs },
    el('div', { class: 'meta' }, el('span', { class: 'who', text: speakerLabel(seg) }), time),
    el('div', { class: 'text', text: seg.text }),
    seg.translation ? el('div', { class: 'tr', text: seg.translation }) : null,
  );
  return node;
}

export function permissionState(name) {
  return navigator.permissions.query({ name }).then((s) => s.state).catch(() => 'unknown');
}
