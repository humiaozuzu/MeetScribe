// 说话人改名 / 合并弹窗（历史页和侧边栏共用）。
// 学 Notta：同一个入口，输入名字 = 这个人的所有发言一起改名；选下面已有的人 = 合并为同一个人。

import { el, speakerName } from './common.js';
import { t } from './i18n.js';
import { updateMeeting, getSegments, listMeetings } from '../lib/db.js';
import { buildSpeakerView, renameSpeaker, mergeSpeaker } from '../lib/speakers.js';
import { formatClock } from '../lib/format.js';
import { EVT, broadcast } from '../lib/messages.js';

export const entryLabel = (entry, view) => speakerName({ source: 'them', speakerKey: entry.key }, view);

// 其他会议里用过的名字，作为输入建议
async function knownNames(meetingId) {
  const names = new Set();
  for (const m of await listMeetings()) {
    if (m.id === meetingId) continue;
    for (const v of Object.values(m.speakers || {})) if (v.name) names.add(v.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// 在事务里基于最新的 meeting.speakers 修改，避免和别的页面同时改时互相覆盖
async function applyChange(meetingId, change, log) {
  const segs = await getSegments(meetingId);
  let merged = null;
  const meeting = await updateMeeting(meetingId, (m) => {
    const view = buildSpeakerView(m.speakers, segs);
    if (change.into) {
      m.speakers = mergeSpeaker(m.speakers, change.key, change.into);
      merged = change.into;
    } else {
      const res = renameSpeaker(m.speakers, change.key, change.name, view);
      m.speakers = res.speakers;
      merged = res.merged;
    }
  });
  // 名字是用户数据，日志只记键
  log.info('speaker changed', { meetingId, key: change.key, named: !!change.name?.trim(), merged });
  broadcast({ type: EVT.SPEAKERS, meetingId });
  return meeting;
}

// key：被点击的说话人键；view：当前说话人视图。onChanged(meeting) 在保存后调用。
export async function openSpeakerDialog({ meetingId, key, view, log, onChanged }) {
  const entry = view.byKey.get(key);
  if (!entry) return;
  const label = entryLabel(entry, view);
  const listId = 'spk-names';
  const input = el('input', { type: 'text', value: entry.name || '', placeholder: t('spk.namePlaceholder'), list: listId, autocomplete: 'off' });
  const datalist = el('datalist', { id: listId });
  const err = el('div', { class: 'spk-err' });
  const dlg = el('dialog', { class: 'spk-dialog' });

  const run = async (change) => {
    try {
      const meeting = await applyChange(meetingId, change, log);
      dlg.close();
      onChanged?.(meeting);
    } catch (e) {
      log.error('speaker change failed', { meetingId, key, error: e });
      err.textContent = t('spk.saveFailed', { msg: e.message });
    }
  };

  const others = view.list.filter((e) => e !== entry);
  const form = el('form', { method: 'dialog', onsubmit: (ev) => { ev.preventDefault(); run({ key, name: input.value }); } },
    el('h3', { text: t('spk.dialogTitle', { name: label }) }),
    el('div', { class: 'faint', text: t('spk.talkTime', { d: formatClock(entry.ms) }) }),
    el('label', { class: 'spk-field' }, el('span', { text: t('spk.nameLabel') }), input, datalist),
    el('div', { class: 'faint', text: t('spk.hint') }),
    others.length ? el('div', { class: 'spk-merge' },
      el('div', { class: 'faint', text: t('spk.mergeInto') }),
      el('div', { class: 'spk-chips' }, others.map((o) => el('button', {
        type: 'button', class: 'chip', text: entryLabel(o, view),
        onclick: () => run({ key, into: o.key }),
      })))) : null,
    err,
    el('div', { class: 'spk-actions' },
      entry.name ? el('button', { type: 'button', class: 'link', text: t('spk.clear'), onclick: () => run({ key, name: '' }) }) : null,
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', text: t('spk.cancel'), onclick: () => dlg.close() }),
      el('button', { type: 'submit', class: 'primary', text: t('spk.save') })),
  );
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  input.select();
  knownNames(meetingId).then((names) => {
    datalist.replaceChildren(...names.map((n) => el('option', { value: n })));
  }).catch((e) => log.warn('load known speaker names failed', e));
}
