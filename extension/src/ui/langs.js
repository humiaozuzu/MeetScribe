// 会议语言选择（多选按钮）。弹窗、侧边栏、历史页共用。

import { el } from './common.js';
import { t } from '../lib/i18n.js';

// 显示名在字符串表里：lang.<code>
export const LANGS = ['zh', 'ja', 'en', 'ko', 'fr', 'de', 'es', 'ru'];

const langName = (c) => (LANGS.includes(c) ? t(`lang.${c}`) : c);

export function langNames(codes) {
  return codes?.length ? codes.map(langName).join(' / ') : t('lang.auto');
}

// selected: 语言代码数组；onChange(next) 在每次点击后调用。
// 设置页里填过列表外的代码会保留在选中项里（显示为代码本身）。
export function langPicker(selected, onChange, { disabled = false } = {}) {
  let cur = [...(selected || [])];
  const box = el('div', { class: 'lang-picker', title: t('lang.pickerTitle') });
  const extra = cur.filter((c) => !LANGS.includes(c));
  for (const code of [...LANGS, ...extra]) {
    const btn = el('button', { type: 'button', class: cur.includes(code) ? 'on' : '', text: langName(code), 'data-code': code, disabled });
    btn.addEventListener('click', () => {
      cur = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
      btn.classList.toggle('on', cur.includes(code));
      onChange([...cur]);
    });
    box.append(btn);
  }
  box.setValue = (codes) => {
    cur = [...(codes || [])];
    for (const b of box.querySelectorAll('button')) b.classList.toggle('on', cur.includes(b.dataset.code));
  };
  return box;
}
