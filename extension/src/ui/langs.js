// 会议语言选择（多选按钮）。弹窗、侧边栏、历史页共用。

import { el } from './common.js';

export const LANGS = [
  ['zh', '中'], ['ja', '日'], ['en', '英'], ['ko', '韩'],
  ['fr', '法'], ['de', '德'], ['es', '西'], ['ru', '俄'],
];

const NAME = Object.fromEntries(LANGS);

export function langNames(codes) {
  return codes?.length ? codes.map((c) => NAME[c] || c).join(' / ') : '自动识别';
}

// selected: 语言代码数组；onChange(next) 在每次点击后调用。
// 设置页里填过列表外的代码会保留在选中项里（显示为代码本身）。
export function langPicker(selected, onChange, { disabled = false } = {}) {
  let cur = [...(selected || [])];
  const box = el('div', { class: 'lang-picker', title: '会议中可能出现的语言（提示给 Soniox，提高识别准确度）' });
  const extra = cur.filter((c) => !NAME[c]).map((c) => [c, c]);
  for (const [code, name] of [...LANGS, ...extra]) {
    const btn = el('button', { type: 'button', class: cur.includes(code) ? 'on' : '', text: name, 'data-code': code, disabled });
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
